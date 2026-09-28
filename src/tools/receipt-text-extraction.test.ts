import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractReceiptText, sortIntoReadingOrder } from "./receipt-text-extraction.js";

async function buildPdf(draw: (page: import("pdf-lib").PDFPage, font: import("pdf-lib").PDFFont) => void) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  draw(page, font);
  return Buffer.from(await doc.save()).toString("base64");
}

describe("sortIntoReadingOrder", () => {
  it("reassembles row-major reading order even when items arrive in a different (e.g. stream) order", () => {
    // Deliberately out of reading order: both labels, then both values -
    // mirrors how unpdf's extractText returns this same layout (verified
    // empirically), which is exactly the ambiguity that made the real
    // three-"7%"-lines receipt (see docs/bewirtungsbeleg-faq.md context)
    // need pdftotext -layout to disentangle in the first place.
    const items = [
      { str: "Netto 19%", x: 50, y: 150 },
      { str: "USt 19%", x: 50, y: 130 },
      { str: "8,24", x: 200, y: 150 },
      { str: "1,56", x: 200, y: 130 },
    ];

    expect(sortIntoReadingOrder(items)).toBe("Netto 19% 8,24\nUSt 19% 1,56");
  });

  it("treats items within a small y-tolerance as the same row despite sub-pixel baseline differences", () => {
    const items = [
      { str: "Netto 19%", x: 50, y: 150 },
      { str: "8,24", x: 200, y: 150.4 },
    ];

    expect(sortIntoReadingOrder(items)).toBe("Netto 19% 8,24");
  });

  it("returns an empty string for no items", () => {
    expect(sortIntoReadingOrder([])).toBe("");
  });
});

describe("extractReceiptText", () => {
  it("extracts simple single-line text", async () => {
    const base64 = await buildPdf((page, font) => {
      page.drawText("Rechnung Nr. 92119", { x: 50, y: 150, size: 12, font });
    });

    await expect(extractReceiptText(base64)).resolves.toBe("Rechnung Nr. 92119");
  });

  it("preserves label/value row pairing for a two-column layout drawn out of reading order", async () => {
    const base64 = await buildPdf((page, font) => {
      page.drawText("Netto 19%", { x: 50, y: 150, size: 12, font });
      page.drawText("USt 19%", { x: 50, y: 130, size: 12, font });
      page.drawText("8,24", { x: 200, y: 150, size: 12, font });
      page.drawText("1,56", { x: 200, y: 130, size: 12, font });
    });

    await expect(extractReceiptText(base64)).resolves.toBe("Netto 19% 8,24\nUSt 19% 1,56");
  });

  it("returns undefined for a PDF with no extractable text (e.g. a scanned image page)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const base64 = Buffer.from(await doc.save()).toString("base64");

    await expect(extractReceiptText(base64)).resolves.toBeUndefined();
  });

  it("returns undefined instead of throwing for bytes that aren't a valid PDF", async () => {
    const base64 = Buffer.from("not a pdf").toString("base64");

    await expect(extractReceiptText(base64)).resolves.toBeUndefined();
  });
});
