import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { extractReceiptText } from "./receipt-text-extraction.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

// Heuristik für Auffälligkeiten auf dem Rechnungstext (Pflichtangaben nach § 14 Abs. 4 UStG). Sie meldet nur, was auffällt, und
// gibt nie eine Freigabe: ein leeres Ergebnis heißt "die Heuristik hat nichts gefunden", nicht "Rechnung in Ordnung". Keine Steuerberatung.

export interface Finding {
  code: string;
  severity: "auffaellig" | "nicht_pruefbar";
  message: string;
}

export interface FieldContext {
  invoicenumber?: string;
  // Betrag laut BHB (brutto), nur zum Vergleich mit dem Text.
  amount?: number;
}

const ID_LABEL = String.raw`(?:USt\.?\s*-?\s*Id\.?\s*-?\s*Nr\.?|Umsatzsteuer\s*-?\s*Identifikationsnummer|VAT\s*(?:ID|No\.?|number)|Steuernummer|Steuer\s*-?\s*Nr\.?|St\.\s*-?\s*Nr\.?)`;
const PLACEHOLDER = String.raw`(?:folgt|beantragt|in\s+Beantragung|wird\s+nachgereicht|nachgereicht|nachgeliefert|n\.?\s?v\.?|entf(?:ä|ae)llt|[-–_.]{2,})`;
const PLACEHOLDER_RE = new RegExp(`${ID_LABEL}\\s*[:.]?\\s*${PLACEHOLDER}(?![A-Za-z0-9])`, "i");
const VAT_ID_RE = /\b[A-Z]{2}\s?\d{8,11}\b|\bDE\s?\d{9}\b/;
const TAX_NO_RE = /\b\d{2,3}\s?\/\s?\d{3}\s?\/\s?\d{4,5}\b|\b\d{10,11}\b/;
const LABELLED_ID_RE = new RegExp(`${ID_LABEL}\\s*[:.]?\\s*[A-Z]{0,2}\\s?\\d`, "i");

const AMOUNT = String.raw`(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}|-?\d+\.\d{2})`;

function parseAmount(s: string): number {
  const t = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  return Number(t);
}

// Betrag hinter einem Etikett; dazwischen dürfen ein Steuersatz ("19 %") und "auf <Betrag>" stehen (Telekom: "+19 % USt. auf 46,86 €   8,90 €").
function labelledAll(text: string, labels: string): number[] {
  const re = new RegExp(`(?:${labels})(?:[^\\d\\n-]{0,40}?\\d{1,2}(?:[,.]\\d+)?\\s?%)?(?:\\s*auf\\s*${AMOUNT})?[^\\d\\n-]{0,40}?${AMOUNT}`, "gim");
  return [...text.matchAll(re)].map((m) => parseAmount(m[m.length - 1]));
}

const digitsOnly = (s: string) => s.replace(/[\s\-_/.]/g, "").toLowerCase();

const round = (n: number) => Math.round(n * 100) / 100;

