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
  participants: string;
  hostName: string;
  hostRole?: string;
  companyName?: string;
  companyAddress?: string;
  receiptNumber?: string;
  billReference?: string;
}

const MARGIN = 56;
const BLACK = rgb(0.1, 0.1, 0.1);
const GRAY = rgb(0.46, 0.46, 0.46);
const LIGHT_RULE = rgb(0.85, 0.85, 0.85);

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
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

// Renders the Variante-B "Bewirtungsangaben" cover page (letterhead, bordered
// info table, Aufteilung/Bestätigung boxes, footer) as a standalone one-page
// A4 PDF - the caller merges or links it with the original bill afterwards.
export async function renderEntertainmentReceiptCover(
  fields: EntertainmentReceiptFields,
  amounts: ComputedAmounts,
  options: { kleinunternehmer: boolean }
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(PageSizes.A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [width, height] = PageSizes.A4;
  const contentWidth = width - 2 * MARGIN;

  let y = height - MARGIN;

  // Letterhead
  page.drawText(fields.companyName ?? "[Firmenname]", { x: MARGIN, y, size: 12, font: bold, color: BLACK });
  const title = "Bewirtungsangaben";
  page.drawText(title, { x: width - MARGIN - bold.widthOfTextAtSize(title, 12), y, size: 12, font: bold, color: BLACK });
  y -= 15;
  page.drawText(fields.companyAddress ?? "[Straße Nr., PLZ Ort]", { x: MARGIN, y, size: 9, font, color: GRAY });
  const sub = `Ergänzung zur Rechnung ${fields.billReference ?? "-"} gem. § 4 Abs. 5 Satz 1 Nr. 2 EStG`;
  page.drawText(sub, { x: width - MARGIN - font.widthOfTextAtSize(sub, 9), y, size: 9, font, color: GRAY });
  y -= 12;
  if (fields.receiptNumber) {
    const nr = `Nr. ${fields.receiptNumber}`;
    page.drawText(nr, { x: width - MARGIN - font.widthOfTextAtSize(nr, 9), y, size: 9, font, color: GRAY });
  }
  y -= 14;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: width - MARGIN, y }, thickness: 1.5, color: BLACK });
  y -= 22;

  // Bordered info table
  const amountText = [
    `Gesamtbetrag: ${amounts.grossTotal.toFixed(2)} €`,
    options.kleinunternehmer ? "" : `davon Vorsteuer (100 % abziehbar): ${amounts.vatTotal.toFixed(2)} €`,
  ]
    .filter(Boolean)
    .join("  ·  ");
  const rows: Array<[string, string]> = [
    ["Datum", fields.date],
    ["Ort der Bewirtung", fields.location],
    ["Anlass", fields.occasion],
    ["Teilnehmer", fields.participants],
    ["Rechnungsbetrag", amountText],
  ];
  const tableTop = y;
  for (const [label, value] of rows) {
    const lines = wrapText(value, font, 10, contentWidth - 160);
    page.drawText(label, { x: MARGIN + 8, y, size: 9, font, color: GRAY });
    lines.forEach((line, i) => {
      page.drawText(line, { x: MARGIN + 168, y: y - i * 13, size: 10, font, color: BLACK });
    });
    y -= Math.max(26, lines.length * 13 + 12);
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

  // Aufteilung / Bestätigung boxes
  const boxWidth = (contentWidth - 16) / 2;
  const boxHeight = 78;
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
  page.drawText("Steuerliche Aufteilung", { x: MARGIN + 10, y: boxTop - 16, size: 9, font, color: GRAY });
  page.drawText(
    `Abziehbar (70 %${options.kleinunternehmer ? " v. Brutto" : " v. Netto"}): ${amounts.deductible.toFixed(2)} €`,
    { x: MARGIN + 10, y: boxTop - 34, size: 10, font, color: BLACK }
  );
  page.drawText(`Nicht abziehbar (30 %): ${amounts.nonDeductible.toFixed(2)} €`, {
    x: MARGIN + 10,
    y: boxTop - 48,
    size: 10,
    font,
    color: BLACK,
  });

  const confirmX = MARGIN + boxWidth + 26;
  page.drawText("Bestätigung", { x: confirmX, y: boxTop - 16, size: 9, font, color: GRAY });
  page.drawText(`${fields.hostName}${fields.hostRole ? `, ${fields.hostRole}` : ""}`, {
    x: confirmX,
    y: boxTop - 34,
    size: 10,
    font,
    color: BLACK,
  });
  page.drawText(`Elektronisch bestätigt: ${fields.date}`, { x: confirmX, y: boxTop - 48, size: 9, font, color: GRAY });
  page.drawText("gem. § 4 Abs. 5 Nr. 2 EStG, BMF v. 30.06.2021 - Unterschrift entbehrlich", {
    x: confirmX,
    y: boxTop - 60,
    size: 8,
    font,
    color: GRAY,
  });

  // Footer
  const footerY = MARGIN - 10;
  page.drawLine({ start: { x: MARGIN, y: footerY + 14 }, end: { x: width - MARGIN, y: footerY + 14 }, thickness: 0.5, color: LIGHT_RULE });
  page.drawText(fields.companyName ?? "[Firmenname]", { x: MARGIN, y: footerY, size: 8, font, color: GRAY });
  const footerRight = "Seite 1 von 2 · Anlage: Originalrechnung";
  page.drawText(footerRight, { x: width - MARGIN - font.widthOfTextAtSize(footerRight, 8), y: footerY, size: 8, font, color: GRAY });

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
