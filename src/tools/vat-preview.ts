import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { getChart } from "./posting-accounts.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

// Schnelle Plausibilisierung vor der Umsatzsteuer-Voranmeldung: Summen der Steuerkonten aus den Kontenblättern. Das ist NICHT
// die ELSTER-Zahl: die USt-VA gibt es nur in der BHB-Oberfläche, hier fehlen Kennziffern der Bemessungsgrundlagen, Sondervorauszahlung,
// Vorjahres-Salden und alles, was BHB selbst verrechnet.

type Side = "vorsteuer" | "umsatzsteuer";
interface TaxAccount {
  skr03: number;
  skr04: number;
  name: string;
  side: Side;
  kz: number;
  b13b?: boolean;
}

// Konten und Kennziffern wie in ustva-mapping.ts (BHB-Artikel 11472964130461).
export const TAX_ACCOUNTS: ReadonlyArray<TaxAccount> = [
  { skr03: 1571, skr04: 1401, name: "Abziehbare Vorsteuer 7%", side: "vorsteuer", kz: 66 },
  { skr03: 1576, skr04: 1406, name: "Abziehbare Vorsteuer 19%", side: "vorsteuer", kz: 66 },
  { skr03: 1577, skr04: 1407, name: "Abziehbare Vorsteuer § 13b UStG 19%", side: "vorsteuer", kz: 67, b13b: true },
  { skr03: 1771, skr04: 3801, name: "Umsatzsteuer 7%", side: "umsatzsteuer", kz: 86 },
  { skr03: 1776, skr04: 3806, name: "Umsatzsteuer 19%", side: "umsatzsteuer", kz: 81 },
  { skr03: 1787, skr04: 3837, name: "Umsatzsteuer nach § 13b UStG mit VSt-Abzug 19%", side: "umsatzsteuer", kz: 46, b13b: true },
];

const round = (n: number) => Math.round(n * 100) / 100;

export function sumLedger(rows: Array<Record<string, unknown>>) {
  let debit = 0;
  let credit = 0;
  for (const r of rows) {
    const amount = Math.abs(Number(r.record_amount) || 0);
    if (r.record_side === "debit") debit += amount;
    else if (r.record_side === "credit") credit += amount;
  }
  return { debit: round(debit), credit: round(credit), rows: rows.length };
}

export function createVatPreviewTools(client: BBClient): [ToolDef] {
  const shape = {
    date_from: z.string().describe("YYYY-MM-DD, e.g. 2026-07-01 for Q3."),
    date_to: z.string().describe("YYYY-MM-DD, e.g. 2026-09-30 for Q3."),
    base: z
      .enum(["date", "date_delivery_else_date"])
      .default("date_delivery_else_date")
      .describe("date_delivery_else_date follows the Leistungsdatum like the USt-Voranmeldung (default); date = Buchungsdatum."),
    chart: z.enum(["SKR03", "SKR04"]).optional().describe("Kontenrahmen; detected when omitted (SKR03 only), otherwise required."),
  };

  const previewVatImpact = defineTool({
    name: "preview_vat_impact",
    description:
      "Quick plausibility check before the Umsatzsteuer-Voranmeldung: sums Vorsteuer and Umsatzsteuer accounts (SKR03 1571/1576/1577, 1771/1776/1787, " +
      "SKR04 1401/1406/1407, 3801/3806/3837) from their Kontenblätter for the period and shows the resulting Zahllast/Erstattung with the " +
      "Kennziffern. NOT the ELSTER figure: the real USt-VA exists only in the BHB UI; Bemessungsgrundlagen, Sondervorauszahlung, " +
      "Vorjahres-Salden and Dauerfristverlängerung are not included. Compare with the draft in the UI before submitting. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: shape,
    async handler(args) {
      let chart = args.chart;
      if (!chart) {
        const detected = await getChart(client).catch(() => "unknown" as const);
        if (detected !== "SKR03") {
          throw new Error("Kontenrahmen nicht erkannt (nur SKR03 wird automatisch erkannt). chart: \"SKR03\" oder \"SKR04\" angeben.");
        }
        chart = "SKR03";
      }
      const accounts: Array<{ account: number; name: string; side: Side; kennziffer: number; amount: number; debit: number; credit: number; rows: number }> = [];
      for (const acc of TAX_ACCOUNTS) {
        const number = chart === "SKR03" ? acc.skr03 : acc.skr04;
        const res = await client.call<{ report_sums_postingaccount_ledger?: { postingaccountLedger?: Array<Record<string, unknown>> } }>(
          "reportsGetSumsLedger",
          { postingaccount_number: number, date_from: args.date_from, date_to: args.date_to, base: args.base }
        );
        const sums = sumLedger(res.report_sums_postingaccount_ledger?.postingaccountLedger ?? []);
        // Vorsteuer wächst im Soll, Umsatzsteuer im Haben; Storno/Korrektur steht auf der Gegenseite.
        const amount = acc.side === "vorsteuer" ? round(sums.debit - sums.credit) : round(sums.credit - sums.debit);
        accounts.push({ account: number, name: acc.name, side: acc.side, kennziffer: acc.kz, amount, ...sums });
      }
      const total = (side: Side) => round(accounts.filter((a) => a.side === side).reduce((s, a) => s + a.amount, 0));
      const vorsteuer = total("vorsteuer");
      const umsatzsteuer = total("umsatzsteuer");
      const zahllast = round(umsatzsteuer - vorsteuer);
      return ok({
        period: { date_from: args.date_from, date_to: args.date_to, base: args.base },
        chart,
        accounts,
        umsatzsteuer,
        vorsteuer,
        zahllast_oder_erstattung: zahllast,
        result: zahllast >= 0 ? "Zahllast" : "Erstattung",
        notes: [
          "Nicht die ELSTER-Zahl: USt-VA-Entwurf in der BHB-Oberfläche gegenprüfen.",
          "§ 13b: Umsatzsteuer und Vorsteuer heben sich in der Zahllast auf. Welche Kennziffern BHB für 19_both_511 ausgibt (EU oder Drittland), ist nicht bestätigt: im Entwurf prüfen (get_booking_guide reverse_charge_drittland).",
          "Bei Ist-Versteuerung zählt der Zahlungszeitpunkt. Die Kontenblätter zeigen, was BHB für den Zeitraum auswertet; die Besteuerungsart, die für den Zeitraum galt, darf nicht nachträglich gewechselt worden sein.",
          "Steuerkonten aus Buchungen mit abweichendem Leistungsdatum fallen je nach base in andere Perioden: base: \"date\" zum Vergleich.",
        ],
      });
    },
  });

  return [previewVatImpact];
}
