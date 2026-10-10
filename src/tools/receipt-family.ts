import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { extractReceiptText } from "./receipt-text-extraction.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

// Belegfamilie: Abrechnung, Rechnung und Zahlung eines Falls zusammenführen. Der Fallbezug steht in den Belegen selbst
// (Nummer, die in mehreren Belegen vorkommt). Was sich so nicht zuordnen lässt, wird gemeldet, nicht geraten:
// der Nutzer wird gefragt. Die Zahlung kommt immer aus der tatsächlichen Zuordnung in BHB, nie aus einem Betragsabgleich.

const MAX_RECEIPTS = 30;
const DEFAULT_MAX_FAMILY_SIZE = 4;

export interface FamilyDoc {
  id: number;
  text: string;
}

const TOKEN = /[A-Za-z0-9](?:[A-Za-z0-9\-/_.]*[A-Za-z0-9])?/g;
const DATE = /^(?:\d{1,2}\.\d{1,2}\.\d{2,4}|\d{4}-\d{2}-\d{2})$/;
const AMOUNT = /^\d{1,3}(?:[.,]\d{3})*[.,]\d{2}$|^\d+[.,]\d{2}$/;
const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,}$/;
const VAT_ID = /^[A-Z]{2}\d{8,11}$/;

// Ein Buchstabenpräfix vor der Nummer (Kanzlei: "KR-2026-10001", Käufer: "2026-10001") gehört nicht zur Fallnummer.
const PREFIX = /^[A-Z]{1,5}[-/]?(?=\d)/;

// Nummern, die einen Fall tragen können: mindestens eine Ziffer, mindestens 6 Zeichen (ohne Buchstabenpräfix), kein Datum,
// Betrag, IBAN oder USt-IdNr.
export function candidateKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of text.match(TOKEN) ?? []) {
    const t = raw.replace(/[.\-/_]+$/, "").toUpperCase();
    if (t.length < 6 || !/\d/.test(t)) continue;
    if (DATE.test(t) || AMOUNT.test(t) || IBAN.test(t) || VAT_ID.test(t)) continue;
    const key = t.replace(PREFIX, "");
    if (key.length >= 6) keys.add(key);
  }
  return keys;
}

// Ein Schlüssel zählt nur, wenn er in 2 bis maxFamilySize Belegen vorkommt: eigene Anschrift, USt-IdNr. oder Kundennummer
// stehen in fast allen Belegen und würden sonst alles zu einer Gruppe verbinden.
export function groupByShared(docs: FamilyDoc[], maxFamilySize = DEFAULT_MAX_FAMILY_SIZE) {
  const keysOf = new Map(docs.map((d) => [d.id, candidateKeys(d.text)]));
  const holders = new Map<string, number[]>();
  for (const [id, keys] of keysOf) for (const k of keys) holders.set(k, [...(holders.get(k) ?? []), id]);

  const parent = new Map(docs.map((d) => [d.id, d.id]));
  const find = (x: number): number => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  const usedKeys = new Map<number, Set<string>>();
  for (const [key, ids] of holders) {
    if (ids.length < 2 || ids.length > maxFamilySize) continue;
    for (const id of ids.slice(1)) parent.set(find(id), find(ids[0]));
    for (const id of ids) usedKeys.set(id, (usedKeys.get(id) ?? new Set()).add(key));
  }
  const groups = new Map<number, number[]>();
  for (const d of docs) groups.set(find(d.id), [...(groups.get(find(d.id)) ?? []), d.id]);
  return [...groups.values()].map((ids) => ({
    ids,
    keys: [...new Set(ids.flatMap((id) => [...(usedKeys.get(id) ?? [])]))].sort(),
  }));
}

type Row = Record<string, unknown>;
const round = (n: number) => Math.round(n * 100) / 100;

