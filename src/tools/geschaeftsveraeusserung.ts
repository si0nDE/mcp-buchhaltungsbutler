// Geschäftsveräußerung im Ganzen (§ 1 Abs. 1a UStG) und ihr Gegenfall, die Überlassung eines Kundenstamms gegen laufende
// Provision ("Earn-Out"). Rechtsgrundlagen, Quellenprotokoll und Buchungsempfehlung: docs/rechtsgrundlagen-geschaeftsveraeusserung-earn-out.md
// (Stand 09.11.2026); Buchungsmuster: get_booking_guide geschaeftsveraeusserung. Die Hinweise hier sind Rückfragen in beide
// Richtungen, keine Verbote: ob ein Betrieb im Ganzen übergeht oder nur Kunden gegen Mitwirkung übergeleitet werden, steht
// im Vertrag, nicht in der Buchung. Alle Beispiele und Tests nutzen erfundene Daten.

export const GIG_GUIDE = "get_booking_guide geschaeftsveraeusserung";
export const GIG_HINWEIS_VORSCHLAG = "Nicht steuerbare Geschäftsveräußerung im Ganzen nach § 1 Abs. 1a UStG, keine Umsatzsteuer.";

// Wörter, die auf einen Kaufpreis für einen Betrieb oder Kundenstamm deuten. "Provision" oder "Kaufpreis" allein sind zu
// häufig (Vermittler, Warenkauf) und zählen nicht.
const GIG_TEXT = /gesch[äa]ftsver[äa]u(ß|ss)erung|earn[\s-]?out|kundenstamm|betriebsver[äa]u(ß|ss)erung|teilbetrieb|§\s*1\s*abs\.?\s*1a|unternehmenskauf|asset[\s-]?deal/i;
const GIG_HINWEIS_IM_TEXT = /§\s*1\s*abs\.?\s*1a|gesch[äa]ftsver[äa]u(ß|ss)erung/i;

// SKR03: Erlöskonten, deren Name einen Steuersatz nennt ("19/16 %"), setzen die Steuer selbst (Automatikkonto, Katalog
// 09.11.2026); für steuerfreie oder nicht steuerbare Anlagenverkäufe gibt es daneben 8800/8829 (Sachanlagen) und 8817/8837
// (immaterielle Werte) ohne Automatik. Für SKR04 nicht geprüft.
const AUTOMATIK_ERLOES_SKR03 = new Map<number, string>([
  [8801, "Erlöse aus Anlagenverkäufen 19/16 % (Buchverlust)"],
  [8820, "Erlöse aus Anlagenverkäufen 19/16 % (Buchgewinn)"],
  [8850, "Erlöse aus Verkäufen Umlaufvermögen 19/16 % USt"],
]);
const ERLOES_SKR03 = (n: number) => n >= 8000 && n <= 8999;
const USt_CODES = /^(19|7)_vat$/;

export const matchesGigText = (text: unknown): boolean => typeof text === "string" && GIG_TEXT.test(text);

// Vorprüfung ohne API-Aufruf: nur wenn ein Split überhaupt treffen kann, lohnt es sich, den Kontenrahmen zu holen.
export const mayNeedGigCheck = (splits: Array<{ postingaccount: number; vat: string; postingtext?: string }>): boolean =>
  splits.some((s) => matchesGigText(s.postingtext) || (s.vat === "0_none" && AUTOMATIK_ERLOES_SKR03.has(s.postingaccount)));

const beideRichtungen =
  "Geht ein Betrieb oder Teilbetrieb im Ganzen an einen Unternehmer über, der ihn fortführt, ist der Kaufpreis samt Earn-Out nicht " +
  "steuerbar (§ 1 Abs. 1a UStG): 0_none, Rechnung ohne Steuerausweis (sonst § 14c UStG). Wird nur der Kundenstamm übergeleitet, schuldet " +
  "der Veräußerer Mitwirkung (Übergabe, Kundenzuführung) oder hängt die Provision an seiner Tätigkeit, ist das eine steuerpflichtige " +
  `sonstige Leistung zu 19 %. Prüffragen und Konten: ${GIG_GUIDE}.`;

