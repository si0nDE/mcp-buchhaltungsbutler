import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

// Monatsabschluss-Checkliste aus BHBs Best-Practice-Artikel "Schritte, um die Buchhaltung am Monatsende fertigzustellen",
// soweit sie sich aus den API-Daten ableiten lässt. Read-only. Die API liefert an Belegen und Zahlungen keinen Buchungs-
// status; "gebucht" wird deshalb aus den Buchungen abgeleitet (Abgleich über receipt_id_by_customer/transaction_id_by_customer).
// Das ist eine Näherung und wird in der Antwort so benannt. Was die API nicht hergibt (Bankstand, Festschreiben, USt-VA),
// steht als "nicht_pruefbar" in der Liste, damit niemand eine Prüfung für erledigt hält, die nie lief.

type Row = Record<string, unknown>;

const PAGE = { receipts: 500, transactions: 500, postings: 1000, accounts: 1000 } as const;
const MAX_PAGES = 10;
const DETAIL_CAP = 50;

interface Paged {
  rows: Row[];
  truncated: boolean;
}

async function readAll(
  client: BBClient,
  key: "receiptsGet" | "transactionsGet" | "postingsGet" | "settingsGetPostingaccounts",
  params: Record<string, unknown>,
  pageSize: number
): Promise<Paged> {
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.call<{ data?: Row[] }>(key, { ...params, limit: pageSize, offset: page * pageSize });
    const data = res.data ?? [];
    rows.push(...data);
    if (data.length < pageSize) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const cents = (v: unknown) => Math.round(Number(v) * 100);
const idOf = (v: unknown) => Number(v);

export interface DuplicateGroup {
  grund: string;
  ids: number[];
  counterparty: string;
  invoicenumber?: string;
  amounts: string[];
  date?: string;
}

// Gleicher Rechnungssteller + gleiche Rechnungsnummer, oder (ohne Rechnungsnummer) gleicher Rechnungssteller, Datum und
// Betrag. Ein Verdacht, kein Beweis: Korrekturrechnungen tragen oft dieselbe Nummer.
export function findDuplicateReceipts(receipts: Row[]): DuplicateGroup[] {
  const byNumber = new Map<string, Row[]>();
  const byDateAmount = new Map<string, Row[]>();
  for (const r of receipts) {
    const cp = norm(r.counterparty);
    if (!cp) continue;
    const inv = norm(r.invoicenumber);
    const bucket = inv
      ? { map: byNumber, key: `${r.type ?? ""}|${cp}|${inv}` }
      : { map: byDateAmount, key: `${r.type ?? ""}|${cp}|${norm(r.date)}|${cents(r.amount)}` };
    bucket.map.set(bucket.key, [...(bucket.map.get(bucket.key) ?? []), r]);
  }
  const groups: DuplicateGroup[] = [];
  for (const rows of byNumber.values()) {
    if (rows.length > 1) {
      groups.push({
        grund: "gleicher Rechnungssteller und gleiche Rechnungsnummer",
        ids: rows.map((r) => idOf(r.id_by_customer)),
        counterparty: String(rows[0].counterparty),
        invoicenumber: String(rows[0].invoicenumber),
        amounts: rows.map((r) => String(r.amount)),
      });
    }
  }
  for (const rows of byDateAmount.values()) {
    if (rows.length > 1) {
      groups.push({
        grund: "gleicher Rechnungssteller, gleiches Datum, gleicher Betrag (ohne Rechnungsnummer)",
        ids: rows.map((r) => idOf(r.id_by_customer)),
        counterparty: String(rows[0].counterparty),
        amounts: rows.map((r) => String(r.amount)),
        date: String(rows[0].date),
      });
    }
  }
  return groups;
}

function splitIds(v: unknown): number[] {
  return String(v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "")
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

export function bookedReceiptIds(postings: Row[]): Set<number> {
  const ids = new Set<number>();
  for (const p of postings) {
    if (String(p.receipt_id_by_customer ?? "").trim() !== "") ids.add(idOf(p.receipt_id_by_customer));
    for (const id of splitIds(p.receipts_assigned_ids_by_customer)) ids.add(id);
  }
  return ids;
}

export function bookedTransactionIds(postings: Row[]): Set<number> {
  const ids = new Set<number>();
  for (const p of postings) {
    if (String(p.transaction_id_by_customer ?? "").trim() !== "") ids.add(idOf(p.transaction_id_by_customer));
  }
  return ids;
}

// Saldo = Soll minus Haben über die gelesenen Buchungen, in Cent gerechnet.
export function accountBalance(postings: Row[], account: number): number {
  let sum = 0;
  for (const p of postings) {
    const c = cents(p.amount);
    if (idOf(p.debit_postingaccount_number) === account) sum += c;
    if (idOf(p.credit_postingaccount_number) === account) sum -= c;
  }
  return sum / 100;
}

export function findTransitAccounts(accounts: Row[]): Array<{ number: number; name: string }> {
  return accounts
    .filter((a) => /^(geldtransit|interimskonto)/i.test(String(a.name ?? "").trim()))
    .map((a) => ({ number: idOf(a.postingaccount_number), name: String(a.name) }));
}

type Status = "ok" | "pruefen" | "nicht_pruefbar";
interface Result {
  pruefung: string;
  status: Status;
  anzahl?: number;
  details?: unknown;
  hinweis?: string;
}

const cap = <T>(rows: T[]) => rows.slice(0, DETAIL_CAP);

export function createMonthEndTools(client: BBClient): [ToolDef, ToolDef] {
  const checkMonthEnd = defineTool({
    name: "check_month_end",
    description:
      "Read-only Monatsabschluss-Prüfung nach BHBs Best Practice, soweit aus API-Daten ableitbar: (1) Duplikatsverdacht bei " +
      "Belegen, (2) Zahlungen ohne Buchung, (3) Belege ohne Buchung, (4) nicht festgeschriebene Buchungen, (5) Saldo von " +
      "Geldtransit und Interimskonto (muss 0 sein). Nicht über die API prüfbar und deshalb als nicht_pruefbar gelistet: " +
      "Banksalden, Plausibilisierung der Konten, Festschreiben und USt-Voranmeldung (nur in der Oberfläche unter Abschluss). " +
      "'Gebucht' wird aus den Buchungen im Zeitraum abgeleitet (die API gibt keinen Buchungsstatus an Belegen/Zahlungen): " +
      "das ist eine Näherung und liefert Prüfhinweise, keine Gewissheit - ein Beleg, dessen Zahlung nur gegen ein " +
      "Debitoren-/Kreditorenkonto gebucht ist, gilt in BuchhaltungsButler weiter als ungebucht. Für den Geldtransit-Saldo " +
      "balance_from auf den Beginn des Wirtschaftsjahres setzen, sonst zählt nur der Zeitraum. Liest viele Seiten (bis " +
      "10 je Abfrage); bei Überschreitung steht 'unvollstaendig' in der Antwort. Löscht oder ändert nichts.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      date_from: z.string().describe("YYYY-MM-DD, Beginn des zu prüfenden Zeitraums (z. B. Monatsanfang)."),
      date_to: z.string().describe("YYYY-MM-DD, Ende des Zeitraums."),
      balance_from: z
        .string()
        .optional()
        .describe("YYYY-MM-DD: Beginn für den Saldo von Geldtransit/Interimskonto (Standard: date_from). Wirtschaftsjahresbeginn nehmen."),
    },
    async handler(args) {
      const range = { date_from: args.date_from, date_to: args.date_to };
      const unvollstaendig: string[] = [];
      const note = (label: string, p: Paged) => {
        if (p.truncated) unvollstaendig.push(label);
      };

      const [inbound, outbound, transactions, postings, accounts] = await Promise.all([
        readAll(client, "receiptsGet", { ...range, list_direction: "inbound", deleted: false }, PAGE.receipts),
        readAll(client, "receiptsGet", { ...range, list_direction: "outbound", deleted: false }, PAGE.receipts),
        readAll(client, "transactionsGet", range, PAGE.transactions),
        readAll(client, "postingsGet", { ...range, posting_status: "all" }, PAGE.postings),
        readAll(client, "settingsGetPostingaccounts", {}, PAGE.accounts),
      ]);
      note("Eingangsbelege", inbound);
      note("Ausgangsrechnungen", outbound);
      note("Zahlungen", transactions);
      note("Buchungen", postings);
      note("Buchungskonten", accounts);

      const receipts = [...inbound.rows, ...outbound.rows];
      const results: Result[] = [];

      const dups = findDuplicateReceipts(receipts);
      results.push({
        pruefung: "duplikatsverdacht_belege",
        status: dups.length === 0 ? "ok" : "pruefen",
        anzahl: dups.length,
        ...(dups.length > 0 ? { details: cap(dups) } : {}),
        hinweis:
          "Vor dem Löschen prüfen, ob es wirklich Duplikate sind (Rechnungskorrekturen tragen oft dieselbe Nummer). Zum Löschen set_receipt_deleted.",
      });

      const bookedTx = bookedTransactionIds(postings.rows);
      const openTx = transactions.rows.filter((t) => !bookedTx.has(idOf(t.id_by_customer)));
      results.push({
        pruefung: "zahlungen_ohne_buchung",
        status: openTx.length === 0 ? "ok" : "pruefen",
        anzahl: openTx.length,
        ...(openTx.length > 0
          ? {
              details: cap(openTx).map((t) => ({
                id_by_customer: t.id_by_customer,
                to_from: t.to_from,
                amount: t.amount,
                booking_date: t.booking_date,
              })),
            }
          : {}),
        hinweis: "Alle Konten gemeinsam geprüft. Buchungen mit anderem Datum als die Zahlung werden hier nicht erkannt.",
      });

      const bookedReceipts = bookedReceiptIds(postings.rows);
      const openReceipts = receipts.filter((r) => !bookedReceipts.has(idOf(r.id_by_customer)));
      results.push({
        pruefung: "belege_ohne_buchung",
        status: openReceipts.length === 0 ? "ok" : "pruefen",
        anzahl: openReceipts.length,
        ...(openReceipts.length > 0
          ? {
              details: cap(openReceipts).map((r) => ({
                id_by_customer: r.id_by_customer,
                type: r.type,
                counterparty: r.counterparty,
                invoicenumber: r.invoicenumber,
                amount: r.amount,
                date: r.date,
              })),
            }
          : {}),
        hinweis:
          "Bilanzierer: ungebuchte Eingangsrechnungen kreditorisch als offene Posten einbuchen. EÜR-Rechner buchen nur Zahlungen; dort ist ein unbezahlter Beleg ohne Buchung normal.",
      });

      const unfixed = postings.rows.filter((p) => String(p.fixed ?? "0") === "0").length;
      results.push({
        pruefung: "festschreibung",
        status: unfixed === 0 ? "ok" : "pruefen",
        anzahl: unfixed,
        details: { festgeschrieben: postings.rows.length - unfixed, nicht_festgeschrieben: unfixed },
        hinweis: "Festschreiben geht nur in der Oberfläche (Abschluss, Zeitraum einstellen), nicht per API. Danach erst die USt-Voranmeldung.",
      });

      const transit = findTransitAccounts(accounts.rows);
      if (transit.length === 0) {
        results.push({
          pruefung: "geldtransit_und_interimskonto_saldo",
          status: "nicht_pruefbar",
          hinweis: "Kein Konto 'Geldtransit' oder 'Interimskonto' im Kontenplan gefunden.",
        });
      } else {
        const balanceRange = { date_from: args.balance_from ?? args.date_from, date_to: args.date_to };
        const wide =
          balanceRange.date_from === args.date_from
            ? postings
            : await readAll(client, "postingsGet", { ...balanceRange, posting_status: "all" }, PAGE.postings);
        if (wide !== postings) note("Buchungen (Saldo-Zeitraum)", wide);
        const saldi = transit.map((a) => ({ konto: a.number, name: a.name, saldo: accountBalance(wide.rows, a.number) }));
        const off = saldi.filter((s) => Math.abs(s.saldo) >= 0.005);
        results.push({
          pruefung: "geldtransit_und_interimskonto_saldo",
          status: off.length === 0 ? "ok" : "pruefen",
          anzahl: off.length,
          details: saldi,
          hinweis:
            `Saldo = Soll minus Haben im Zeitraum ${balanceRange.date_from} bis ${balanceRange.date_to}. Beide Konten müssen 0 sein; ` +
            "sonst fehlt eine Gegenbuchung (siehe get_booking_guide geldtransit).",
        });
      }

      results.push(
        {
          pruefung: "banksalden",
          status: "nicht_pruefbar",
          hinweis:
            "Kontostand je Zahlungskonto mit calculate_account_balance (statement_balance = Saldo laut Kontoauszug) abstimmen; Anfangsbestand muss erfasst sein.",
        },
        {
          pruefung: "plausibilisierung_konten",
          status: "nicht_pruefbar",
          hinweis:
            "Soll/Haben-Seite, Anzahl wiederkehrender Zahlungen, Kontierung, Buchungen mit/ohne Steuer: get_report (sums) und get_account_ledger.",
        },
        {
          pruefung: "festschreiben_und_ust_voranmeldung",
          status: "nicht_pruefbar",
          hinweis: "Nur in der Oberfläche (Abschluss). Kein API-Endpunkt.",
        }
      );

      return ok({
        zeitraum: range,
        ergebnisse: results,
        ...(unvollstaendig.length > 0
          ? {
              unvollstaendig,
              warnung: `Seitenlimit erreicht (${MAX_PAGES} Seiten): ${unvollstaendig.join(", ")}. Zeitraum verkleinern, sonst sind die Ergebnisse unvollständig.`,
            }
          : {}),
        hinweis:
          "'ok' heißt nur: kein Auffälliges in den abgerufenen Daten. Gebucht wird aus den Buchungen abgeleitet (Näherung).",
      });
    },
  });
  const calculateAccountBalance = defineTool({
    name: "calculate_account_balance",
    description:
      "Kontostand eines Zahlungskontos zu einem Stichtag berechnen - wie 'Kontostand berechnen' unter Abschluss: Summe aller " +
      "Zahlungen des Kontos bis date_to (einschließlich des als Zahlung erfassten Anfangsbestands). Zum Abgleich mit dem " +
      "Kontoauszug: optional statement_balance (Saldo laut Bank) angeben, dann kommt die Differenz. Ohne eingetragenen " +
      "Anfangsbestand stimmt nur die Kontoveränderung, nicht der Stand (siehe create_transactions). Währungen werden nicht " +
      "umgerechnet: Zahlungen in Fremdwährung fließen mit dem Fremdwährungsbetrag ein, das erklärt oft eine Abweichung. Die " +
      "Berechnung ist unabhängig davon, ob Zahlungen verbucht sind (anders als die Summen- und Saldenliste, die ungebuchte " +
      "Zahlungen nicht berücksichtigt). Bei angebundenen Bank-/Kreditkartenkonten zeigt die Oberfläche in 'Zahlungen' den von " +
      "der Bank gemeldeten Stand, nicht diesen berechneten. Liest bis zu 10 Seiten à 500 Zahlungen; bei Überschreitung " +
      "warnt die Antwort, dann date_from setzen und einen Anfangsstand dazurechnen. Ändert nichts.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      account: z.number().int().describe("Buchungskontonummer des Zahlungskontos (siehe list_accounts)."),
      date_to: z.string().describe("YYYY-MM-DD, Stichtag (einschließlich)."),
      date_from: z.string().optional().describe("YYYY-MM-DD, nur setzen, wenn der Anfangsbestand nicht vor diesem Datum liegt."),
      statement_balance: z.number().optional().describe("Kontostand laut Kontoauszug zum Stichtag (Euro), für die Differenz."),
    },
    async handler(args) {
      const { rows, truncated } = await readAll(
        client,
        "transactionsGet",
        { account: args.account, date_to: args.date_to, ...(args.date_from ? { date_from: args.date_from } : {}) },
        PAGE.transactions
      );
      const sum = rows.reduce((s, t) => s + cents(t.amount), 0) / 100;
      const berechnet = Math.round(sum * 100) / 100;
      return ok({
        konto: args.account,
        stichtag: args.date_to,
        berechneter_kontostand: berechnet,
        anzahl_zahlungen: rows.length,
        ...(args.statement_balance !== undefined
          ? {
              kontoauszug: args.statement_balance,
              differenz: Math.round((args.statement_balance - berechnet) * 100) / 100,
              hinweis:
                Math.abs(args.statement_balance - berechnet) < 0.005
                  ? "Stimmt überein."
                  : "Abweichung: fehlende oder doppelte Zahlungen, fehlender Anfangsbestand oder Fremdwährung prüfen (get_booking_guide zahlungen_probleme).",
            }
          : {}),
        ...(truncated
          ? { warnung: `Seitenlimit erreicht (${MAX_PAGES} Seiten): der Kontostand ist unvollständig. date_from setzen und den Stand davor ergänzen.` }
          : {}),
      });
    },
  });

  return [checkMonthEnd, calculateAccountBalance];
}