export function createReceiptFamilyTools(client: BBClient): [ToolDef] {
  const shape = {
    receipt_ids: z
      .array(z.number().int())
      .min(2)
      .max(MAX_RECEIPTS)
      .describe("id_by_customer of the receipts of one or several cases (Abrechnung, Rechnung, ...). The payments are read from BHB."),
    max_family_size: z
      .number()
      .int()
      .min(2)
      .max(10)
      .default(DEFAULT_MAX_FAMILY_SIZE)
      .describe("A shared number only links receipts if it occurs in at most this many of them (own address, VAT id etc. occur in nearly all)."),
  };

  const pairReceiptFamily = defineTool({
    name: "pair_receipt_family",
    description:
      "Group the given receipts into cases (Abrechnung + Rechnung + Zahlung) by a number that appears in the receipt text of at least " +
      "two of them (PDF text layer needed), and list the gaps per case: no payment assigned, receipt without date, payments differ from " +
      "the receipt amount, no text readable. Payments are the transactions actually assigned in BHB (never matched by amount). " +
      "Receipts that share no number with another one are listed under 'unassigned' with the question to put to the user - do not " +
      "guess the pairing. The grouping is a text heuristic: confirm the keys with the user before booking. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: shape,
    async handler(args) {
      const ids = [...new Set(args.receipt_ids)];
      const info = new Map<number, { receipt: Row; text?: string; transactions: Row[] }>();
      for (const id of ids) {
        const res = await client.call<{ data?: Row }>("receiptsGetIdByCustomer", { get_file: true }, { idSuffix: id });
        const raw = ((res.data as { data?: Row } | undefined)?.data ?? res.data ?? {}) as Row;
        const { file_content, file_type, ...receipt } = raw;
        const text =
          file_type === "pdf" && typeof file_content === "string" ? await extractReceiptText(file_content) : undefined;
        const tx = await client.call<{ data?: Row[] }>("receiptsAssignedTransactionsGet", { receipt_id_by_customer: id });
        info.set(id, { receipt, text, transactions: tx.data ?? [] });
      }

      const readable = ids.filter((id) => info.get(id)!.text);
      const grouped = groupByShared(
        readable.map((id) => ({ id, text: info.get(id)!.text! })),
        args.max_family_size
      );
      const txIds = (id: number) => info.get(id)!.transactions.map((t) => String(t.id_by_customer));
      const describe = (id: number, caseIds: number[] = [id]) => {
        const { receipt, transactions } = info.get(id)!;
        const amount = Number(receipt.amount);
        const paid = round(transactions.reduce((a, t) => a + Math.abs(Number(t.amount) || 0), 0));
        const gaps: string[] = [];
        const info_notes: string[] = [];
        if (!receipt.date || String(receipt.date).trim() === "") gaps.push("Beleg ohne Datum");
        if (transactions.length === 0) gaps.push("keine Zahlung zugeordnet");
        else if (Number.isFinite(amount) && Math.abs(paid - Math.abs(amount)) > 0.005) {
          const sharedWith = caseIds.filter((o) => o !== id && txIds(o).some((t) => txIds(id).includes(t)));
          if (paid > Math.abs(amount) + 0.005) {
            // Mehr Zahlung als Beleg ist nie die Drittzahlung. Bei gleich hohen Zahlungen ordnet BHB per Betrag zu und kreuzt.
            gaps.push(
              `Zahlungen ${paid.toFixed(2)} übersteigen den Belegbetrag ${Math.abs(amount).toFixed(2)}: vermutlich falsche Zuordnung bei gleich hohen Zahlungen (${txIds(id).join(", ")}). Mit get_receipt_transactions prüfen, nicht per Betrag raten.`
            );
          } else if (sharedWith.length > 0) {
            info_notes.push(
              `Die Zahlung (${paid.toFixed(2)}) hängt auch an Beleg ${sharedWith.join(", ")} des Falls und weicht vom Belegbetrag ${Math.abs(amount).toFixed(2)} ab: bei Drittzahlung/Kostenübernahme erwartet.`
            );
          } else {
            gaps.push(`Zahlungen ${paid.toFixed(2)} weichen vom Belegbetrag ${Math.abs(amount).toFixed(2)} ab (Sammelzahlung, Skonto, Gebühren?)`);
          }
        }
        return {
          id_by_customer: id,
          type: receipt.type,
          counterparty: receipt.counterparty,
          invoicenumber: receipt.invoicenumber,
          date: receipt.date,
          amount: receipt.amount,
          transactions: transactions.map((t) => ({ id_by_customer: t.id_by_customer, date: t.date, amount: t.amount })),
          ...(gaps.length ? { gaps } : {}),
          ...(info_notes.length ? { hints: info_notes } : {}),
        };
      };

      const cases = grouped.filter((g) => g.ids.length > 1).map((g) => ({
        shared_numbers: g.keys,
        receipts: g.ids.map((id) => describe(id, g.ids)),
        ...(g.ids.length > args.max_family_size ? { note: "Gruppe größer als max_family_size: Schlüssel nicht eindeutig, bitte prüfen." } : {}),
      }));
      const single = grouped.filter((g) => g.ids.length === 1).map((g) => g.ids[0]);
      const unassigned = [
        ...ids.filter((id) => !info.get(id)!.text).map((id) => ({
          ...describe(id),
          reason: "Kein Text lesbar (kein PDF oder Scan ohne Textebene)",
          question: `Zu welchem Fall gehört Beleg ${id}?`,
        })),
        ...single.map((id) => ({
          ...describe(id),
          reason: "Keine Nummer, die in einem anderen der genannten Belege vorkommt",
          question: `Zu welchem Fall gehört Beleg ${id}, oder fehlt der Beleg dazu?`,
        })),
      ];
      return ok({
        cases,
        unassigned,
        notes: [
          "Zuordnung nach Textabgleich: die genannten Nummern (shared_numbers) bestätigen lassen, bevor gebucht wird.",
          "Zahlungen stammen aus der Zuordnung in BHB. Ein Beleg ohne zugeordnete Zahlung kann trotzdem bezahlt sein: dann get_receipt_transactions und die Zahlungen des Kontos prüfen, Betragsmatch nur als 'wahrscheinlich' melden.",
        ],
      });
    },
  });

  return [pairReceiptFamily];
}