export function checkReceiptFields(text: string, ctx: FieldContext = {}): Finding[] {
  const out: Finding[] = [];
  const add = (code: string, severity: Finding["severity"], message: string) => out.push({ code, severity, message });

  // 1. Steuernummer oder USt-IdNr. (Aussteller; die Heuristik kann Aussteller und Empfänger nicht trennen)
  const placeholder = PLACEHOLDER_RE.exec(text);
  if (placeholder) {
    add("tax_id_placeholder", "auffaellig", `Platzhalter statt Steuernummer/USt-IdNr.: „${placeholder[0].replace(/\s+/g, " ")}“ (Pflichtangabe, Vorsteuerabzug gefährdet)`);
  } else if (!LABELLED_ID_RE.test(text) && !VAT_ID_RE.test(text) && !TAX_NO_RE.test(text)) {
    add("tax_id_missing", "auffaellig", "Weder Steuernummer noch USt-IdNr. im Text gefunden (bei Kleinbetragsrechnung bis 250 € brutto nicht verlangt)");
  } else {
    add("tax_id_issuer_unclear", "nicht_pruefbar", "Eine Steuernummer/USt-IdNr. steht im Text, ob sie die des Ausstellers ist (nicht die des Empfängers), ist nicht prüfbar");
  }

  // 2. Anschrift des Ausstellers (nur: überhaupt eine Anschrift mit PLZ)
  if (!/\b\d{5}\s+[A-ZÄÖÜ][\wäöüß.-]+/.test(text)) add("address_missing", "auffaellig", "Keine Anschrift mit Postleitzahl erkennbar");

  // 3. Rechnungsdatum
  if (!/\b\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\.?\s*(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+\d{4}\b/i.test(text)) {
    add("date_missing", "auffaellig", "Kein Datum im Text erkennbar");
  }

  // 4. fortlaufende Rechnungsnummer
  const hasLabelNo = /Rechnungs?\s*-?\s*(?:nummer|nr\.?)\s*[:.]?\s*\S+|Rechnung\s+(?:Nr\.?|Nummer)\s*[:.]?\s*\S+|Invoice\s*(?:No\.?|number)\s*[:.]?\s*\S+/i.test(text);
  const hasCtxNo = ctx.invoicenumber ? text.includes(ctx.invoicenumber) || digitsOnly(text).includes(digitsOnly(ctx.invoicenumber)) : false;
  if (!hasLabelNo && !hasCtxNo) add("invoicenumber_missing", "auffaellig", "Keine Rechnungsnummer erkennbar");
  else if (ctx.invoicenumber && !hasCtxNo) {
    add("invoicenumber_differs", "auffaellig", `Rechnungsnummer laut BHB „${ctx.invoicenumber}“ steht nicht im Text`);
  }

  // 5. Leistungsdatum oder -zeitraum
  if (!/Leistungs?\s*-?\s*(?:datum|zeitraum|zeit)|Lieferdatum|Liefertermin|Lieferung\s+am|Leistung\s+(?:am|vom)|Zeitraum|Abrechnungszeitraum|Leistungsdatum\s+entspricht/i.test(text)) {
    add("service_date_missing", "auffaellig", "Kein Leistungsdatum oder -zeitraum erkennbar (Pflichtangabe, sofern nicht mit dem Rechnungsdatum identisch und dann so vermerkt)");
  }

  // 6. Steuersatz / Hinweis auf Steuerbefreiung
  const hasRate = /\b\d{1,2}(?:[,.]\d+)?\s?%/.test(text) && /USt|MwSt|Umsatzsteuer|Mehrwertsteuer|VAT/i.test(text);
  const hasExemption = /steuerfrei|§\s*19\b|Kleinunternehmer|§\s*4\s+Nr|Reverse[\s-]*Charge|§\s*13b|nicht\s+steuerbar/i.test(text);
  if (!hasRate && !hasExemption) add("tax_rate_missing", "auffaellig", "Weder Steuersatz mit Steuerbetrag noch Hinweis auf Steuerbefreiung erkennbar");

  // 7. Rechenprobe Netto + Steuer = Brutto und Vergleich mit BHB
  const net = labelledAll(text, "Netto(?:betrag)?|Summe\\s+netto|Gesamt\\s*netto|Zwischensumme|Nettosumme")[0];
  const taxes = labelledAll(text, "(?:zzgl\\.?\\s*|\\+\\s*)?(?:USt\\.?|MwSt\\.?|Umsatzsteuer|Mehrwertsteuer)");
  // Mehrere Kandidaten für Brutto (z. B. "EUR brutto 100,00" in einem Guthabenhinweis): die Rechenprobe schlägt nur an,
  // wenn kein einziger zu Netto + Steuer passt.
  const grosses = labelledAll(text, "Brutto(?:betrag)?|Gesamtbetrag|Rechnungsbetrag|Endbetrag|Gesamtsumme|Summe\\s+brutto|zu\\s+zahlen(?:der\\s+Betrag)?|^\\s*Betrag");
  const tax = taxes.find((t) => net !== undefined && grosses.some((g) => Math.abs(round(net + t) - round(g)) <= 0.011)) ?? taxes[0];
  if (net !== undefined && tax !== undefined && grosses.length > 0) {
    if (!grosses.some((g) => Math.abs(round(net + tax) - round(g)) <= 0.011)) {
      add("arithmetic", "auffaellig", `Netto ${net.toFixed(2)} + Steuer ${tax.toFixed(2)} = ${round(net + tax).toFixed(2)}, im Text steht Brutto ${grosses.map((g) => g.toFixed(2)).join(" / ")} (Rundung bis 0,01 € zulässig)`);
    }
  } else {
    add("arithmetic_unchecked", "nicht_pruefbar", "Rechenprobe nicht möglich: Netto, Steuer und Brutto sind nicht alle eindeutig beschriftet im Text zu finden");
  }
  // Der Betrag aus BHB muss irgendwo im Text stehen (deutsches oder englisches Format); sonst auffällig.
  if (ctx.amount !== undefined) {
    const abs = Math.abs(round(ctx.amount));
    const de = abs.toFixed(2).replace(".", ",");
    const deThousands = de.replace(/\B(?=(\d{3})+(?!\d),)/g, ".");
    if (!text.includes(de) && !text.includes(deThousands) && !text.includes(abs.toFixed(2))) {
      add("amount_differs", "auffaellig", `Der Betrag aus BHB (${abs.toFixed(2)}) steht nirgends im Text`);
    }
  }
  return out;
}

export const RECEIPT_FIELDS_DISCLAIMER =
  "Heuristik auf dem PDF-Text, keine Prüfung und keine Freigabe, keine Steuerberatung. Ob Aussteller, Leistungsdatum und Plausibilität " +
  "(z. B. Leistung vor Eintragung des Ausstellers bei verbundenen Unternehmen) stimmen, entscheidet der Nutzer.";

export function createReceiptFieldsTools(client: BBClient): [ToolDef] {
  const checkReceiptFieldsTool = defineTool({
    name: "check_receipt_fields",
    description:
      "Heuristic check of a receipt's PDF text for conspicuous or missing mandatory invoice details (§ 14 Abs. 4 UStG): Steuernummer/USt-IdNr. " +
      "(placeholders like 'folgt' or 'beantragt' are flagged), address, date, invoice number, Leistungsdatum/-zeitraum, tax rate or exemption note, " +
      "and the check Netto + Steuer = Brutto (±0.01) plus comparison with the amount in BHB. Returns ONLY findings (auffaellig / nicht_pruefbar) - it never " +
      "says a receipt is fine, an empty list is not an approval. Needs a PDF with a text layer. Not tax advice. Read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: { id_by_customer: z.number().int().describe("Receipt id (id_by_customer).") },
    async handler(args) {
      const res = await client.call<{ data?: Record<string, unknown> }>("receiptsGetIdByCustomer", { get_file: true }, { idSuffix: args.id_by_customer });
      const raw = ((res.data as { data?: Record<string, unknown> } | undefined)?.data ?? res.data ?? {}) as Record<string, unknown>;
      const { file_content, file_type, ...receipt } = raw;
      const text = file_type === "pdf" && typeof file_content === "string" ? await extractReceiptText(file_content) : undefined;
      if (!text) {
        return ok(
          {
            receipt_id: args.id_by_customer,
            text_available: false,
            findings: [],
            note: "Kein Text lesbar (kein PDF oder nur Bild ohne Textebene): nichts geprüft. Beleg selbst ansehen.",
            disclaimer: RECEIPT_FIELDS_DISCLAIMER,
          }
        );
      }
      const amount = Number(receipt.amount);
      const findings = checkReceiptFields(text, {
        invoicenumber: typeof receipt.invoicenumber === "string" && receipt.invoicenumber ? receipt.invoicenumber : undefined,
        amount: Number.isFinite(amount) ? amount : undefined,
      });
      const flagged = findings.filter((f) => f.severity === "auffaellig").length;
      const result = ok(
        {
          receipt_id: args.id_by_customer,
          invoicenumber: receipt.invoicenumber ?? null,
          text_available: true,
          flagged,
          findings,
          disclaimer: RECEIPT_FIELDS_DISCLAIMER,
        }
      );
      result.content.push({
        type: "text",
        text:
          flagged > 0
            ? `${flagged} Auffälligkeit(en) gemeldet. ${RECEIPT_FIELDS_DISCLAIMER}`
            : `Die Heuristik meldet nichts Auffälliges; das ist keine Freigabe. ${RECEIPT_FIELDS_DISCLAIMER}`,
      });
      return result;
    },
  });
  return [checkReceiptFieldsTool];
}
