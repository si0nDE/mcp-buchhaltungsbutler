import { PDFDocument } from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { computeMixedReceipt } from "./mixed-receipt-calc.js";
import { renderMixedReceiptPdf, SheetOverflowError, splitOccasion, type MixedReceiptSheet } from "./mixed-receipt-pdf.js";
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

describe("splitOccasion", () => {
  it("splits a trailing parenthesis from the headline", () => {
    expect(splitOccasion("Milch für Kaffee im Büro (Besprechungen und Team)")).toEqual(["Milch für Kaffee im Büro", "(Besprechungen und Team)"]);
  });

  it("keeps an occasion without parenthesis as the headline only", () => {
    expect(splitOccasion("Milch für Kaffee im Büro")).toEqual(["Milch für Kaffee im Büro"]);
  });

  it("does not turn a text that starts with a parenthesis into an empty headline", () => {
    expect(splitOccasion("(nur Klammer)")).toEqual(["(nur Klammer)"]);
  });
});

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
      "privat bezahlt, Erstattung durch das Unternehmen",
      "6,42 €",
      "0,84 €",
      "Bestätigung ausstehend",
      "Rg. BEISPIEL-0815 · Beispielmarkt · 01.10.2026 · 23,45 €",
      `SHA-256 Originaldokument: ${SHA}`,
      "Geschwärzte Kopie",
    ]) {
      expect(text, expected).toContain(expected);
    }
    // the caption under the receipt says it already; the footer does not repeat it
    expect(text).not.toContain("Links: geschwärzte Kopie des Kassenbons");
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
  const longScan = () => makeFakeScanPdf({ width: 1800, height: 6000, inkRows: inkLines(10) });

  it("prints the full hint sentence", async () => {
    const { pdf } = await renderMixedReceiptPdf(sheet(), await longScan());
    const text = await textOf(pdf);
    expect(text).toContain("Das Original ist unverändert in BuchhaltungsButler archiviert");
    expect(text).toContain("Rg. BEISPIEL-0815");
  });

  it("wraps a long name in the result panel instead of cutting it", async () => {
    const { pdf } = await renderMixedReceiptPdf(sheet({ paidBy: "Erika Beispielmann-Musterfrau" }), await longScan());
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
    const text = await textOf(pdf);
    expect(text).toContain("Erstattung an");
    expect(text).toContain("Beispielmann-Musterfrau");
    expect(text.slice(text.indexOf("Erstattung an"))).toContain("Beispielmann-Musterfrau");
  });

  it("prints one Summe line for a single VAT rate", async () => {
    const only7 = [positions[0]!];
    const amounts = computeMixedReceipt(only7, 23.45, vatLines);
    const text = await textOf((await renderMixedReceiptPdf(sheet({ positions: only7, amounts }), await longScan())).pdf);
    expect(text).toContain("Summe 7 %");
    expect(text).not.toContain("Summe 19 %");
  });

  it("prints three Summe lines for 0, 7 and 19 percent", async () => {
    const three = [...positions, { description: "Zeitschrift", gross: 2.0, vat_rate: 0 as const }];
    const lines3 = [{ vat_rate: 0 as const, net: 2.0, vat: 0 }, ...vatLines];
    const amounts = computeMixedReceipt(three, 25.45, lines3);
    const text = await textOf((await renderMixedReceiptPdf(sheet({ positions: three, amounts, receiptTotal: 25.45 }), await longScan())).pdf);
    for (const r of ["Summe 0 %", "Summe 7 %", "Summe 19 %"]) expect(text, r).toContain(r);
  });

  it("prints a negative position with its sign", async () => {
    const neg = [...positions, { description: "Pfandrückgabe", gross: -0.75, vat_rate: 19 as const }];
    const amounts = computeMixedReceipt(neg, 23.45, vatLines);
    const text = await textOf((await renderMixedReceiptPdf(sheet({ positions: neg, amounts }), await longScan())).pdf);
    expect(text).toContain("Pfandrückgabe");
    expect(text).toContain("-0,75 €");
  });

  it("fits 6 short positions on one page (7 overflow with the current layout)", async () => {
    const eight = Array.from({ length: 6 }, (_, i) => ({ description: `Artikel ${i + 1}`, gross: 0.5, vat_rate: 7 as const }));
    const amounts = computeMixedReceipt(eight, 23.45, vatLines);
    const { pdf } = await renderMixedReceiptPdf(sheet({ positions: eight, amounts }), await longScan());
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
    expect(await textOf(pdf)).toContain("Artikel 6");
  });

  it("refuses overflow also with the receipt on page 2", async () => {
    const scan = await makeFakeScanPdf({ width: 1800, height: 30000, inkRows: inkLines(10) });
    const many = Array.from({ length: 10 }, (_, i) => ({
      description: `Artikel ${i + 1} ${"mit sehr langer Bezeichnung ".repeat(8)}`,
      gross: 0.5,
      vat_rate: 7 as const,
    }));
    const amounts = computeMixedReceipt(many, 23.45, vatLines);
    await expect(renderMixedReceiptPdf(sheet({ positions: many, amounts }), scan)).rejects.toThrow(SheetOverflowError);
  });
});
