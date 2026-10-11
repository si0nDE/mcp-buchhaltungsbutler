import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { receiptDisplayRef } from "../formatting/display-ref.js";
import { extractDateCandidates } from "./bewirtung-plausibility.js";
import { countPdfPages, extractReceiptText } from "./receipt-text-extraction.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

// Sammelprüfung eines USt-Zeitraums: ersetzt die Einzelaufrufe (Belege, Buchungen, Belegtext) durch eine Tabelle mit Befunden.
// Nur objektive Muster, die sich aus Belegliste und Buchungen ergeben. Rechtsfragen (Auslandsanbieter mit deutscher USt,
// Leistungsort) und Befunde, die den Belegtext brauchen (Steuersätze auf Bons, Rechnungsnummer im Text), sind noch nicht
// umgesetzt und stehen in `not_checked`. Das Tool ändert nichts.

type Row = Record<string, unknown>;
export type AuditCheck = "DUP_POSTING" | "DUP_RECEIPT" | "UNBOOKED" | "DATE_SHIFT" | "NO_TEXT_LAYER";
export const AUDIT_CHECKS: readonly AuditCheck[] = ["DUP_POSTING", "DUP_RECEIPT", "UNBOOKED", "DATE_SHIFT", "NO_TEXT_LAYER"];

export interface Finding {
  check: AuditCheck;
  severity: "error" | "warning" | "info";
  display_ref: string;
  receipt_id?: string;
  posting_ids?: string[];
  fact: string;
  auto_fixable: false;
  fix_via: "decision" | "ui";
  vat_effect?: Record<string, number | string>;
}

const round = (n: number) => Math.round(n * 100) / 100;
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const num = (v: unknown) => Number(str(v).replace(",", "."));
const day = (v: unknown) => str(v).slice(0, 10);
const isDeleted = (r: Row) => ["1", "true"].includes(str(r.deleted).toLowerCase());
const isInbound = (r: Row) => str(r.type).includes("inbound") || str(r.list_direction) === "inbound";

function quarterOf(date: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(date);
  return m ? `${m[1]}-Q${Math.ceil(Number(m[2]) / 3)}` : "";
}

function postingReceiptIds(p: Row): string[] {
  return [p.receipt_id_by_customer, ...str(p.receipts_assigned_ids_by_customer).split(",")].map(str).filter((x) => x !== "");
}

// Steuerwirksam: Steuerschlüssel gesetzt und nicht 0. Automatikkonten (z. B. 8400 mit Schlüssel 0 und vat 19) zählen bewusst nicht.
const taxEffective = (p: Row) => str(p.tax_key) !== "" && str(p.tax_key) !== "0";

export function analyzeReceiptsAndPostings(
  receipts: Row[],
  postings: Row[],
  checks: readonly AuditCheck[]
): { findings: Finding[]; checkedReceipts: number } {
  const findings: Finding[] = [];
  const live = receipts.filter((r) => !isDeleted(r));
  const byReceipt = new Map<string, Row[]>();
  for (const p of postings) {
    for (const id of new Set(postingReceiptIds(p))) {
      const list = byReceipt.get(id) ?? [];
      list.push(p);
      byReceipt.set(id, list);
    }
  }

  if (checks.includes("DUP_POSTING")) {
    for (const r of live) {
      const id = str(r.id_by_customer);
      const amount = Math.abs(num(r.amount));
      const taxed = (byReceipt.get(id) ?? []).filter(taxEffective);
      if (!Number.isFinite(amount) || amount === 0 || taxed.length < 2) continue;
      const sum = round(taxed.reduce((s, p) => s + Math.abs(num(p.amount)), 0));
      if (sum <= amount + 0.01) continue;
      const excess = round(sum - amount);
      const rate = num(taxed[0].vat);
      const vat = rate >= 1 && rate <= 30 ? round((excess * rate) / (100 + rate)) : undefined;
      findings.push({
        check: "DUP_POSTING",
        severity: "error",
        display_ref: receiptDisplayRef(r),
        receipt_id: id,
        posting_ids: taxed.map((p) => str(p.id_by_customer)),
        fact: `${taxed.length} steuerwirksame Buchungen über zusammen ${sum.toFixed(2)} € auf einen Beleg über ${amount.toFixed(2)} € (Überschuss ${excess.toFixed(2)} €). Mögliche Doppelbuchung, z. B. Belegbuchung plus freie Buchung.`,
        auto_fixable: false,
        fix_via: "decision",
        ...(vat !== undefined
          ? {
              vat_effect: isInbound(r)
                ? { vorsteuer_zu_viel: vat, kz: 66, zahllast_delta_bei_korrektur: vat }
                : { umsatzsteuer_zu_viel: vat, zahllast_delta_bei_korrektur: -vat },
            }
          : {}),
      });
    }
  }

  if (checks.includes("DUP_RECEIPT")) {
    const seen = new Map<string, Row>();
    const seenAmount: Row[] = [];
    for (const r of live) {
      const cp = str(r.counterparty).toLowerCase();
      const inv = str(r.invoicenumber);
      if (cp && inv) {
        const key = `${isInbound(r)}|${cp}|${inv.replace(/\s+/g, "")}`;
        const first = seen.get(key);
        if (first) {
          findings.push({
            check: "DUP_RECEIPT",
            severity: "error",
            display_ref: receiptDisplayRef(r),
            receipt_id: str(r.id_by_customer),
            fact: `Gleiche Rechnungsnummer und Gegenpartei wie ${receiptDisplayRef(first)} (Beleg #${str(first.id_by_customer)}). Doppelter Upload?`,
            auto_fixable: false,
            fix_via: "decision",
          });
          continue;
        }
        seen.set(key, r);
      }
      const t = Date.parse(day(r.date));
      const dup = seenAmount.find(
        (o) =>
          isInbound(o) === isInbound(r) &&
          str(o.counterparty).toLowerCase() === cp &&
          cp !== "" &&
          Math.abs(num(o.amount) - num(r.amount)) < 0.005 &&
          Math.abs(Date.parse(day(o.date)) - t) <= 3 * 86400000
      );
      if (dup) {
        findings.push({
          check: "DUP_RECEIPT",
          severity: "warning",
          display_ref: receiptDisplayRef(r),
          receipt_id: str(r.id_by_customer),
          fact: `Gleicher Betrag, gleiche Gegenpartei, Datum höchstens 3 Tage Abstand wie ${receiptDisplayRef(dup)} (Beleg #${str(dup.id_by_customer)}). Rechnung und Quittung zur selben Zahlung?`,
          auto_fixable: false,
          fix_via: "decision",
        });
      }
      seenAmount.push(r);
    }
  }

  if (checks.includes("UNBOOKED")) {
    for (const r of live) {
      if ((byReceipt.get(str(r.id_by_customer)) ?? []).length > 0) continue;
      findings.push({
        check: "UNBOOKED",
        severity: "warning",
        display_ref: receiptDisplayRef(r),
        receipt_id: str(r.id_by_customer),
        fact: "Keine Buchung mit diesem Beleg im Zeitraum gefunden (weder Belegbuchung noch Zahlungsbuchung mit Zuordnung). Buchungen mit Datum außerhalb des Zeitraums sind nicht berücksichtigt.",
        auto_fixable: false,
        fix_via: "decision",
      });
    }
  }

  return { findings, checkedReceipts: live.length };
}

