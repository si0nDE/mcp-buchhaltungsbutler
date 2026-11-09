import { PDFDocument } from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { computeMixedReceipt } from "./mixed-receipt-calc.js";
import { renderMixedReceiptPdf, SheetOverflowError, type MixedReceiptSheet } from "./mixed-receipt-pdf.js";
import { inkLines, makeFakeScanPdf } from "./mixed-receipt-scan.fixture.js";

const positions = [
  { description: "Milch 1 l", quantity_text: "2 × 0,99 €", gross: 1.98, vat_rate: 7 as const },
  { description: "Mineralwasser 0,5 l", quantity_text: "6 × 0,49 €", gross: 2.94, vat_rate: 19 as const },
  { description: "Pfand", quantity_text: "6 × 0,25 €", gross: 1.5, vat_rate: 19 as const },
];
const vatLines = [
  { vat_rate: 7 as const, net: 15.0, vat: 1.05 },
  { vat_rate: 19 as const, net: 6.22, vat: 1.18 },
];
const SHA = "a".repeat(64);

function sheet(overrides: Partial<MixedReceiptSheet> = {}): MixedReceiptSheet {
  return {
    companyName: "Beispiel GmbH",
    companyAddress: "Beispielweg 2, 12345 Musterstadt",
    merchantName: "Beispielmarkt",
    merchantAddress: "Musterstraße 1, 12345 Musterstadt",
    receiptNumber: "BEISPIEL-0815",
    receiptDate: "01.10.2026",
    receiptTime: "10:15",
    receiptTotal: 23.45,
    paymentMethod: "Karte",
    paidBy: "Erika Beispiel",
    occasion: "Milch und Wasser für Kundenbesprechungen im Büro",
    positions,
    amounts: computeMixedReceipt(positions, 23.45, vatLines),
    originalDisplayRef: "Rg. BEISPIEL-0815 · Beispielmarkt · 01.10.2026 · 23,45 €",
    originalSha256: SHA,
    ...overrides,
  };
}

async function textOf(pdf: Uint8Array): Promise<string> {
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf)), { mergePages: true });
  return text.replace(/\s+/g, " ");
}

describe("renderMixedReceiptPdf", () => {
  it("puts letterhead, receipt data, positions, result, hint and hash on one page", async () => {
    const scan = await makeFakeScanPdf({ width: 1800, height: 6000, inkRows: inkLines(10) });
    const { pdf, bonOnSecondPage } = await renderMixedReceiptPdf(sheet(), scan);
    expect(bonOnSecondPage).toBe(false);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
    const text = await textOf(pdf);
    for (const expected of [
      "Auslagenbeleg",
      "Beispiel GmbH",
      "Bon-Nr. BEISPIEL-0815",
      "Milch 1 l",
      "Mineralwasser 0,5 l",
      "Erstattung an Erika Beispiel",
      "6,42 €",
      "0,84 €",
      "Bestätigung ausstehend",
      "Rg. BEISPIEL-0815 · Beispielmarkt · 01.10.2026 · 23,45 €",
      `SHA-256 Originaldokument: ${SHA}`,
      "Links: geschwärzte Kopie des Kassenbons",
    ]) {
      expect(text, expected).toContain(expected);
    }
  });

  it("prints the confirmation only when one is given", async () => {
    const scan = await makeFakeScanPdf({ width: 1800, height: 6000, inkRows: inkLines(10) });
    const { pdf } = await renderMixedReceiptPdf(sheet({ confirmation: { name: "Erika Beispiel", date: "09.11.2026" } }), scan);
    const text = await textOf(pdf);
    expect(text).toContain("Elektronisch bestätigt: 09.11.2026");
    expect(text).not.toContain("ausstehend");
  });

  it("moves a long receipt to page 2", async () => {
    const scan = await makeFakeScanPdf({ width: 1800, height: 30000, inkRows: inkLines(10) });
    const { pdf, bonOnSecondPage } = await renderMixedReceiptPdf(sheet(), scan);
    expect(bonOnSecondPage).toBe(true);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(2);
    expect(await textOf(pdf)).toContain("Seite 2: geschwärzte Kopie des Kassenbons");
  });

  it("refuses content that does not fit instead of overlapping", async () => {
    const scan = await makeFakeScanPdf({ width: 1800, height: 6000, inkRows: inkLines(10) });
    const many = Array.from({ length: 10 }, (_, i) => ({
      description: `Artikel ${i + 1} ${"mit sehr langer Bezeichnung ".repeat(4)}`,
      gross: 0.5,
      vat_rate: 7 as const,
    }));
    const amounts = computeMixedReceipt(many, 23.45, vatLines);
    await expect(renderMixedReceiptPdf(sheet({ positions: many, amounts }), scan)).rejects.toThrow(SheetOverflowError);
    await expect(renderMixedReceiptPdf(sheet({ positions: many, amounts }), scan)).rejects.toThrow(/passt nicht auf eine Seite/);
  });
});
