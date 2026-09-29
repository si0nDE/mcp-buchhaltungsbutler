import { type PDFFont, PDFDocument, PageSizes, StandardFonts, rgb } from "pdf-lib";
import { DEDUCTIBLE_SHARE } from "./entertainment-expense.js";

// Rejected by real, live-verified BFH rulings as too vague to show the
// business connection required by § 4 Abs. 5 Satz 1 Nr. 2 EStG - used
// verbatim from those decisions, not invented, so the error can point to
// real case law instead of an arbitrary house rule:
//   BFH v. 15.01.1998, IV R 81/96, BStBl II 1998, 263
//   BFH v. 26.02.2004, IV R 50/01, BStBl II 2004, 502
const OCCASION_DENYLIST = new Set([
  "geschäftsessen",
  "geschäftsbesprechung",
  "kontaktpflege",
  "kundenpflege",
  "akquisitionsbesprechung",
  "mandatsbesprechung",
  "arbeitsgespräch",
  "infogespräch",
  "hintergrundgespräch",
  "meeting",
  "besprechung",
]);

const MIN_OCCASION_LENGTH = 15;

// Throws if the occasion is one of the exact phrases German courts have
// already rejected as too vague, or if it's shorter than a reasonable
// minimum regardless of content. Matches on the trimmed, lowercased whole
// string (not a substring) so a genuinely detailed occasion that happens to
// mention "Geschäftsessen" in passing isn't falsely rejected.
export function assertOccasionIsConcrete(occasion: string): void {
  const trimmed = occasion.trim();
  const normalized = trimmed.toLowerCase();
  if (OCCASION_DENYLIST.has(normalized) || trimmed.length < MIN_OCCASION_LENGTH) {
    throw new Error(
      `"${occasion}" ist als Anlass zu unkonkret - der BFH hat genau solche Pauschalformulierungen ` +
        `wiederholt nicht anerkannt (BFH v. 15.01.1998, IV R 81/96, BStBl II 1998, 263; BFH v. 26.02.2004, ` +
        `IV R 50/01, BStBl II 2004, 502). Der Anlass muss so konkret sein, dass ein Außenstehender den ` +
        `geschäftlichen Zusammenhang sofort erkennt - frag nach, worüber inhaltlich gesprochen oder entschieden wurde.`
    );
  }
}

export interface EntertainmentReceiptAmounts {
  foodNet: number;
  foodVat: number;
  drinksNet: number;
  drinksVat: number;
  tip: number;
  kleinunternehmer: boolean;
}