async function sweep(client: BBClient, key: "receiptsGet" | "postingsGet", base: Row, pageSize: number, maxPages: number): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await client.call<{ data?: Row[] }>(key, { ...base, limit: pageSize, offset: page * pageSize });
    const batch = res.data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function createVatAuditTools(client: BBClient): [ToolDef] {
  const shape = {
    date_from: z.string().describe("YYYY-MM-DD, e.g. 2026-07-01."),
    date_to: z.string().describe("YYYY-MM-DD, e.g. 2026-09-30."),
    checks: z.array(z.enum(AUDIT_CHECKS as unknown as [AuditCheck, ...AuditCheck[]])).optional().describe("Default: all implemented checks."),
    read_receipt_text: z
      .boolean()
      .default(false)
      .describe("Also read the PDF text of up to max_text_reads receipts (DATE_SHIFT, NO_TEXT_LAYER). Slower: one file call per receipt."),
    max_text_reads: z.number().int().min(1).max(60).default(25),
    max_findings: z.number().int().min(1).max(500).default(200),
  };

  const auditVatPeriod = defineTool({
    name: "audit_vat_period",
    description:
      "One call instead of dozens for a quarter check before the USt-Voranmeldung: loads receipts (receipt date in the period) and postings (date or " +
      "date_vat_effective in the period) and reports findings as a table. Implemented, objective patterns only: DUP_POSTING (several tax-effective postings " +
      "on one receipt sum up to more than its amount, e.g. receipt posting plus free posting), DUP_RECEIPT (same invoice number and counterparty, or same " +
      "amount/counterparty within 3 days), UNBOOKED (no posting references the receipt), and with read_receipt_text: DATE_SHIFT (no date in the text in the " +
      "receipt's quarter, but one in another quarter) and NO_TEXT_LAYER. Every finding has display_ref (name receipts to the user by it) and, if computable, " +
      "vat_effect. NOT implemented, listed in not_checked: tax rates on a receipt vs. postings, invoice number in the text, foreign suppliers and reverse " +
      "charge (legal questions, never auto-fix), event location. Nothing is changed; findings are leads to verify, never an approval. Receipts dated outside " +
      "the period but delivered inside it are not loaded. Compare the Zahllast with preview_vat_impact (elster_estimate).",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: shape,
    async handler(args) {
      const checks = args.checks && args.checks.length > 0 ? args.checks : AUDIT_CHECKS;
      const [inbound, outbound, posts] = await Promise.all([
        sweep(client, "receiptsGet", { list_direction: "inbound", date_from: args.date_from, date_to: args.date_to }, 500, 10),
        sweep(client, "receiptsGet", { list_direction: "outbound", date_from: args.date_from, date_to: args.date_to }, 500, 10),
        sweep(client, "postingsGet", { date_from: args.date_from, date_to: addDays(args.date_to, 31), posting_status: "all" }, 1000, 10),
      ]);
      const receipts: Row[] = [
        ...inbound.rows.map((r) => ({ ...r, list_direction: "inbound" })),
        ...outbound.rows.map((r) => ({ ...r, list_direction: "outbound" })),
      ];
      const inPeriod = (d: string) => d !== "" && d >= args.date_from && d <= args.date_to;
      const postings = posts.rows.filter((p) => inPeriod(day(p.date)) || inPeriod(day(p.date_vat_effective)));

      const { findings, checkedReceipts } = analyzeReceiptsAndPostings(receipts, postings, checks);
      const notes: string[] = [];

      if (args.read_receipt_text && (checks.includes("DATE_SHIFT") || checks.includes("NO_TEXT_LAYER"))) {
        const candidates = receipts.filter((r) => !isDeleted(r)).slice(0, args.max_text_reads);
        if (receipts.filter((r) => !isDeleted(r)).length > candidates.length) {
          notes.push(`Belegtext nur für die ersten ${candidates.length} Belege gelesen (max_text_reads); Rest ungeprüft.`);
        }
        for (const r of candidates) {
          try {
            const res = await client.call<{ data?: Row }>("receiptsGetIdByCustomer", { get_file: true }, { idSuffix: Number(r.id_by_customer) });
            const content = str(res.data?.file_content);
            if (res.data?.file_type !== "pdf" || content === "") continue;
            const text = await extractReceiptText(content);
            if (text === undefined) {
              if (checks.includes("NO_TEXT_LAYER")) {
                const pages = await countPdfPages(content);
                findings.push({
                  check: "NO_TEXT_LAYER",
                  severity: "info",
                  display_ref: receiptDisplayRef(r),
                  receipt_id: str(r.id_by_customer),
                  fact: `Kein Text im PDF${pages ? ` (${pages} Seite${pages > 1 ? "n" : ""})`: ""}: Beleg nur manuell prüfbar.`,
                  auto_fixable: false,
                  fix_via: "ui",
                });
              }
              continue;
            }
            if (!checks.includes("DATE_SHIFT")) continue;
            const q = quarterOf(day(r.date));
            const dates = extractDateCandidates(text);
            if (dates.length > 0 && q !== "" && !dates.some((d) => quarterOf(d) === q) && dates.some((d) => quarterOf(d) !== q)) {
              findings.push({
                check: "DATE_SHIFT",
                severity: "warning",
                display_ref: receiptDisplayRef(r),
                receipt_id: str(r.id_by_customer),
                fact: `Belegdatum ${day(r.date)} (${q}), im Text aber nur ${dates.join(", ")}. Rechnungs- oder Leistungsdatum in anderem Quartal? Beleg ansehen, dann Datum in der BHB-Oberfläche korrigieren (per API nicht änderbar).`,
                auto_fixable: false,
                fix_via: "ui",
              });
            }
          } catch {
            notes.push(`Beleg ${str(r.id_by_customer)}: Datei nicht lesbar, Text nicht geprüft.`);
          }
        }
      } else if (checks.includes("DATE_SHIFT") || checks.includes("NO_TEXT_LAYER")) {
        notes.push("DATE_SHIFT und NO_TEXT_LAYER nicht geprüft: read_receipt_text: true setzen.");
      }
      if (inbound.truncated || outbound.truncated || posts.truncated) {
        notes.push("Abruf nach 10 Seiten abgebrochen: Zeitraum verkleinern, sonst fehlen Belege oder Buchungen (dann sind UNBOOKED/DUP_POSTING unzuverlässig).");
      }

      const order = { error: 0, warning: 1, info: 2 } as const;
      findings.sort((a, b) => order[a.severity] - order[b.severity]);
      const counts: Record<string, number> = {};
      for (const f of findings) counts[f.check] = (counts[f.check] ?? 0) + 1;
      const shown = findings.slice(0, args.max_findings);

      return ok({
        period: { date_from: args.date_from, date_to: args.date_to },
        checked: { receipts: checkedReceipts, postings: postings.length, checks },
        counts,
        findings: shown,
        ...(findings.length > shown.length ? { findings_cut: findings.length - shown.length } : {}),
        not_checked: [
          "Steuersätze laut Beleg gegen gebuchte Aufteilung (Bons mit Mischsätzen)",
          "Rechnungsnummer im Belegtext (Stripe-Quittung gegen Rechnung)",
          "Auslandsanbieter mit deutscher USt oder Reverse-Charge-Hinweis (Rechtsfrage, Hausregel nötig)",
          "Leistungsort bei Veranstaltungen im Ausland",
          "Zeitraumverschiebung durch Ist-Versteuerung (USt-Konten bilden die Zahlung bereits ab, siehe docs/buchungen-korrigieren-faq.md)",
        ],
        notes,
      });
    },
  });

  return [auditVatPeriod];
}
