import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  assertOccasionIsConcrete,
  computeAmounts,
  mergeWithBillFile,
  renderEntertainmentReceiptCover,
} from "./entertainment-receipt-pdf.js";

describe("assertOccasionIsConcrete", () => {
  it("accepts a concrete, detailed occasion", () => {
    expect(() =>
      assertOccasionIsConcrete(
        "Vertragsverhandlung Rahmenvertrag IT-Sicherheitsaudits 2026/2027 mit Kunde GmbH"
      )
    ).not.toThrow();
  });

  it.each([
    "Geschäftsessen",
    "geschäftsessen",
    "  Geschäftsessen  ",
    "Geschäftsbesprechung",
    "Kontaktpflege",
    "Kundenpflege",
    "Akquisitionsbesprechung",
    "Mandatsbesprechung",
    "Arbeitsgespräch",
    "Infogespräch",
    "Hintergrundgespräch",
    "Meeting",
    "Besprechung",
  ])("rejects the BFH-rejected phrase %s", (phrase) => {
    expect(() => assertOccasionIsConcrete(phrase)).toThrow(/zu unkonkret/);
  });

  it("cites both BFH decisions in the error message", () => {
    expect(() => assertOccasionIsConcrete("Geschäftsessen")).toThrow(/IV R 81\/96/);
    expect(() => assertOccasionIsConcrete("Geschäftsessen")).toThrow(/IV R 50\/01/);
  });

  it("rejects an occasion under the minimum length even if not on the denylist", () => {
    expect(() => assertOccasionIsConcrete("Kurzes Essen")).toThrow(/zu unkonkret/);
  });
});

describe("computeAmounts", () => {
  const example = { foodNet: 32.5, foodVat: 2.28, drinksNet: 38.0, drinksVat: 7.22, tip: 4.5 };

  it("splits on the net base (incl. tip) for Regelbesteuerung", () => {
    const result = computeAmounts({ ...example, kleinunternehmer: false });
    expect(result.vatTotal).toBeCloseTo(9.5, 2);
    expect(result.grossTotal).toBeCloseTo(84.5, 2);
    expect(result.deductibleBase).toBeCloseTo(75.0, 2);
    expect(result.deductible).toBeCloseTo(52.5, 2);
    expect(result.nonDeductible).toBeCloseTo(22.5, 2);
  });

  it("splits on the gross base for Kleinunternehmer", () => {
    const result = computeAmounts({ ...example, kleinunternehmer: true });
    expect(result.deductibleBase).toBeCloseTo(84.5, 2);
    expect(result.deductible).toBeCloseTo(59.15, 2);
    expect(result.nonDeductible).toBeCloseTo(25.35, 2);
  });
});

const fields = {
  date: "24.09.2026",
  location: "Restaurant Zur Alten Post, München",
  occasion: "Vertragsverhandlung Rahmenvertrag IT-Sicherheitsaudits 2026/2027 mit Kunde GmbH",
  participants: "Nena Tempel (mainsec UG), Max Mustermann (Kunde GmbH)",
  hostName: "Nena Tempel",
  hostRole: "Geschäftsführung",
  companyName: "mainsec UG (haftungsbeschränkt)",
  companyAddress: "Strüthweg 2, 97222 Rimpar",
  receiptNumber: "BA-2026-0142",
  billReference: "4471",
};

const amounts = {
  grossTotal: 84.5,
  vatTotal: 9.5,
  deductibleBase: 75.0,
  deductible: 52.5,
  nonDeductible: 22.5,
};

describe("renderEntertainmentReceiptCover", () => {
  it("produces a loadable single-page A4 PDF", async () => {
    const bytes = await renderEntertainmentReceiptCover(fields, amounts, { kleinunternehmer: false });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const page = doc.getPage(0);
    expect(page.getSize()).toEqual({ width: 595.28, height: 841.89 });
  });

  it("renders successfully with kleinunternehmer: true (Vorsteuer line omitted - verified visually in Step 5, not here)", async () => {
    // Structural smoke test only - full text-content assertions would need
    // an OCR/text-extraction dependency this project doesn't otherwise need.
    const bytes = await renderEntertainmentReceiptCover(fields, amounts, { kleinunternehmer: true });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("renders with attachmentFollows: true without throwing (footer states an attachment follows)", async () => {
    const bytes = await renderEntertainmentReceiptCover(fields, amounts, {
      kleinunternehmer: false,
      attachmentFollows: true,
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("renders with attachmentFollows omitted without throwing (footer states no attachment)", async () => {
    const bytes = await renderEntertainmentReceiptCover(fields, amounts, { kleinunternehmer: false });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("wraps a long hostRole and companyAddress instead of overflowing (structural smoke test)", async () => {
    // Text-content/overlap correctness can't be asserted without an OCR
    // dependency (see comment above) - this confirms the wrapping/box-growth
    // code path runs to completion and still yields a valid single-page PDF.
    const longFields = {
      ...fields,
      hostRole: "Bereichsleiterin Informationssicherheit und Datenschutz sowie Prokuristin der Gesellschaft",
      companyAddress: "Musterstraße Allee der Wissenschaften und Industrie 12345678, 97222 Rimpar-Oberdorf",
    };
    const bytes = await renderEntertainmentReceiptCover(longFields, amounts, { kleinunternehmer: false });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("breaks a single word wider than the wrap column instead of overflowing it", async () => {
    const longWordFields = {
      ...fields,
      hostRole: "Datenschutzfolgenabschätzungsverantwortlichkeitsübertragungsbeauftragte",
    };
    const bytes = await renderEntertainmentReceiptCover(longWordFields, amounts, { kleinunternehmer: false });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });
});

// A minimal valid single-page PDF, base64-encoded, for merge tests that
// don't need real invoice content - just a second document to append.
const MINIMAL_PDF_BASE64 = await (async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const bytes = await doc.save();
  return Buffer.from(bytes).toString("base64");
})();

// A 1x1 transparent PNG, base64-encoded.
const MINIMAL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("mergeWithBillFile", () => {
  it("appends all pages of a PDF bill after the cover page", async () => {
    const cover = await renderEntertainmentReceiptCover(fields, amounts, { kleinunternehmer: false });
    const merged = await mergeWithBillFile(cover, MINIMAL_PDF_BASE64, "pdf");
    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(2);
  });

  it("embeds a PNG bill as a second full page", async () => {
    const cover = await renderEntertainmentReceiptCover(fields, amounts, { kleinunternehmer: false });
    const merged = await mergeWithBillFile(cover, MINIMAL_PNG_BASE64, "png");
    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(2);
  });

  it("appends a multi-page PDF bill as 1 + N pages, not always 2 (motivates the footer fix)", async () => {
    const threePageBillBase64 = await (async () => {
      const doc = await PDFDocument.create();
      doc.addPage([200, 200]);
      doc.addPage([200, 200]);
      doc.addPage([200, 200]);
      const bytes = await doc.save();
      return Buffer.from(bytes).toString("base64");
    })();
    const cover = await renderEntertainmentReceiptCover(fields, amounts, {
      kleinunternehmer: false,
      attachmentFollows: true,
    });
    const merged = await mergeWithBillFile(cover, threePageBillBase64, "pdf");
    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(4);
  });
});
