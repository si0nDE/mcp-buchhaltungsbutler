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

// ELSTER rundet die Bemessungsgrundlagen (Kz 81, 86, 46) auf volle Euro ab und rechnet die Steuer daraus; die Kontensummen enthalten
// die Steuer aus den ungerundeten Beträgen (Beispiel: Kz 81 8.065,88 → 8.065, 19 % = 1.532,35 statt 1.532,52). Die Bemessungsgrundlage
// wird hier aus dem Steuerkonto zurückgerechnet (Steuer ÷ Satz, auf Cent gerundet), nicht aus den Nettobeträgen der Buchungen.
const ELSTER_BASES: ReadonlyArray<{ skr03: number; kz: number; taxKz?: number; rate: number; label: string }> = [
  { skr03: 1776, kz: 81, rate: 0.19, label: "Umsätze 19 %" },
  { skr03: 1771, kz: 86, rate: 0.07, label: "Umsätze 7 %" },
  { skr03: 1787, kz: 46, taxKz: 47, rate: 0.19, label: "§ 13b, Steuer auf Leistungen (Konto 1787 fasst Kz 46/47 und 84/85 zusammen)" },
];

export function elsterEstimate(accounts: Array<{ account: number; side: Side; kennziffer: number; amount: number }>, chart: "SKR03" | "SKR04") {
  const amountOf = (skr03: number) => {
    const acc = TAX_ACCOUNTS.find((a) => a.skr03 === skr03)!;
    const number = chart === "SKR03" ? acc.skr03 : acc.skr04;
    return accounts.find((a) => a.account === number)?.amount ?? 0;
  };
  const kennziffern = ELSTER_BASES.map((b) => {
    const accountTax = amountOf(b.skr03);
    const base = Math.floor(round(accountTax / b.rate));
    return { kz: b.kz, tax_kz: b.taxKz, label: b.label, bemessungsgrundlage: base, steuer: round(base * b.rate), steuer_laut_konto: accountTax };
  });
  const vorsteuer66 = round(amountOf(1571) + amountOf(1576));
  const vorsteuer67 = amountOf(1577);
  const umsatzsteuer = round(kennziffern.reduce((s, k) => s + k.steuer, 0));
  const zahllast = round(umsatzsteuer - vorsteuer66 - vorsteuer67);
  return { kennziffern, vorsteuer_kz66: vorsteuer66, vorsteuer_kz67: vorsteuer67, umsatzsteuer, zahllast_oder_erstattung: zahllast };
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
      const elster = elsterEstimate(accounts, chart);
      return ok({
        period: { date_from: args.date_from, date_to: args.date_to, base: args.base },
        chart,
        accounts,
        umsatzsteuer,
        vorsteuer,
        zahllast_oder_erstattung: zahllast,
        result: zahllast >= 0 ? "Zahllast" : "Erstattung",
        elster_estimate: {
          ...elster,
          differenz_zu_konten: round(elster.zahllast_oder_erstattung - zahllast),
          hinweis:
            "Schätzung im ELSTER-Format: Bemessungsgrundlagen (Kz 81, 86, 46) auf volle Euro abgerundet, Steuer daraus. Bemessungsgrundlage aus dem Steuerkonto zurückgerechnet; Sondervorauszahlung, Vorjahres-Salden und Dauerfristverlängerung fehlen. Konto 1787/1577 fasst § 13b-Fälle mit den Schlüsseln 506 (Kz 46/47) und 511 (Kz 84/85) zusammen, daher steht alles unter Kz 46/47 und Kz 67; bei gemischten Fällen kann die Rundung je Kennziffer um einige Cent abweichen. Kz 67 ist der gebuchte Wert.",
        },
        notes: [
          "Nicht die ELSTER-Zahl: USt-VA-Entwurf in der BHB-Oberfläche gegenprüfen; elster_estimate rundet wie ELSTER.",
          "§ 13b: Umsatzsteuer und Vorsteuer heben sich in der Zahllast auf. Kennziffern: 19_both_506 = Kz 46/47, 19_both_511 = Kz 84/85 (Vorsteuer beider Kz 67, verifiziert).",
          "Bei Ist-Versteuerung zählt der Zahlungszeitpunkt. Die Kontenblätter zeigen, was BHB für den Zeitraum auswertet; die Besteuerungsart, die für den Zeitraum galt, darf nicht nachträglich gewechselt worden sein.",
          "Steuerkonten aus Buchungen mit abweichendem Leistungsdatum fallen je nach base in andere Perioden: base: \"date\" zum Vergleich.",
        ],
      });
    },
  });

  return [previewVatImpact];
}
