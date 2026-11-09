import type { Policy } from "./policy.js";

// Kleinunternehmer nach § 19 UStG (Fassung JStG 2024, seit 01.01.2025). Rechtsgrundlagen und Herkunft jeder Aussage:
// docs/rechtsgrundlagen-steueraenderungen-2025-2028.md, Abschnitt 1. Die BHB-API liefert keinen Kleinunternehmer-Status
// (Spezifikation 1.9.1, live geprüft 09.11.2026); er steht deshalb in der Hausregel-Datei (set_policy kleinunternehmer).

// § 34a Satz 1 Nr. 5 UStDV verlangt einen Hinweis, dass die Steuerbefreiung für Kleinunternehmer gilt; umgangssprachlich genügt
// (UStAE 14.7a Abs. 1 Satz 4: "steuerfreier Kleinunternehmer").
export const KU_HINWEIS_VORSCHLAG = "Steuerfreie Leistung als Kleinunternehmer nach § 19 UStG.";
const KU_HINWEIS = /§\s*19\b|kleinunternehmer/i;

// Codes mit Vorsteuer: ein Kleinunternehmer hat keinen Vorsteuerabzug (§ 19 Abs. 1 UStG mit § 15 Abs. 2; vor dem Wechsel zur
// Regelbesteuerung auch nicht, BMF 10.11.2025).
const VORSTEUER_CODES = new Set([
  "19_pre",
  "7_pre",
  "19_pre_app",
  "7_pre_app",
  "19_both_1",
  "19_both_506",
  "19_both_511",
  "19_both_2",
  "7_both",
  "19_both_app_1",
  "19_both_app_506",
  "19_both_app_511",
  "19_both_app_2",
  "7_both_app",
]);
const UMSATZSTEUER_CODE = /^(19_vat|7_vat|vat_oss_)/;

export async function kleinunternehmerStatus(loader: () => Promise<Policy>): Promise<{ status: boolean | null; warnings: string[] }> {
  try {
    return { status: (await loader()).tax_profile.kleinunternehmer, warnings: [] };
  } catch (e) {
    return { status: null, warnings: [`Kleinunternehmer-Status nicht geprüft: Policy-Datei nicht lesbar (${(e as Error).message}).`] };
  }
}

export interface InvoiceCheckInput {
  type: "invoice" | "credit" | "offer";
  items: Array<{ vat: string; tax_type?: string }>;
  e_invoice?: boolean;
  final_provisions?: string;
  correspondence?: string;
}

// Nur aufrufen, wenn die Hausregel kleinunternehmer: true sagt.
export function kleinunternehmerInvoiceCheck(input: InvoiceCheckInput): { error?: string; warnings: string[] } {
  const warnings: string[] = [];
  const withTax = input.items
    .map((item, i) => ({ i, rate: Number(item.vat.replace(",", ".")), type: item.tax_type }))
    .filter((x) => x.rate > 0 || x.type === "S")
    .map((x) => x.i);
  if (withTax.length > 0) {
    const text =
      `Kleinunternehmer laut Hausregel, aber Position ${withTax.join(", ")} weist Umsatzsteuer aus. Ein Kleinunternehmer schuldet ausgewiesene ` +
      "Steuer nach § 14c UStG, ohne Vorsteuer beim Kunden. Positionen mit vat 0 (bei der E-Rechnung tax_type nicht S) und dem Hinweis auf die " +
      "Steuerbefreiung erstellen. Gilt inzwischen die Regelbesteuerung (Grenze überschritten oder Verzicht nach § 19 Abs. 3 UStG), zuerst die " +
      "Hausregel mit set_policy (kleinunternehmer: false) ändern.";
    if (input.type === "offer") warnings.push(`${text} (Angebot: noch keine Rechnung, deshalb nur Warnung.)`);
    else return { error: text, warnings };
  }
  const hinweis = [input.final_provisions, input.correspondence].some((t) => t !== undefined && KU_HINWEIS.test(t));
  if (!hinweis && input.type !== "offer") {
    warnings.push(
      `Kein Hinweis auf die Steuerbefreiung für Kleinunternehmer gefunden (Pflichtangabe nach § 34a Satz 1 Nr. 5 UStDV). Vorschlag für final_provisions: "${KU_HINWEIS_VORSCHLAG}"`
    );
  }
  if (input.e_invoice) {
    warnings.push(
      "Für Kleinunternehmer ist die E-Rechnung keine Pflicht (§ 34a Satz 3 UStDV, immer als sonstige Rechnung zulässig); freiwillig ist sie erlaubt. Welcher tax_type für § 19 richtig ist, ist nicht geprüft."
    );
  }
  return { warnings };
}

// Nur aufrufen, wenn die Hausregel kleinunternehmer: true sagt.
export function kleinunternehmerPostingWarnings(vats: string[]): string[] {
  const out: string[] = [];
  const vst = [...new Set(vats.filter((v) => VORSTEUER_CODES.has(v)))];
  if (vst.length > 0) {
    out.push(
      `Kleinunternehmer laut Hausregel, aber Code ${vst.join(", ")} bucht Vorsteuer. Kleinunternehmer haben keinen Vorsteuerabzug: normale Eingangsrechnungen ` +
        "brutto mit 0_none buchen. § 13b und innergemeinschaftlicher Erwerb bleiben steuerpflichtig (UStAE 19.1 Abs. 1): Codes ohne Vorsteuer nehmen " +
        "(19_both_1_no_pre, 19_both_6506, 19_both_6511, 19_both_6501, 19_both_2_no_pre, 7_both_no_pre; get_booking_guide kleinunternehmer)."
    );
  }
  const ust = [...new Set(vats.filter((v) => UMSATZSTEUER_CODE.test(v)))];
  if (ust.length > 0) {
    out.push(
      `Kleinunternehmer laut Hausregel, aber Code ${ust.join(", ")} bucht Umsatzsteuer auf Erlöse. Steuerfrei bleiben die Umsätze, bis der Gesamtumsatz ` +
        "(nach Vereinnahmung) im laufenden Jahr 100.000 € überschreitet (Neugründer: 25.000 €); bereits der Umsatz, der die Grenze überschreitet, ist " +
        "voll steuerpflichtig (UStAE 19.1 Abs. 2). Ist das passiert oder wurde verzichtet, die Hausregel mit set_policy ändern; sonst 0_none buchen."
    );
  }
  return out;
}