// Buchungen vor dem Senden prüfen. Text-Hinweise gelten für jeden Kontenrahmen, der Automatikkonto-Hinweis nur für SKR03.
export function geschaeftsveraeusserungPostingWarnings(
  splits: Array<{ postingaccount: number; vat: string; postingtext?: string; label: string }>,
  chart: "SKR03" | "unknown"
): string[] {
  const out: string[] = [];
  for (const s of splits) {
    const erloes = chart === "SKR03" ? ERLOES_SKR03(s.postingaccount) : true;
    if (matchesGigText(s.postingtext) && erloes && USt_CODES.test(s.vat)) {
      out.push(
        `${s.label}: Buchungstext "${s.postingtext}" deutet auf einen Kaufpreis für Betrieb oder Kundenstamm, gebucht mit ${s.vat} auf ${s.postingaccount}. ` +
          `Richtig, wenn nur der Kundenstamm gegen Mitwirkung übergeleitet wird. ${beideRichtungen}`
      );
    } else if (matchesGigText(s.postingtext) && erloes && s.vat === "0_none") {
      out.push(
        `${s.label}: Buchungstext "${s.postingtext}" ohne Umsatzsteuer auf ${s.postingaccount}. Richtig nur bei einer Geschäftsveräußerung im Ganzen; ` +
          `die Überlassung eines Kundenstamms gegen Provision mit Mitwirkung des Veräußerers ist steuerpflichtig (19 %), und ein Steuerausweis in der ` +
          `Rechnung würde nach § 14c UStG geschuldet. ${beideRichtungen}`
      );
    }
    const automatik = chart === "SKR03" ? AUTOMATIK_ERLOES_SKR03.get(s.postingaccount) : undefined;
    if (automatik && s.vat === "0_none") {
      out.push(
        `${s.label}: Konto ${s.postingaccount} (${automatik}) ist nach seinem Namen ein Automatikkonto, das die Steuer selbst setzt; 0_none passt dort nicht. ` +
          "Für steuerfreie oder nicht steuerbare Anlagenverkäufe 8829/8800 (Sachanlagen) oder 8837/8817 (immaterielle Werte, Kundenstamm, Firmenwert) " +
          `nehmen, Restbuchwerte über die Anlagenverwaltung (2315/2316). ${GIG_GUIDE}.`
      );
    }
  }
  return out;
}

export interface GigInvoiceInput {
  items: Array<{ name: string; vat: string; description?: string }>;
  final_provisions?: string;
  correspondence?: string;
}

// Rechnungen: Positionen mit Earn-Out/Kundenstamm/Geschäftsveräußerung bekommen die Prüffragen, ohne Steuer zusätzlich den
// Pflichthinweis, wenn er fehlt. Nie eine Ablehnung: beide Richtungen können richtig sein.
export function geschaeftsveraeusserungInvoiceWarnings(input: GigInvoiceInput): string[] {
  const hitAll = [input.correspondence].some(matchesGigText);
  const hits = input.items
    .map((item, i) => ({ i, rate: Number(item.vat.replace(",", ".")), hit: hitAll || matchesGigText(item.name) || matchesGigText(item.description) }))
    .filter((x) => x.hit);
  if (hits.length === 0) return [];
  const out: string[] = [];
  const mitSteuer = hits.filter((x) => x.rate > 0).map((x) => x.i);
  const ohneSteuer = hits.filter((x) => !(x.rate > 0)).map((x) => x.i);
  if (mitSteuer.length > 0) {
    out.push(`Position ${mitSteuer.join(", ")} rechnet einen Kaufpreis oder Earn-Out mit Umsatzsteuer ab. ${beideRichtungen}`);
  }
  if (ohneSteuer.length > 0) {
    const hinweis = [input.final_provisions, input.correspondence].some((t) => typeof t === "string" && GIG_HINWEIS_IM_TEXT.test(t));
    out.push(
      `Position ${ohneSteuer.join(", ")} rechnet einen Kaufpreis oder Earn-Out ohne Umsatzsteuer ab. Das setzt eine Geschäftsveräußerung im Ganzen voraus; ` +
        `ein späterer Steuerausweis wäre nach § 14c UStG geschuldet. ${beideRichtungen}` +
        (hinweis ? "" : ` Der Grund der fehlenden Steuer gehört auf die Rechnung; Vorschlag für final_provisions: "${GIG_HINWEIS_VORSCHLAG}"`)
    );
  }
  return out;
}

