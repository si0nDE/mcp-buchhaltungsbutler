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

// Labels for the 70/30 split strip. Expressed as a decimal factor ("Faktor
// 0,70") rather than "70 %" next to a Euro amount - this page is uploaded and
// OCR-scanned by the receiving accounting system as if it were an independent
// invoice, and a bare "NN %" next to a total is a plausible (unconfirmed)
// source of it misreading the number as a VAT rate. Cheap to avoid even
// without proof it's the cause. The amount itself is drawn separately, below
// its label, so the two never share a text run.
export function buildDeductibleLabel(kleinunternehmer: boolean): string {
  return `Abziehbar (Faktor 0,70 v. ${kleinunternehmer ? "Brutto" : "Netto"})`;
}

export function buildNonDeductibleLabel(): string {
  return "Nicht abziehbar (Faktor 0,30)";
}

export interface AmountTableRow {
  label: string;
  // Absent for Kleinunternehmer, who has no separate net/USt split.
  net?: string;
  vat?: string;
  gross: string;
}

export interface AmountTable {
  hasVatColumns: boolean;
  rows: AmountTableRow[];
  total: AmountTableRow;
  // Absent for Kleinunternehmer (no Vorsteuerabzug).
  vatNote?: { label: string; amount: string };
}

// Itemizes Speisen/Getränke/Trinkgeld instead of only the aggregate total, so
// the amount is traceable against the original invoice without needing the
// invoice itself at hand. Regelbesteuerung shows each item's net + USt +
// gross (matching how it's printed on the restaurant bill); Kleinunternehmer
// shows gross-only per item, consistent with computeAmounts splitting on the
// gross base for them. The tip carries no USt, so it contributes to net and
// gross alike (and the net total, which is the 70/30 base).
export function buildAmountTable(
  input: Pick<EntertainmentReceiptAmounts, "foodNet" | "foodVat" | "drinksNet" | "drinksVat" | "tip">,
  computed: ComputedAmounts,
  kleinunternehmer: boolean
): AmountTable {
  const foodGross = round2(input.foodNet + input.foodVat);
  const drinksGross = round2(input.drinksNet + input.drinksVat);
  const withVat = (label: string, net: number, vat: number, gross: number): AmountTableRow =>
    kleinunternehmer
      ? { label, gross: formatEuro(gross) }
      : { label, net: formatEuro(net), vat: formatEuro(vat), gross: formatEuro(gross) };

  const rows: AmountTableRow[] = [];
  if (foodGross > 0) rows.push(withVat("Speisen", input.foodNet, input.foodVat, foodGross));
  if (drinksGross > 0) rows.push(withVat("Getränke", input.drinksNet, input.drinksVat, drinksGross));
  if (input.tip > 0) {
    rows.push(
      kleinunternehmer
        ? { label: "Trinkgeld", gross: formatEuro(input.tip) }
        : { label: "Trinkgeld", net: formatEuro(input.tip), vat: "-", gross: formatEuro(input.tip) }
    );
  }

  const netTotal = round2(input.foodNet + input.drinksNet + input.tip);
  return {
    hasVatColumns: !kleinunternehmer,
    rows,
    total: withVat("Gesamtbetrag", netTotal, computed.vatTotal, computed.grossTotal),
    vatNote: kleinunternehmer ? undefined : { label: "davon Vorsteuer (100 % abziehbar)", amount: formatEuro(computed.vatTotal) },
  };
}