export interface ComputedAmounts {
  grossTotal: number;
  vatTotal: number;
  deductibleBase: number;
  deductible: number;
  nonDeductible: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatEuro(value: number): string {
  return `${value.toFixed(2).replace(".", ",")} €`;
}

// Itemizes Speisen/Getränke/Trinkgeld instead of only the aggregate total, so
// the amount is traceable against the original invoice without needing the
// invoice itself at hand. Regelbesteuerung shows each item's net + USt split
// (matching how it's printed on the restaurant bill); Kleinunternehmer shows
// gross-only per item, consistent with computeAmounts splitting on the gross
// base for them (no separate net/VAT distinction in their own bookkeeping).
// Expressed as a decimal factor ("Faktor 0,70") rather than "70 %" next to a
// Euro amount - this page is uploaded and OCR-scanned by the receiving
// accounting system as if it were an independent invoice, and a bare "NN %"
// next to a total is a plausible (unconfirmed) source of it misreading the
// number as a VAT rate. Cheap to avoid even without proof it's the cause.
export function buildDeductibleLine(deductible: number, kleinunternehmer: boolean): string {
  return `Abziehbar (Faktor 0,70 v. ${kleinunternehmer ? "Brutto" : "Netto"}): ${formatEuro(deductible)}`;
}

export function buildNonDeductibleLine(nonDeductible: number): string {
  return `Nicht abziehbar (Faktor 0,30): ${formatEuro(nonDeductible)}`;
}

// One entry per line rather than joined into a single "·"-separated run-on
// line - much easier to scan for the specific figure you're looking for,
// especially once Vorsteuer is buried behind two itemized subtotals.
export function buildAmountBreakdownLines(
  input: Pick<EntertainmentReceiptAmounts, "foodNet" | "foodVat" | "drinksNet" | "drinksVat" | "tip">,
  computed: ComputedAmounts,
  kleinunternehmer: boolean
): string[] {
  const foodGross = round2(input.foodNet + input.foodVat);
  const drinksGross = round2(input.drinksNet + input.drinksVat);
  const lines = [
    foodGross > 0
      ? kleinunternehmer
        ? `Speisen: ${formatEuro(foodGross)}`
        : `Speisen: ${formatEuro(input.foodNet)} netto + ${formatEuro(input.foodVat)} USt`
      : "",
    drinksGross > 0
      ? kleinunternehmer
        ? `Getränke: ${formatEuro(drinksGross)}`
        : `Getränke: ${formatEuro(input.drinksNet)} netto + ${formatEuro(input.drinksVat)} USt`
      : "",
    input.tip > 0 ? `Trinkgeld: ${formatEuro(input.tip)}` : "",
    `Gesamtbetrag: ${formatEuro(computed.grossTotal)}`,
    kleinunternehmer ? "" : `davon Vorsteuer (100 % abziehbar): ${formatEuro(computed.vatTotal)}`,
  ];
  return lines.filter(Boolean);
}

export interface Participant {
  name: string;
  company?: string;
}

// One participant per line instead of a single comma-joined run-on string -
// structured input (rather than free text split on commas) avoids ambiguity
// when a company name itself contains a comma (e.g. "Zehnder (Kanzlei X,
// Steuerberater)").
export function formatParticipantLine(participant: Participant): string {
  return `${participant.name}${participant.company ? ` (${participant.company})` : ""}`;
}

// Only addition happens here - VAT amounts and the two split halves are
// never computed by multiplying a net figure by a rate (see the module doc
// comment on entertainment-receipt.ts for why). Regelbesteuerung splits the
// 70/30 on the net base (food + drinks net, plus tip since it carries no
// VAT); Kleinunternehmer (no separate Vorsteuerabzug at all, so no net/gross
// distinction in their own bookkeeping) splits on the gross base instead.
export function computeAmounts(input: EntertainmentReceiptAmounts): ComputedAmounts {
  const vatTotal = round2(input.foodVat + input.drinksVat);
  const grossTotal = round2(input.foodNet + input.foodVat + input.drinksNet + input.drinksVat + input.tip);
  const netBase = round2(input.foodNet + input.drinksNet + input.tip);
  const deductibleBase = input.kleinunternehmer ? grossTotal : netBase;
  const deductible = round2(deductibleBase * DEDUCTIBLE_SHARE);
  const nonDeductible = round2(deductibleBase - deductible);
  return { grossTotal, vatTotal, deductibleBase, deductible, nonDeductible };
}

export interface EntertainmentReceiptFields {
  date: string;
  location: string;
  occasion: string;
  participants: Participant[];
  hostName: string;
  hostRole?: string;
  companyName?: string;
  companyAddress?: string;
  receiptNumber?: string;
  billReference?: string;
  foodNet: number;
  foodVat: number;
  drinksNet: number;
  drinksVat: number;
  tip: number;
}

export const MARGIN = 56;
const BLACK = rgb(0.1, 0.1, 0.1);
const GRAY = rgb(0.46, 0.46, 0.46);
const LIGHT_RULE = rgb(0.85, 0.85, 0.85);
// Minimum horizontal gap, in points, kept between a letterhead line's
// left-aligned text (companyName/companyAddress) and its right-aligned
// counterpart (title/sub) once both are measured at their actual rendered
// width. Exported so tests can reconstruct the same bound independently.
export const LETTERHEAD_GAP = 16;

// Table row values are drawn at MARGIN + TABLE_VALUE_X_OFFSET, so their wrap
// width must be measured from that same offset to the right content edge -
// not from a separately-maintained magic number, which previously drifted
// out of sync and let wrapped lines overflow the right border by ~8pt.
export const TABLE_VALUE_X_OFFSET = 168;
export const TABLE_ROW_LINE_HEIGHT = 14;
export function tableValueMaxWidth(contentWidth: number): number {
  return contentWidth - TABLE_VALUE_X_OFFSET;
}

// Breaks a single word into the smallest number of substrings that each fit
// within maxWidth, char by char. Used as a fallback by wrapText for a word
// that alone is wider than the column (plausible with long German compound
// nouns) - the normal space-based wrapping never flushes such a word on its
// own, since it only flushes when `current` is already non-empty.
function breakLongWord(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const char of word) {
    const candidate = current + char;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      chunks.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Exported (in addition to being used internally) so tests can reconstruct
// exactly what a given letterhead line will render as, using the same
// pdf-lib font metrics, without duplicating the wrapping logic.
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      // The word alone doesn't fit the column - flush whatever's pending
      // first, then break the word itself into character-level chunks.
      if (current) {
        lines.push(current);
        current = "";
      }
      const chunks = breakLongWord(word, font, size, maxWidth);
      for (let i = 0; i < chunks.length - 1; i++) {
        lines.push(chunks[i]);
      }
      current = chunks[chunks.length - 1] ?? "";
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Wraps address-like text (name, street + number, PLZ + city) preferring
// breaks at comma boundaries over the arbitrary mid-clause breaks plain
// wrapText produces - closer to how a DIN 5008 postal address block reads.
// Falls back to wrapText for a single segment that alone doesn't fit.
export function wrapAddressText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const segments = text.split(",").map((segment) => segment.trim());
  const lines: string[] = [];
  let current = "";
  for (const segment of segments) {
    const candidate = current ? `${current}, ${segment}` : segment;
    // Reserve room for the trailing "," a mid-sequence flush appends below -
    // testing the bare candidate here would accept a line that only fits
    // without that comma, then overflow by the comma's width once appended.
    const candidateFlushWidth = font.widthOfTextAtSize(`${candidate},`, size);
    if (candidateFlushWidth > maxWidth && current) {
      lines.push(`${current},`);
      current = segment;
    } else {
      current = candidate;
    }
    if (font.widthOfTextAtSize(current, size) > maxWidth) {
      const wrapped = wrapText(current, font, size, maxWidth);
      lines.push(...wrapped.slice(0, -1));
      current = wrapped[wrapped.length - 1] ?? "";
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Short letterhead reference to the original bill - deliberately excludes
// the EStG citation (already stated in the Bestätigung box below) so it
// stays short enough to leave room for the company address on the same
// line, and doesn't repeat "Rechnung" when billReference already reads
// like "Rechnung-Nr. 92119" (callers should pass just the number instead,
// see the bill_reference schema description in entertainment-receipt.ts).
export function buildLetterheadSubtitle(billReference?: string): string {
  return `Ergänzung zu Rechnung ${billReference ?? "-"}`;
}

// BMF v. 30.06.2021 (IV C 6 - S 2145/19/10003 :003) originally established
// that a digital Eigenbeleg needs no handwritten signature. It was replaced
// by BMF v. 19.11.2025 for Bewirtungen ab 1.1.2025 (the 2021 letter still
// only governs Bewirtungen up to 31.12.2024) - confirmed directly against
// the BMF's own published PDF, Rz. 19: "elektronische Unterschrift oder eine
// elektronische Genehmigung der entsprechenden Angaben" suffices. Cites the
// current letter, not the superseded one, so every generated receipt points
// to a source that still exists and still says what's being claimed.
export function buildConfirmationDisclaimer(): string {
  return "gem. § 4 Abs. 5 Nr. 2 EStG, BMF v. 19.11.2025 Rz. 19 - Unterschrift entbehrlich";
}

// Builds the Bestätigung box's name/role lines. hostName and hostRole are
// wrapped independently and concatenated (rather than joined into one string
// and wrapped as a unit) so hostRole always starts on its own line, even
// when both would fit on a single line width-wise.
export function buildHostConfirmationLines(
  hostName: string,
  hostRole: string | undefined,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] {
  const nameLines = wrapText(hostName, font, size, maxWidth);
  const roleLines = hostRole ? wrapText(hostRole, font, size, maxWidth) : [];
  return [...nameLines, ...roleLines];
}

// Renders the Variante-B "Bewirtungsangaben" cover page (letterhead, bordered
// info table, Aufteilung/Bestätigung boxes, footer) as a standalone one-page
// A4 PDF - the caller merges or links it with the original bill afterwards.
export async function renderEntertainmentReceiptCover(
  fields: EntertainmentReceiptFields,
  amounts: ComputedAmounts,
  options: { kleinunternehmer: boolean; attachmentFollows?: boolean }
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(PageSizes.A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [width, height] = PageSizes.A4;
  const contentWidth = width - 2 * MARGIN;

  let y = height - MARGIN;

  // Letterhead - companyName/companyAddress sit on the same line as
  // right-aligned text (title, subtitle) whose own width varies with
  // billReference. A fixed half-content-width split doesn't bound the
  // right side (a long billReference widens `sub` past that split), so
  // each left-side line is instead clamped to whatever's left after the
  // ACTUAL rendered width of that line's right-side text plus a fixed gap
  // - computed per line, from the same font metrics used to draw it.
  const title = "Bewirtungsangaben";
  const titleWidth = bold.widthOfTextAtSize(title, 12);
  const companyNameMaxWidth = Math.max(0, contentWidth - titleWidth - LETTERHEAD_GAP);
  const companyNameLine = wrapText(fields.companyName ?? "[Firmenname]", bold, 12, companyNameMaxWidth)[0] ?? "";
  page.drawText(companyNameLine, { x: MARGIN, y, size: 12, font: bold, color: BLACK });
  page.drawText(title, { x: width - MARGIN - titleWidth, y, size: 12, font: bold, color: BLACK });
  y -= 15;
  const sub = buildLetterheadSubtitle(fields.billReference);
  const subWidth = font.widthOfTextAtSize(sub, 9);
  const companyAddressMaxWidth = Math.max(0, contentWidth - subWidth - LETTERHEAD_GAP);
  const companyAddressLine = wrapText(fields.companyAddress ?? "[Straße Nr., PLZ Ort]", font, 9, companyAddressMaxWidth)[0] ?? "";
  page.drawText(companyAddressLine, { x: MARGIN, y, size: 9, font, color: GRAY });
  page.drawText(sub, { x: width - MARGIN - subWidth, y, size: 9, font, color: GRAY });
  y -= 26;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: width - MARGIN, y }, thickness: 1.5, color: BLACK });
  y -= 22;

  // Bordered info table
  const amountLines = buildAmountBreakdownLines(fields, amounts, options.kleinunternehmer);
  const participantLines = fields.participants.map(formatParticipantLine);
  type RowKind = "text" | "address" | "lines";
  const rows: Array<{ label: string; kind: RowKind; value: string | string[] }> = [
    { label: "Datum", kind: "text", value: fields.date },
    { label: "Ort der Bewirtung", kind: "address", value: fields.location },
    { label: "Anlass", kind: "text", value: fields.occasion },
    { label: "Teilnehmer", kind: "lines", value: participantLines },
    { label: "Rechnungsbetrag", kind: "lines", value: amountLines },
  ];
  const tableTop = y;
  for (const { label, kind, value } of rows) {
    const maxWidth = tableValueMaxWidth(contentWidth);
    const lines =
      kind === "address"
        ? wrapAddressText(value as string, font, 10, maxWidth)
        : kind === "lines"
          ? (value as string[]).flatMap((entry) => wrapText(entry, font, 10, maxWidth))
          : wrapText(value as string, font, 10, maxWidth);
    page.drawText(label, { x: MARGIN + 8, y, size: 9, font, color: GRAY });
    lines.forEach((line, i) => {
      page.drawText(line, { x: MARGIN + TABLE_VALUE_X_OFFSET, y: y - i * TABLE_ROW_LINE_HEIGHT, size: 10, font, color: BLACK });
    });
    y -= Math.max(26, lines.length * TABLE_ROW_LINE_HEIGHT + 12);
    page.drawLine({ start: { x: MARGIN, y }, end: { x: width - MARGIN, y }, thickness: 0.5, color: LIGHT_RULE });
  }
  page.drawRectangle({
    x: MARGIN,
    y,
    width: contentWidth,
    height: tableTop - y + 14,
    borderColor: BLACK,
    borderWidth: 1,
  });
  y -= 24;

  // Aufteilung / Bestätigung boxes - the Bestätigung box's hostName/hostRole
  // line and disclaimer are wrapped instead of drawn unbroken, since a long
  // hostRole (or a long companyAddress feeding into hostRole-like text) can
  // otherwise overflow the border. Both boxes always share the taller of
  // the fixed 78 and whatever the wrapped Bestätigung content needs, so
  // they keep lining up with each other.
  const boxWidth = (contentWidth - 16) / 2;
  const confirmX = MARGIN + boxWidth + 26;
  const boxInnerWidth = boxWidth - 20;

  const hostLines = buildHostConfirmationLines(fields.hostName, fields.hostRole, font, 10, boxInnerWidth);
  const disclaimerLines = wrapText(buildConfirmationDisclaimer(), font, 8, boxInnerWidth);

  const HEADER_OFFSET = 16;
  const HOST_START_OFFSET = 34;
  const HOST_LINE_HEIGHT = 13;
  const CONFIRMED_GAP = 14;
  const DISCLAIMER_GAP = 12;
  const DISCLAIMER_LINE_HEIGHT = 10;
  const BOX_BOTTOM_PADDING = 10;

  const hostLineOffsets = hostLines.map((_, i) => HOST_START_OFFSET + i * HOST_LINE_HEIGHT);
  const lastHostOffset = hostLineOffsets[hostLineOffsets.length - 1] ?? HOST_START_OFFSET;
  const confirmedOffset = lastHostOffset + CONFIRMED_GAP;
  const disclaimerStartOffset = confirmedOffset + DISCLAIMER_GAP;
  const disclaimerLineOffsets = disclaimerLines.map((_, i) => disclaimerStartOffset + i * DISCLAIMER_LINE_HEIGHT);
  const lastDisclaimerOffset = disclaimerLineOffsets[disclaimerLineOffsets.length - 1] ?? disclaimerStartOffset;
  const confirmContentHeight = lastDisclaimerOffset + BOX_BOTTOM_PADDING;

  const boxHeight = Math.max(78, confirmContentHeight);
  const boxTop = y;
  page.drawRectangle({ x: MARGIN, y: boxTop - boxHeight, width: boxWidth, height: boxHeight, borderColor: BLACK, borderWidth: 1 });
  page.drawRectangle({
    x: MARGIN + boxWidth + 16,
    y: boxTop - boxHeight,
    width: boxWidth,
    height: boxHeight,
    borderColor: BLACK,
    borderWidth: 1,
  });
  page.drawText("Steuerliche Aufteilung", { x: MARGIN + 10, y: boxTop - HEADER_OFFSET, size: 9, font, color: GRAY });
  page.drawText(buildDeductibleLine(amounts.deductible, options.kleinunternehmer), {
    x: MARGIN + 10,
    y: boxTop - 34,
    size: 10,
    font,
    color: BLACK,
  });
  page.drawText(buildNonDeductibleLine(amounts.nonDeductible), {
    x: MARGIN + 10,
    y: boxTop - 48,
    size: 10,
    font,
    color: BLACK,
  });

  page.drawText("Bestätigung", { x: confirmX, y: boxTop - HEADER_OFFSET, size: 9, font, color: GRAY });
  hostLines.forEach((line, i) => {
    page.drawText(line, { x: confirmX, y: boxTop - hostLineOffsets[i], size: 10, font, color: BLACK });
  });
  page.drawText(`Elektronisch bestätigt: ${fields.date}`, { x: confirmX, y: boxTop - confirmedOffset, size: 9, font, color: GRAY });
  disclaimerLines.forEach((line, i) => {
    page.drawText(line, { x: confirmX, y: boxTop - disclaimerLineOffsets[i], size: 8, font, color: GRAY });
  });

  // Footer
  const footerY = MARGIN - 10;
  page.drawLine({ start: { x: MARGIN, y: footerY + 14 }, end: { x: width - MARGIN, y: footerY + 14 }, thickness: 0.5, color: LIGHT_RULE });
  page.drawText(fields.companyName ?? "[Firmenname]", { x: MARGIN, y: footerY, size: 8, font, color: GRAY });
  // The cover page can't know its final position in the merged document -
  // mergeWithBillFile may append any number of pages from a multi-page PDF
  // bill (not always exactly one more), or none at all in the Fall-B
  // standalone-page case - so it never claims a specific "Seite X von N";
  // it only states whether an attachment follows this page at all.
  if (options.attachmentFollows) {
    const footerRight = "Anlage: Originalrechnung";
    page.drawText(footerRight, { x: width - MARGIN - font.widthOfTextAtSize(footerRight, 8), y: footerY, size: 8, font, color: GRAY });
  }

  return doc.save();
}

export type BillFileType = "pdf" | "png" | "jpeg";

// Appends the bill (all pages, for a PDF; one full page, for an image) after
// the cover page - the "Fall A" merge path. For "Fall B" (bill already in
// BuchhaltungsButler), the caller uploads the cover page alone via
// upload_receipt's link_to_receipt_id_by_customer instead of calling this.
export async function mergeWithBillFile(
  coverPdfBytes: Uint8Array,
  billFile: string,
  billFileType: BillFileType
): Promise<Uint8Array> {
  const coverDoc = await PDFDocument.load(coverPdfBytes);
  const billBytes = Buffer.from(billFile, "base64");

  if (billFileType === "pdf") {
    const billDoc = await PDFDocument.load(billBytes);
    const copiedPages = await coverDoc.copyPages(billDoc, billDoc.getPageIndices());
    for (const copiedPage of copiedPages) {
      coverDoc.addPage(copiedPage);
    }
  } else {
    const image = billFileType === "png" ? await coverDoc.embedPng(billBytes) : await coverDoc.embedJpg(billBytes);
    const [pageWidth, pageHeight] = PageSizes.A4;
    const page = coverDoc.addPage(PageSizes.A4);
    const maxWidth = pageWidth - 2 * MARGIN;
    const maxHeight = pageHeight - 2 * MARGIN;
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    page.drawImage(image, {
      x: (pageWidth - drawWidth) / 2,
      y: (pageHeight - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }

  return coverDoc.save();
}