// Zahlungen: Verwendungszweck mit Earn-Out, Kundenstamm oder Geschäftsveräußerung bekommt einen booking_hint mit Verweis auf das Thema.
export function geschaeftsveraeusserungTransactionHint(rows: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const ids = rows
    .filter((r) => matchesGigText(r.purpose) || matchesGigText(r.payment_reference))
    .map((r) => Number(r.id_by_customer))
    .filter((n) => Number.isFinite(n));
  if (ids.length === 0) return undefined;
  return {
    kind: "geschaeftsveraeusserung",
    transaction_ids: ids,
    hinweis:
      "Verwendungszweck deutet auf einen Kaufpreis für Betrieb oder Kundenstamm (Earn-Out). Vor dem Buchen klären, ob eine nicht steuerbare " +
      "Geschäftsveräußerung im Ganzen vorliegt (0_none, Erlöskonto 8829/8837) oder eine steuerpflichtige Überleitung des Kundenstamms (19_vat, " +
      "Rechnung mit Umsatzsteuer).",
    guide: GIG_GUIDE,
  };
}

export function geschaeftsveraeusserungTransactionHintText(hint: Record<string, unknown>): string {
  const ids = hint.transaction_ids as number[];
  return `${ids.length} Zahlung(en) mit Earn-Out, Kundenstamm oder Geschäftsveräußerung im Verwendungszweck (IDs ${ids.join(", ")}). ${hint.hinweis as string} ${GIG_GUIDE}.`;
}

// get_ustva_position: Erlöskonten aus Anlagenverkäufen ohne feste Position (SKR03, Katalog 09.11.2026).
export const ANLAGEN_ERLOES_OHNE_POSITION_SKR03: ReadonlyArray<readonly [number, string]> = [
  [8800, "Erlöse aus Anlagenverkäufen (Buchverlust)"],
  [8817, "Erlöse Verkäufe immaterieller Vermögensgegenstände (Buchverlust)"],
  [8829, "Erlöse aus Anlagenverkäufen (Buchgewinn)"],
  [8837, "Erlöse aus Verkäufen immaterieller Vermögensgegenstände (Buchgewinn)"],
];

export function anlagenErloesUstVaHinweis(account: number): string | undefined {
  const hit = ANLAGEN_ERLOES_OHNE_POSITION_SKR03.find(([n]) => n === account);
  if (!hit) return undefined;
  return (
    `SKR03 ${hit[0]} (${hit[1]}) hat keine feste Position: mit Steuerschlüssel landet die Buchung nach dem Steuersatz in Kz 81 (19 %) oder Kz 86 (7 %). ` +
    "Mit 0_none erscheint sie gar nicht in der USt-VA. Das ist richtig für eine nicht steuerbare Geschäftsveräußerung im Ganzen (§ 1 Abs. 1a UStG), " +
    "die auch nicht in Kz 45 gehört (dort nur Umsätze mit Leistungsort nicht im Inland). Steuerfreie Anlagenverkäufe in EU oder Drittland haben " +
    `eigene Konten (8808/8828 Kz 41, 8807/8827 Kz 43). ${GIG_GUIDE}.`
  );
}