// "07.10.2026, 09:41 Uhr" in Europe/Berlin, regardless of the server's own
// time zone (the Docker image typically runs in UTC).
export function formatConfirmationTimestamp(date: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  return `${parts.day}.${parts.month}.${parts.year}, ${parts.hour}:${parts.minute} Uhr`;
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
const LIGHT_RULE = rgb(0.82, 0.82, 0.82);
const PANEL = rgb(0.955, 0.955, 0.955);
// Minimum horizontal gap, in points, kept between a letterhead line's
// left-aligned text (companyName/companyAddress) and its right-aligned
// counterpart (title/sub) once both are measured at their actual rendered
// width. Exported so tests can reconstruct the same bound independently.
export const LETTERHEAD_GAP = 16;

// Section values are drawn at MARGIN + TABLE_VALUE_X_OFFSET, so their wrap
// width must be measured from that same offset to the right content edge -
// not from a separately-maintained magic number, which previously drifted
// out of sync and let wrapped lines overflow the right edge.
export const TABLE_VALUE_X_OFFSET = 150;
export const TABLE_ROW_LINE_HEIGHT = 15;
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

// Puts the restaurant name on its own line(s), with the address below it, so
// name and address read as two distinct things. `location` is free text
// ("Name, Straße Nr., PLZ Ort"), so the split is at the FIRST comma: what
// precedes it is the name, the rest is the address. The separating comma is
// dropped (the line break replaces it). Without any comma there is nothing
// to separate, and the text is wrapped as plain address text.
export function formatLocationLines(location: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const commaIndex = location.indexOf(",");
  if (commaIndex === -1) return wrapAddressText(location, font, size, maxWidth);
  const name = location.slice(0, commaIndex).trim();
  const address = location.slice(commaIndex + 1).trim();
  if (!name || !address) return wrapAddressText(location.replace(/^,|,$/g, "").trim(), font, size, maxWidth);
  return [...wrapText(name, font, size, maxWidth), ...wrapAddressText(address, font, size, maxWidth)];
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

// Renders the "Bewirtungsangaben" cover page as a standalone one-page A4 PDF
// (letterhead, title, the five numbered Pflichtangaben of § 4 Abs. 5 Satz 1
// Nr. 2 EStG, a highlighted Aufteilung strip, the Bestätigung, footer) - the
// caller merges or links it with the original bill afterwards. Separators sit
// in the padding BETWEEN rows, never at a row's own text baseline, so no
// rule can strike through a label or value.
export async function renderEntertainmentReceiptCover(
  fields: EntertainmentReceiptFields,
  amounts: ComputedAmounts,
  options: { kleinunternehmer: boolean; attachmentFollows?: boolean; confirmedAt?: Date }
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(PageSizes.A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [width, height] = PageSizes.A4;
  const contentWidth = width - 2 * MARGIN;
  const valueX = MARGIN + TABLE_VALUE_X_OFFSET;
  const valueMaxWidth = tableValueMaxWidth(contentWidth);

  const drawRight = (text: string, rightX: number, y: number, size: number, f: PDFFont, color = BLACK) =>
    page.drawText(text, { x: rightX - f.widthOfTextAtSize(text, size), y, size, font: f, color });
  const rule = (y: number) =>
    page.drawLine({ start: { x: MARGIN, y }, end: { x: width - MARGIN, y }, thickness: 0.6, color: LIGHT_RULE });

  let y = height - MARGIN;

  // Letterhead - companyName sits on the same line as the right-aligned
  // subtitle, whose own width varies with billReference. A fixed split
  // doesn't bound the right side (a long billReference widens it), so the
  // left text is clamped to whatever's left after the ACTUAL rendered width
  // of the right text plus a fixed gap, from the same font metrics used to
  // draw it. The address line has no right-hand counterpart.
  const sub = buildLetterheadSubtitle(fields.billReference);
  const subWidth = font.widthOfTextAtSize(sub, 9);
  const companyNameMaxWidth = Math.max(0, contentWidth - subWidth - LETTERHEAD_GAP);
  const companyNameLine = wrapText(fields.companyName ?? "[Firmenname]", bold, 10, companyNameMaxWidth)[0] ?? "";
  page.drawText(companyNameLine, { x: MARGIN, y, size: 10, font: bold, color: BLACK });
  drawRight(sub, width - MARGIN, y, 9, font, GRAY);
  y -= 13;
  const companyAddressLine = wrapText(fields.companyAddress ?? "[Straße Nr., PLZ Ort]", font, 9, contentWidth)[0] ?? "";
  page.drawText(companyAddressLine, { x: MARGIN, y, size: 9, font, color: GRAY });

  // Title
  y -= 46;
  page.drawText("Bewirtungsangaben", { x: MARGIN, y, size: 24, font: bold, color: BLACK });
  y -= 18;
  page.drawText("Angaben nach § 4 Abs. 5 Satz 1 Nr. 2 EStG", { x: MARGIN, y, size: 9.5, font, color: GRAY });
  y -= 14;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: width - MARGIN, y }, thickness: 2, color: BLACK });
  y -= 6;

  const ROW_PAD = 14;
  const drawSectionHead = (num: string, label: string) => {
    page.drawText(num, { x: MARGIN, y, size: 10, font: bold, color: GRAY });
    page.drawText(label, { x: MARGIN + 16, y, size: 9.5, font: bold, color: BLACK });
  };

  // Sections 1-4: label left, wrapped value lines right.
  const participantLines = fields.participants.map(formatParticipantLine);
  const textSections: Array<{ num: string; label: string; lines: string[] }> = [
    { num: "1", label: "Ort der Bewirtung", lines: formatLocationLines(fields.location, font, 10.5, valueMaxWidth) },
    { num: "2", label: "Tag der Bewirtung", lines: wrapText(fields.date, font, 10.5, valueMaxWidth) },
    { num: "3", label: "Teilnehmer", lines: participantLines.flatMap((entry) => wrapText(entry, font, 10.5, valueMaxWidth)) },
    { num: "4", label: "Anlass", lines: wrapText(fields.occasion, font, 10.5, valueMaxWidth) },
  ];
  for (const { num, label, lines } of textSections) {
    y -= ROW_PAD + 8;
    drawSectionHead(num, label);
    lines.forEach((line, i) => {
      page.drawText(line, { x: valueX, y: y - i * TABLE_ROW_LINE_HEIGHT, size: 10.5, font, color: BLACK });
    });
    y -= (lines.length - 1) * TABLE_ROW_LINE_HEIGHT + ROW_PAD - 4;
    rule(y);
  }

  // Section 5: Aufwendungen as a right-aligned table.
  const table = buildAmountTable(fields, amounts, options.kleinunternehmer);
  const grossX = width - MARGIN;
  const vatX = grossX - 80;
  const netX = vatX - 75;
  y -= ROW_PAD + 8;
  drawSectionHead("5", "Aufwendungen");
  page.drawText("Position", { x: valueX, y, size: 8.5, font, color: GRAY });
  if (table.hasVatColumns) {
    drawRight("Netto", netX, y, 8.5, font, GRAY);
    drawRight("USt", vatX, y, 8.5, font, GRAY);
  }
  drawRight("Brutto", grossX, y, 8.5, font, GRAY);
  y -= 8;
  page.drawLine({ start: { x: valueX, y }, end: { x: grossX, y }, thickness: 0.6, color: LIGHT_RULE });
  const drawTableRow = (row: AmountTableRow, f: PDFFont) => {
    page.drawText(row.label, { x: valueX, y, size: 10.5, font: f, color: BLACK });
    if (row.net !== undefined) drawRight(row.net, netX, y, 10.5, f);
    if (row.vat !== undefined) drawRight(row.vat, vatX, y, 10.5, f);
    drawRight(row.gross, grossX, y, 10.5, f);
  };
  for (const row of table.rows) {
    y -= 15;
    drawTableRow(row, font);
  }
  y -= 7;
  page.drawLine({ start: { x: valueX, y }, end: { x: grossX, y }, thickness: 0.8, color: BLACK });
  y -= 15;
  drawTableRow(table.total, bold);
  if (table.vatNote) {
    y -= 15;
    page.drawText(table.vatNote.label, { x: valueX, y, size: 9.5, font, color: GRAY });
    drawRight(table.vatNote.amount, grossX, y, 9.5, font, GRAY);
  }
  y -= ROW_PAD;
  rule(y);

  // Aufteilung strip - the result of the 70/30 split, made the most
  // prominent element on the page.
  y -= 22;
  const stripHeight = 62;
  page.drawRectangle({ x: MARGIN, y: y - stripHeight, width: contentWidth, height: stripHeight, color: PANEL });
  page.drawRectangle({ x: MARGIN, y: y - stripHeight, width: 3, height: stripHeight, color: BLACK });
  page.drawText("Steuerliche Aufteilung", { x: MARGIN + 16, y: y - 15, size: 8.5, font, color: GRAY });
  const secondColX = MARGIN + contentWidth / 2 + 10;
  page.drawText(buildDeductibleLabel(options.kleinunternehmer), { x: MARGIN + 16, y: y - 32, size: 9.5, font, color: BLACK });
  page.drawText(formatEuro(amounts.deductible), { x: MARGIN + 16, y: y - 50, size: 14, font: bold, color: BLACK });
  page.drawText(buildNonDeductibleLabel(), { x: secondColX, y: y - 32, size: 9.5, font, color: BLACK });
  page.drawText(formatEuro(amounts.nonDeductible), { x: secondColX, y: y - 50, size: 14, font: bold, color: BLACK });
  y -= stripHeight + 22;

  // Bestätigung - hostName/hostRole and the disclaimer are wrapped instead
  // of drawn unbroken, so a long hostRole can't run off the page.
  page.drawText("Bestätigung", { x: MARGIN, y, size: 8.5, font, color: GRAY });
  const hostLines = buildHostConfirmationLines(fields.hostName, fields.hostRole, font, 10.5, contentWidth);
  const hostNameLineCount = wrapText(fields.hostName, font, 10.5, contentWidth).length;
  y -= 3;
  hostLines.forEach((line, i) => {
    y -= 14;
    const isName = i < hostNameLineCount;
    page.drawText(line, { x: MARGIN, y, size: 10.5, font: isName ? bold : font, color: isName ? BLACK : GRAY });
  });
  y -= 15;
  const confirmedAt = formatConfirmationTimestamp(options.confirmedAt ?? new Date());
  page.drawText(`Elektronisch bestätigt: ${confirmedAt}`, { x: MARGIN, y, size: 9.5, font, color: BLACK });
  for (const line of wrapText(buildConfirmationDisclaimer(), font, 8.5, contentWidth)) {
    y -= 13;
    page.drawText(line, { x: MARGIN, y, size: 8.5, font, color: GRAY });
  }

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
    drawRight("Anlage: Originalrechnung", width - MARGIN, footerY, 8, font, GRAY);
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
