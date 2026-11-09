import { PDFDocument, PageSizes, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { BLACK, formatEuro, GRAY, LIGHT_RULE, MARGIN, PANEL, wrapText } from "./entertainment-receipt-pdf.js";
import type { BusinessPosition, MixedReceiptAmounts } from "./mixed-receipt-calc.js";

export interface MixedReceiptSheet {
  companyName: string;
  companyAddress: string;
  merchantName: string;
  merchantAddress: string;
  receiptNumber: string;
  receiptDate: string; // TT.MM.JJJJ
  receiptTime?: string; // HH:MM
  receiptTotal: number;
  paymentMethod?: string;
  paidBy: string;
  occasion: string;
  positions: BusinessPosition[];
  amounts: MixedReceiptAmounts;
  originalDisplayRef: string;
  originalSha256: string;
  confirmation?: { name: string; date: string }; // date TT.MM.JJJJ
}

export const MIN_BON_SCALE = 0.5;
export const MAX_BON_WIDTH = 160;
const BON_GAP = 22;
const FOOTER_TOP = MARGIN + 24; // lowest y for content; footer rule sits at MARGIN + 4

export class SheetOverflowError extends Error {
  constructor() {
    super(
      "Der Auslagenbeleg passt nicht auf eine Seite (zu viele Positionen oder ein sehr langer Anlass). " +
        "Positionen zusammenfassen (z. B. 'Milch, 3 Packungen') oder den Anlass kürzen. Es wurde nichts erzeugt."
    );
    this.name = "SheetOverflowError";
  }
}

export async function renderMixedReceiptPdf(sheet: MixedReceiptSheet, redactedScanPdf: Uint8Array): Promise<{ pdf: Uint8Array; bonOnSecondPage: boolean }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage(PageSizes.A4);
  const [width, height] = PageSizes.A4;
  const right = (p: PDFPage, text: string, rx: number, y: number, size: number, f: PDFFont, color = BLACK) =>
    p.drawText(text, { x: rx - f.widthOfTextAtSize(text, size), y, size, font: f, color });

  // Letterhead and title, as on the Bewirtungsseite
  let y = height - MARGIN;
  const subtitle = `Aufteilung zu Bon-Nr. ${sheet.receiptNumber} vom ${sheet.receiptDate}`;
  const companyWidth = width - 2 * MARGIN - font.widthOfTextAtSize(subtitle, 9) - 16;
  page.drawText(wrapText(sheet.companyName, bold, 10, Math.max(0, companyWidth))[0] ?? "", { x: MARGIN, y, size: 10, font: bold, color: BLACK });
  right(page, subtitle, width - MARGIN, y, 9, font, GRAY);
  y -= 13;
  page.drawText(sheet.companyAddress, { x: MARGIN, y, size: 9, font, color: GRAY });
  y -= 46;
  page.drawText("Auslagenbeleg", { x: MARGIN, y, size: 24, font: bold, color: BLACK });
  y -= 18;
  page.drawText("Geschäftlicher Anteil eines gemischten Einkaufs (privat verauslagt)", { x: MARGIN, y, size: 9.5, font, color: GRAY });
  y -= 14;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: width - MARGIN, y }, thickness: 2, color: BLACK });
  const topY = y - 16;

  // Receipt: left column, or page 2 when it would shrink below MIN_BON_SCALE
  const [bon] = await doc.embedPdf(redactedScanPdf);
  const scale = Math.min((topY - FOOTER_TOP) / bon.height, MAX_BON_WIDTH / bon.width);
  const bonOnSecondPage = scale < MIN_BON_SCALE;
  let X = MARGIN;
  if (!bonOnSecondPage) {
    const bw = bon.width * scale;
    const bh = bon.height * scale;
    page.drawPage(bon, { x: MARGIN, y: topY - bh, xScale: scale, yScale: scale });
    page.drawRectangle({ x: MARGIN, y: topY - bh, width: bw, height: bh, borderColor: LIGHT_RULE, borderWidth: 0.6 });
    page.drawText("Geschwärzte Kopie", { x: MARGIN, y: topY - bh - 11, size: 7.5, font, color: GRAY });
    X = MARGIN + bw + BON_GAP;
  } else {
    const p2 = doc.addPage(PageSizes.A4);
    const s2 = Math.min((height - 2 * MARGIN - 30) / bon.height, (width - 2 * MARGIN) / bon.width);
    const bw = bon.width * s2;
    const bh = bon.height * s2;
    const bx = (width - bw) / 2;
    p2.drawText(`Geschwärzte Kopie des Kassenbons (Original: ${sheet.originalDisplayRef})`, { x: MARGIN, y: height - MARGIN, size: 8, font, color: GRAY });
    p2.drawPage(bon, { x: bx, y: height - MARGIN - 16 - bh, xScale: s2, yScale: s2 });
    p2.drawRectangle({ x: bx, y: height - MARGIN - 16 - bh, width: bw, height: bh, borderColor: LIGHT_RULE, borderWidth: 0.6 });
  }

  // Right column (full width when the receipt is on page 2)
  const R = width - MARGIN;
  const colWidth = R - X;
  const VX = X + 92;
  y = topY - 6;
  const need = (h: number) => {
    if (y - h < FOOTER_TOP) throw new SheetOverflowError();
  };
  const rule = () => page.drawLine({ start: { x: X, y: y + 4 }, end: { x: R, y: y + 4 }, thickness: 0.6, color: LIGHT_RULE });
  const section = (num: string, label: string, values: string[]) => {
    const lines = values.flatMap((v, i) => wrapText(v, i === 0 ? bold : font, 10, R - VX).map((l) => ({ l, first: i === 0 })));
    need(lines.length * 14 + 18);
    page.drawText(num, { x: X, y, size: 10, font: bold, color: GRAY });
    page.drawText(label, { x: X + 16, y, size: 9.5, font: bold, color: BLACK });
    lines.forEach(({ l, first }, i) => page.drawText(l, { x: VX, y: y - i * 14, size: 10, font: first ? bold : font, color: BLACK }));
    y -= Math.max(1, lines.length) * 14 + 10;
    rule();
    y -= 8;
  };
  const when = sheet.receiptTime ? `${sheet.receiptDate}, ${sheet.receiptTime} Uhr` : sheet.receiptDate;
  section("1", "Händler", [sheet.merchantName, sheet.merchantAddress]);
  section("2", "Kassenbon", [
    `Bon-Nr. ${sheet.receiptNumber}`,
    when,
    `Summe ${formatEuro(sheet.receiptTotal)}${sheet.paymentMethod ? `, ${sheet.paymentMethod}` : ""}`,
  ]);
  section("3", "Ausgelegt von", [sheet.paidBy, "privat bezahlt, Erstattung durch die Gesellschaft"]);
  section("4", "Anlass", [sheet.occasion]);

  // 5 Business positions
  need(18 + 19);
  page.drawText("5", { x: X, y, size: 10, font: bold, color: GRAY });
  page.drawText("Geschäftliche Positionen", { x: X + 16, y, size: 9.5, font: bold, color: BLACK });
  y -= 18;
  const qtyX = X + colWidth * 0.38;
  const vatX = X + colWidth * 0.64;
  page.drawText("Position", { x: X, y, size: 8.5, font, color: GRAY });
  page.drawText("Menge × Preis", { x: qtyX, y, size: 8.5, font, color: GRAY });
  page.drawText("USt", { x: vatX, y, size: 8.5, font, color: GRAY });
  right(page, "Brutto", R, y, 8.5, font, GRAY);
  y -= 6;
  page.drawLine({ start: { x: X, y }, end: { x: R, y }, thickness: 0.6, color: LIGHT_RULE });
  y -= 13;
  for (const p of sheet.positions) {
    const desc = wrapText(p.description, font, 10, qtyX - X - 6);
    need(desc.length * 13);
    desc.forEach((l, i) => page.drawText(l, { x: X, y: y - i * 13, size: 10, font, color: BLACK }));
    if (p.quantity_text) page.drawText(wrapText(p.quantity_text, font, 10, vatX - qtyX - 6)[0] ?? "", { x: qtyX, y, size: 10, font, color: BLACK });
    page.drawText(`${p.vat_rate} %`, { x: vatX, y, size: 10, font, color: BLACK });
    right(page, formatEuro(p.gross), R, y, 10, font);
    y -= desc.length * 13 + 2;
  }
  y -= 4;
  page.drawLine({ start: { x: X, y: y + 8 }, end: { x: R, y: y + 8 }, thickness: 0.8, color: BLACK });
  y -= 6;
  for (const r of sheet.amounts.rates) {
    need(14);
    page.drawText(`Summe ${r.vat_rate} %`, { x: X, y, size: 9.5, font, color: GRAY });
    page.drawText(`Netto ${formatEuro(r.net)} / Steuer ${formatEuro(r.vat)}`, { x: qtyX, y, size: 9.5, font, color: GRAY });
    right(page, formatEuro(r.gross), R, y, 10, bold);
    y -= 14;
  }
  y -= 12;

  // Result panel
  const panelHeight = 62;
  need(panelHeight + 16);
  page.drawRectangle({ x: X, y: y - panelHeight, width: colWidth, height: panelHeight, color: PANEL });
  page.drawRectangle({ x: X, y: y - panelHeight, width: 3, height: panelHeight, color: BLACK });
  page.drawText("Ergebnis", { x: X + 16, y: y - 15, size: 8.5, font, color: GRAY });
  const c2 = X + colWidth / 2 + 6;
  page.drawText(wrapText(`Erstattung an ${sheet.paidBy}`, font, 9.5, c2 - X - 22)[0] ?? "", { x: X + 16, y: y - 32, size: 9.5, font, color: BLACK });
  page.drawText(formatEuro(sheet.amounts.reimbursement), { x: X + 16, y: y - 50, size: 14, font: bold, color: BLACK });
  page.drawText("Vorsteuer (§ 35 UStDV)", { x: c2, y: y - 32, size: 9.5, font, color: BLACK });
  page.drawText(formatEuro(sheet.amounts.inputVatTotal), { x: c2, y: y - 50, size: 14, font: bold, color: BLACK });
  y -= panelHeight + 16;
  const check = wrapText(
    `Abgleich: Bon gesamt ${formatEuro(sheet.receiptTotal)} · davon geschäftlich ${formatEuro(sheet.amounts.reimbursement)} · privat ${formatEuro(sheet.amounts.privateGross)} (geschwärzt)`,
    font,
    7.5,
    colWidth
  );
  need(check.length * 10 + 14);
  check.forEach((l, i) => page.drawText(l, { x: X, y: y - i * 10, size: 7.5, font, color: GRAY }));
  y -= check.length * 10 + 14;

  // Hint on the original (true because the tool loaded it from BuchhaltungsButler)
  const hint = wrapText(
    `Private Positionen sind in der Kopie unkenntlich gemacht. Das Original ist unverändert in BuchhaltungsButler archiviert: ${sheet.originalDisplayRef}.`,
    font,
    9.5,
    colWidth
  );
  need(14 + hint.length * 13 + 14);
  page.drawText("Hinweis", { x: X, y, size: 8.5, font, color: GRAY });
  y -= 14;
  hint.forEach((l, i) => page.drawText(l, { x: X, y: y - i * 13, size: 9.5, font, color: BLACK }));
  y -= hint.length * 13 + 14;

  // Confirmation: only what the paying person actually confirmed
  need(14 + 14 + 14);
  page.drawText("Bestätigung", { x: X, y, size: 8.5, font, color: GRAY });
  y -= 14;
  page.drawText(sheet.confirmation?.name ?? sheet.paidBy, { x: X, y, size: 10.5, font: bold, color: BLACK });
  y -= 14;
  if (sheet.confirmation) page.drawText(`Elektronisch bestätigt: ${sheet.confirmation.date}`, { x: X, y, size: 9.5, font, color: BLACK });
  else page.drawText("Bestätigung ausstehend", { x: X, y, size: 9.5, font, color: GRAY });

  // Footer
  const fy = MARGIN - 10;
  page.drawLine({ start: { x: MARGIN, y: fy + 14 }, end: { x: width - MARGIN, y: fy + 14 }, thickness: 0.5, color: LIGHT_RULE });
  page.drawText(sheet.companyName, { x: MARGIN, y: fy, size: 8, font, color: GRAY });
  right(page, bonOnSecondPage ? "Seite 2: geschwärzte Kopie des Kassenbons" : "Links: geschwärzte Kopie des Kassenbons", width - MARGIN, fy, 8, font, GRAY);
  page.drawText(`SHA-256 Originaldokument: ${sheet.originalSha256}`, { x: MARGIN, y: fy - 11, size: 6.5, font, color: GRAY });

  return { pdf: await doc.save(), bonOnSecondPage };
}
