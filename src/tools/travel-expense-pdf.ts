import { PDFDocument, PageSizes, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { DayResult, LodgingFlatLine, RateTableInfo, TravellerType } from "./travel-expense-calc.js";
import type { CostLine, KmLine, Totals } from "./travel-expense-costs.js";
import {
  formatConfirmationTimestamp,
  formatEuro,
  mergeWithBillFile,
  MARGIN,
  wrapText,
  type BillFileType,
} from "./entertainment-receipt-pdf.js";

export interface TravelReportData {
  companyName?: string;
  companyAddress?: string;
  reportNumber?: string;
  travellerName: string;
  travellerType: TravellerType;
  purpose: string;
  departure: string;
  returnTime: string;
  route: string[];
  days: DayResult[];
  lodgingFlat: LodgingFlatLine[];
  costs: CostLine[];
  kmLines: KmLine[];
  totals: Totals;
  warnings: string[];
  sources: string[];
  /** Foreign rate tables used per year; provisional ones get a banner on page 1. */
  rateTables?: RateTableInfo[];
}

const BLACK = rgb(0.1, 0.1, 0.1);
const GRAY = rgb(0.46, 0.46, 0.46);
const RULE = rgb(0.82, 0.82, 0.82);
const PANEL = rgb(0.955, 0.955, 0.955);
const ALERT = rgb(0.62, 0.08, 0.08);
const ALERT_PANEL = rgb(0.99, 0.92, 0.92);

// Latin-1 plus the Windows-1252 extras used in German text (€, „ “ ” ‘ ’ – — … •).
const ALLOWED = new Set<number>([
  ...Array.from({ length: 0x5f }, (_, i) => 0x20 + i),
  ...Array.from({ length: 0x60 }, (_, i) => 0xa0 + i),
  0x20ac, 0x201e, 0x201c, 0x201d, 0x2018, 0x2019, 0x2013, 0x2014, 0x2026, 0x2022,
]);

// pdf-lib's standard fonts only encode WinAnsi: anything else throws while drawing. Replace instead of crashing.
export function toWinAnsi(text: string): string {
  return [...text.normalize("NFC").replace(/[\n\r\t]+/g, " ")].map((char) => (ALLOWED.has(char.codePointAt(0) ?? 0) ? char : "?")).join("");
}

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const formatDate = (iso: string): string =>
  ISO_PATTERN.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso;
const formatDateTime = (iso: string): string => {
  if (!ISO_PATTERN.test(iso)) return iso;
  return iso.length > 10 ? `${formatDate(iso)} ${iso.slice(11, 16)}` : formatDate(iso);
};
const euro = (value: number): string => formatEuro(value).replace(" €", "");

const LEGAL_BASIS: Record<TravellerType, string> = {
  employee: "Erstattung durch den Arbeitgeber, § 3 Nr. 16 und § 9 Abs. 4a EStG, R 9.4 ff. LStR",
  self_employed: "Betriebsausgabe, § 4 Abs. 5 Satz 1 Nr. 5 EStG i. V. m. § 9 Abs. 4a EStG, R 4.12 EStR",
};
const FOOTER_BASIS: Record<TravellerType, string> = {
  employee: "Rechtsgrundlagen: § 9 Abs. 4a EStG; BMF 25.11.2020 und 05.12.2025",
  self_employed: "Rechtsgrundlagen: § 4 Abs. 5 Satz 1 Nr. 5, § 9 Abs. 4a EStG; BMF 25.11.2020 und 05.12.2025",
};
const TRAVELLER_LABEL: Record<TravellerType, string> = {
  employee: "Arbeitnehmer/in",
  self_employed: "Selbstständig bzw. Gesellschafter-Geschäftsführung ohne Anstellungsvertrag",
};

export async function renderTravelExpenseReport(
  data: TravelReportData,
  options: { confirmedAt?: Date } = {}
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [width, height] = PageSizes.A4;
  const contentWidth = width - 2 * MARGIN;
  const rightX = width - MARGIN;
  const FOOTER_SPACE = 34;

  let page: PDFPage = doc.addPage(PageSizes.A4);
  let y = height - MARGIN;

  const draw = (text: string, x: number, size: number, f: PDFFont = font, color = BLACK) =>
    page.drawText(toWinAnsi(text), { x, y, size, font: f, color });
  const drawRight = (text: string, x: number, size: number, f: PDFFont = font, color = BLACK) => {
    const safe = toWinAnsi(text);
    page.drawText(safe, { x: x - f.widthOfTextAtSize(safe, size), y, size, font: f, color });
  };
  const rule = (at: number, thickness = 0.6, color = RULE) =>
    page.drawLine({ start: { x: MARGIN, y: at }, end: { x: rightX, y: at }, thickness, color });
  const newPage = () => {
    page = doc.addPage(PageSizes.A4);
    y = height - MARGIN;
  };
  const ensure = (needed: number) => {
    if (y - needed < MARGIN + FOOTER_SPACE) newPage();
  };
  const lines = (text: string, size: number, maxWidth: number, f: PDFFont = font) =>
    wrapText(toWinAnsi(text), f, size, maxWidth);

  // Letterhead
  draw(data.companyName ?? "[Firmenname]", MARGIN, 10, bold);
  drawRight(data.reportNumber ? `Reisekostenabrechnung Nr. ${data.reportNumber}` : "Reisekostenabrechnung", rightX, 9, font, GRAY);
  y -= 13;
  draw(data.companyAddress ?? "[Straße Nr., PLZ Ort]", MARGIN, 9, font, GRAY);
  y -= 46;
  draw("Reisekostenabrechnung", MARGIN, 24, bold);
  y -= 18;
  draw(LEGAL_BASIS[data.travellerType], MARGIN, 9, font, GRAY);
  y -= 12;
  rule(y, 2, BLACK);
  y -= 8;

  // Provisional foreign rates must be visible at first sight, not only on the notes page.
  for (const t of (data.rateTables ?? []).filter((r) => r.origin === "provisional")) {
    const banner = lines(
      `VORLÄUFIG: Auslandssätze mit der Tabelle ${t.provisionalFrom} berechnet, BMF-Tabelle ${t.year} nicht verfügbar. Nach Veröffentlichung neu berechnen.`,
      10,
      contentWidth - 20,
      bold
    );
    const bannerHeight = banner.length * 13 + 12;
    y -= 6;
    page.drawRectangle({ x: MARGIN, y: y - bannerHeight, width: contentWidth, height: bannerHeight, color: ALERT_PANEL, borderColor: ALERT, borderWidth: 1 });
    banner.forEach((line, i) => page.drawText(line, { x: MARGIN + 10, y: y - 16 - i * 13, size: 10, font: bold, color: ALERT }));
    y -= bannerHeight + 4;
  }

  // Key/value block
  const kv = (label: string, value: string) => {
    // wrapText("") returns no lines: keep one (empty) line so the row height stays correct.
    const wrapped = lines(value, 10.5, contentWidth - 150);
    const valueLines = wrapped.length > 0 ? wrapped : [""];
    ensure(valueLines.length * 15 + 8);
    y -= 17;
    draw(label, MARGIN, 9.5, bold);
    valueLines.forEach((line, i) => {
      page.drawText(line, { x: MARGIN + 150, y: y - i * 15, size: 10.5, font, color: BLACK });
    });
    y -= (valueLines.length - 1) * 15 + 6;
    rule(y);
  };
  kv("Reisende Person", `${data.travellerName} (${TRAVELLER_LABEL[data.travellerType]})`);
  kv("Reisezweck", data.purpose);
  kv("Abwesenheit", `${formatDateTime(data.departure)} bis ${formatDateTime(data.returnTime)}`);
  kv("Reiseweg", data.route.join("; "));

  // Table helper: widths in points, right-aligned numeric columns, wrapped text columns.
  const table = (
    title: string,
    columns: Array<{ title: string; width: number; right?: boolean }>,
    rows: string[][]
  ) => {
    ensure(60);
    y -= 28;
    draw(title, MARGIN, 11, bold);
    const xs: number[] = [];
    let cursor = MARGIN;
    for (const c of columns) {
      xs.push(cursor);
      cursor += c.width;
    }
    const header = () => {
      y -= 16;
      columns.forEach((c, i) => (c.right ? drawRight(c.title, xs[i] + c.width - 4, 8.5, bold, GRAY) : draw(c.title, xs[i], 8.5, bold, GRAY)));
      y -= 5;
      rule(y);
    };
    header();
    for (const row of rows) {
      const cellLines = row.map((cell, i) => lines(cell, 9, columns[i].width - 6));
      const lineCount = Math.max(1, ...cellLines.map((l) => l.length));
      if (y - lineCount * 12 - 8 < MARGIN + FOOTER_SPACE) {
        newPage();
        header();
      }
      y -= 13;
      cellLines.forEach((cell, i) =>
        cell.forEach((line, j) => {
          if (columns[i].right) {
            page.drawText(line, { x: xs[i] + columns[i].width - 4 - font.widthOfTextAtSize(line, 9), y: y - j * 12, size: 9, font, color: BLACK });
          } else {
            page.drawText(line, { x: xs[i], y: y - j * 12, size: 9, font, color: BLACK });
          }
        })
      );
      y -= (lineCount - 1) * 12 + 4;
      rule(y);
    }
  };

  if (data.days.length > 0) table(
    "Verpflegung",
    [
      { title: "Datum", width: 62 },
      { title: "Land / Ort", width: 150 },
      { title: "Std.", width: 36, right: true },
      { title: "Satz", width: 60, right: true },
      { title: "Kürzung", width: 62, right: true },
      { title: "Betrag", width: 113, right: true },
    ],
    data.days.map((d) => [
      formatDate(d.date),
      d.place ? `${d.country} (${d.place})` : d.country,
      d.hours.toFixed(1).replace(".", ","),
      d.kind === "none" ? "-" : euro(d.baseAmount),
      d.reduction > 0 ? `-${euro(d.reduction)}` : "",
      d.note ? `${euro(d.amount)} *` : euro(d.amount),
    ])
  );

  const costRows: string[][] = [
    ...data.lodgingFlat.map((l) => [formatDate(l.date), `Übernachtungspauschale ${l.country}`, "Pauschale", euro(l.amount), "", ""]),
    ...data.kmLines.map((k) => [formatDate(k.date), `${k.description}: ${k.km} km x ${euro(k.rate)}`, "Kilometer", euro(k.amount), "", ""]),
    ...data.costs.map((c) => [
      formatDate(c.date),
      c.currency === "EUR" ? c.description : `${c.description} (${c.currency}, Kurs ${c.fxRate})`,
      c.category === "fare" ? "Fahrt" : c.category === "lodging" ? "Übernachtung" : "Nebenkosten",
      euro(c.grossEur),
      euro(c.vatEur),
      c.paidBy === "company" ? "vom Unternehmen gezahlt" : c.receiptMissing ? "Beleg fehlt" : c.vorsteuer ? "Vorsteuer" : "ohne VSt",
    ]),
  ];
  if (costRows.length > 0) {
    table(
      "Kosten",
      [
        { title: "Datum", width: 62 },
        { title: "Beschreibung", width: 176 },
        { title: "Art", width: 70 },
        { title: "Brutto", width: 60, right: true },
        { title: "USt", width: 50, right: true },
        { title: "Status", width: 65, right: true },
      ],
      costRows
    );
  }

  // Sum box and confirmation stay together on one page
  const t = data.totals;
  const extraRow = t.companyPaid > 0 ? 16 : 0;
  ensure(170 + extraRow);
  y -= 24;
  const boxHeight = 60 + extraRow;
  page.drawRectangle({ x: MARGIN, y: y - boxHeight + 14, width: contentWidth, height: boxHeight, color: PANEL });
  const sumRow = (label: string, value: string, strong = false) => {
    draw(label, MARGIN + 12, 10, strong ? bold : font);
    drawRight(value, rightX - 12, 10, strong ? bold : font);
    y -= 16;
  };
  sumRow("Gesamtbetrag", `${euro(t.total)} €`);
  sumRow("abzüglich Vorschuss", `${euro(t.advance)} €`);
  sumRow("Erstattungsbetrag", `${euro(t.reimbursement)} €`, true);
  // Informational only: booked through their own receipts.
  if (t.companyPaid > 0) sumRow("nachrichtlich: vom Unternehmen gezahlt (nicht im Gesamtbetrag)", `${euro(t.companyPaid)} €`);
  y -= 14;

  // Confirmation
  y -= 8;
  draw("Bestätigung", MARGIN, 10, bold);
  y -= 15;
  draw(`Die Angaben bestätigt: ${data.travellerName}`, MARGIN, 9.5);
  y -= 14;
  draw(`Elektronisch bestätigt: ${formatConfirmationTimestamp(options.confirmedAt ?? new Date())}`, MARGIN, 9.5);
  y -= 13;
  for (const line of lines("Die Angaben wurden elektronisch bestätigt (Name und Zeitstempel).", 8.5, contentWidth)) {
    draw(line, MARGIN, 8.5, font, GRAY);
    y -= 11;
  }

  // Notes page
  page = doc.addPage(PageSizes.A4);
  y = height - MARGIN;
  draw("Hinweise zur Prüfung", MARGIN, 16, bold);
  y -= 10;
  rule(y, 1.2, BLACK);
  const block = (title: string, items: string[]) => {
    if (items.length === 0) return;
    ensure(40);
    y -= 24;
    draw(title, MARGIN, 10.5, bold);
    for (const item of items) {
      const wrapped = lines(`- ${item}`, 9.5, contentWidth);
      ensure(wrapped.length * 13 + 6);
      y -= 15;
      wrapped.forEach((line, i) => page.drawText(line, { x: MARGIN, y: y - i * 13, size: 9.5, font, color: BLACK }));
      y -= (wrapped.length - 1) * 13;
    }
  };
  block("Warnungen und Auslegungen", data.warnings);
  const noted = data.days.filter((d) => d.note).map((d) => `${formatDate(d.date)} *: ${d.note}`);
  block("Hinweise zu einzelnen Tagen", noted);
  const domesticSource = "Inland: § 9 Abs. 4a EStG (28 €/14 €), R 9.7 Abs. 3 LStR (20 € Übernachtung bei Erstattung).";
  const perYear = (data.rateTables ?? []).map((t) => `Auslandssätze ${t.year}: ${t.source}`);
  block("Quellen der Sätze", perYear.length > 0 ? [...perYear, domesticSource] : data.sources.length > 0 ? data.sources : [domesticSource]);
  block("Rechtsstand", [
    "Reisekosten nach § 9 Abs. 4a EStG, BMF-Schreiben vom 25.11.2020 (IV C 5 - S 2353/19/10011 :006) und BMF vom 05.12.2025 (Auslandsreisen ab 2026). Vor Produktivbetrieb vom Steuerberater gegenlesen lassen; dies ist keine Steuerberatung.",
  ]);

  // Footer with page numbers on every page.
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `Seite ${i + 1} von ${pages.length}`;
    p.drawText(label, { x: rightX - font.widthOfTextAtSize(label, 8.5), y: MARGIN - 24, size: 8.5, font, color: GRAY });
    p.drawText(FOOTER_BASIS[data.travellerType], { x: MARGIN, y: MARGIN - 24, size: 8, font, color: GRAY });
  });

  return doc.save();
}

export interface AttachmentFile {
  file: string;
  type: BillFileType;
}

export async function mergeAttachments(reportBytes: Uint8Array, attachments: AttachmentFile[]): Promise<Uint8Array> {
  let current = reportBytes;
  for (const attachment of attachments) {
    current = await mergeWithBillFile(current, attachment.file, attachment.type);
  }
  return current;
}
