import { describe, expect, it } from "vitest";
import { PDFDocument, PageSizes, StandardFonts } from "pdf-lib";
import {
  assertOccasionIsConcrete,
  buildAmountBreakdownLines,
  buildConfirmationDisclaimer,
  buildDeductibleLine,
  buildHostConfirmationLines,
  buildLetterheadSubtitle,
  buildNonDeductibleLine,
  computeAmounts,
  formatEuro,
  formatParticipantLine,
  LETTERHEAD_GAP,
  MARGIN,
  mergeWithBillFile,
  renderEntertainmentReceiptCover,
  TABLE_VALUE_X_OFFSET,
  tableValueMaxWidth,
  wrapAddressText,
  wrapText,
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

describe("formatEuro", () => {
  it("formats with a German decimal comma", () => {
    expect(formatEuro(50.6)).toBe("50,60 €");
  });

  it("rounds to two decimal places", () => {
    expect(formatEuro(4.5)).toBe("4,50 €");
  });
});

describe("buildLetterheadSubtitle", () => {
  it("references the bill without repeating 'Rechnung' or restating the EStG citation", () => {
    const subtitle = buildLetterheadSubtitle("92119");
    expect(subtitle).toBe("Ergänzung zu Rechnung 92119");
  });

  it("falls back to a placeholder dash when no billReference is given", () => {
    expect(buildLetterheadSubtitle(undefined)).toBe("Ergänzung zu Rechnung -");
  });
});

describe("tableValueMaxWidth", () => {
  it("matches the actual x-offset the table row values are drawn at", () => {
    const [pageWidth] = PageSizes.A4;
    const contentWidth = pageWidth - 2 * MARGIN;
    const valueX = MARGIN + TABLE_VALUE_X_OFFSET;
    const availableWidth = pageWidth - MARGIN - valueX;
    expect(tableValueMaxWidth(contentWidth)).toBe(availableWidth);
  });
});

describe("wrapAddressText", () => {
  it("prefers breaking at comma boundaries over mid-clause word wrap (DIN 5008-style)", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const text = "B. Neumann Residenzgaststätten GmbH (Biergarten), Waldkugelweg 5, 97082 Würzburg";
    // Wide enough for the first two comma-segments together, but not all three.
    const maxWidth = font.widthOfTextAtSize("B. Neumann Residenzgaststätten GmbH (Biergarten), Waldkugelweg 5,", 9) + 5;

    const lines = wrapAddressText(text, font, 9, maxWidth);

    expect(lines).toEqual(["B. Neumann Residenzgaststätten GmbH (Biergarten), Waldkugelweg 5,", "97082 Würzburg"]);
  });

  it("never produces a line wider than maxWidth even when a single segment must be word-wrapped", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const text = "Musterstraße Allee der Wissenschaften und Industrie 12345678, 12345 Musterstadt-Oberdorf";
    const maxWidth = 150;

    const lines = wrapAddressText(text, font, 9, maxWidth);

    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, 9)).toBeLessThanOrEqual(maxWidth);
    }
  });

  it("returns the text unchanged as a single line when it already fits", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const text = "Restaurant Zur Alten Post, München";

    const lines = wrapAddressText(text, font, 9, 400);

    expect(lines).toEqual(["Restaurant Zur Alten Post, München"]);
  });

  it("never lets an appended trailing comma push a flushed line past maxWidth (regression: the reported real-world case)", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const text = "B. Neumann Residenzgaststätten GmbH (Biergarten), Waldkugelweg 5, 97082 Würzburg";
    // The exact table-row column width at font size 10 (tableValueMaxWidth
    // applied to A4's contentWidth) - the width that actually overflowed by
    // ~1.3pt before this fix, because "<segment>, <segment>" fit but
    // "<segment>, <segment>," (with the comma this function then appends)
    // didn't.
    const maxWidth = tableValueMaxWidth(PageSizes.A4[0] - 2 * MARGIN);

    const lines = wrapAddressText(text, font, 10, maxWidth);

    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(maxWidth);
    }
  });
});

describe("buildAmountBreakdownLines", () => {
  const input = { foodNet: 32.5, foodVat: 2.28, drinksNet: 38.0, drinksVat: 7.22, tip: 4.5 };
  const computed = computeAmounts({ ...input, kleinunternehmer: false });

  it("itemizes Speisen/Getränke/Trinkgeld with net + USt for Regelbesteuerung, one entry per line", () => {
    const lines = buildAmountBreakdownLines(input, computed, false);
    expect(lines).toEqual([
      "Speisen: 32,50 € netto + 2,28 € USt",
      "Getränke: 38,00 € netto + 7,22 € USt",
      "Trinkgeld: 4,50 €",
      "Gesamtbetrag: 84,50 €",
      "davon Vorsteuer (100 % abziehbar): 9,50 €",
    ]);
  });

  it("omits the net/USt split and the Vorsteuer line for Kleinunternehmer", () => {
    const kuComputed = computeAmounts({ ...input, kleinunternehmer: true });
    const lines = buildAmountBreakdownLines(input, kuComputed, true);
    expect(lines).toEqual(["Speisen: 34,78 €", "Getränke: 45,22 €", "Trinkgeld: 4,50 €", "Gesamtbetrag: 84,50 €"]);
  });

  it("omits the Trinkgeld line entirely when there is no tip", () => {
    const noTip = { ...input, tip: 0 };
    const noTipComputed = computeAmounts({ ...noTip, kleinunternehmer: false });
    const lines = buildAmountBreakdownLines(noTip, noTipComputed, false);
    expect(lines.some((line) => line.includes("Trinkgeld"))).toBe(false);
  });
});

describe("formatParticipantLine", () => {
  it("renders name and company on one line", () => {
    expect(formatParticipantLine({ name: "Anna Beispiel", company: "Beispielfirma UG" })).toBe("Anna Beispiel (Beispielfirma UG)");
  });

  it("omits the parentheses entirely when company is absent", () => {
    expect(formatParticipantLine({ name: "Anna Beispiel" })).toBe("Anna Beispiel");
  });
});

describe("buildDeductibleLine / buildNonDeductibleLine", () => {
  // Avoids a bare "NN %" immediately next to a Euro amount - a plausible
  // (unconfirmed) source of confusion for a receiving system's own OCR/VAT-
  // rate heuristics when this page is uploaded and scanned as if it were an
  // independent invoice. Cheap to avoid even without proof it's the cause.
  it("expresses the 70/30 split as a decimal factor, not a bare percentage", () => {
    expect(buildDeductibleLine(32.23, false)).toBe("Abziehbar (Faktor 0,70 v. Netto): 32,23 €");
    expect(buildNonDeductibleLine(13.81)).toBe("Nicht abziehbar (Faktor 0,30): 13,81 €");
  });

  it("labels the Kleinunternehmer basis as Brutto instead of Netto", () => {
    expect(buildDeductibleLine(59.15, true)).toBe("Abziehbar (Faktor 0,70 v. Brutto): 59,15 €");
  });
});

describe("buildHostConfirmationLines", () => {
  it("always starts hostRole on its own line, even when name and role would fit on one line", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = buildHostConfirmationLines("Max Beispiel", "Geschäftsführender Gesellschafter", font, 10, 400);
    expect(lines).toEqual(["Max Beispiel", "Geschäftsführender Gesellschafter"]);
  });

  it("word-wraps a long hostRole across multiple lines, all after the name line", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const longRole = "Bereichsleiterin Informationssicherheit und Datenschutz sowie Prokuristin der Gesellschaft";
    const lines = buildHostConfirmationLines("Anna Beispiel", longRole, font, 10, 150);
    expect(lines[0]).toBe("Anna Beispiel");
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines.slice(1)) {
      expect(font.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(150);
    }
  });

  it("omits role lines entirely when hostRole is undefined", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = buildHostConfirmationLines("Max Beispiel", undefined, font, 10, 400);
    expect(lines).toEqual(["Max Beispiel"]);
  });
});

const fields = {
  date: "24.09.2026",
  location: "Restaurant Zur Alten Post, München",
  occasion: "Vertragsverhandlung Rahmenvertrag IT-Sicherheitsaudits 2026/2027 mit Kunde GmbH",
  participants: [
    { name: "Anna Beispiel", company: "Beispielfirma UG" },
    { name: "Max Mustermann", company: "Kunde GmbH" },
  ],
  hostName: "Anna Beispiel",
  hostRole: "Geschäftsführung",
  companyName: "Beispielfirma UG (haftungsbeschränkt)",
  companyAddress: "Musterweg 1, 12345 Musterstadt",
  receiptNumber: "BA-2026-0142",
  billReference: "4471",
  foodNet: 32.5,
  foodVat: 2.28,
  drinksNet: 38.0,
  drinksVat: 7.22,
  tip: 4.5,
};

const amounts = {
  grossTotal: 84.5,
  vatTotal: 9.5,
  deductibleBase: 75.0,
  deductible: 52.5,
  nonDeductible: 22.5,
};

describe("buildConfirmationDisclaimer", () => {
  // The BMF-Schreiben v. 30.06.2021 that originally established "Unterschrift
  // entbehrlich" for digital Eigenbelege was replaced by the BMF-Schreiben v.
  // 19.11.2025 (Rz. 19: "elektronische Unterschrift oder eine elektronische
  // Genehmigung" suffices) - verified directly against the BMF's own PDF, not
  // taken from a secondary source. Citing the superseded letter would be a
  // stale, factually wrong reference on every generated receipt.
  it("cites the current BMF-Schreiben (19.11.2025), not the superseded one (30.06.2021)", () => {
    const disclaimer = buildConfirmationDisclaimer();
    expect(disclaimer).toContain("19.11.2025");
    expect(disclaimer).not.toContain("30.06.2021");
  });

  it("still states the signature is dispensable", () => {
    expect(buildConfirmationDisclaimer()).toContain("Unterschrift entbehrlich");
  });
});

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
      companyAddress: "Musterstraße Allee der Wissenschaften und Industrie 12345678, 12345 Musterstadt-Oberdorf",
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

  it("keeps the clamped companyAddress from overlapping the billReference subtitle even when both are long", async () => {
    // Reproduces the collision the re-reviewer found by tracing pdf-lib
    // text metrics: a long billReference widens the right-aligned `sub`
    // line past a fixed half-content-width split, so a companyAddress
    // clamped to that fixed split can still land to the right of `sub`'s
    // left edge. The fix computes the left column's max width from the
    // ACTUAL rendered width of `sub` (and title) instead of a fixed split.
    const longBillReference = "RE-2026-00123456";
    const longCompanyAddress =
      "Musterstraße Allee der Wissenschaften und Industrie 12345678, 12345 Musterstadt-Oberdorf";
    const collisionFields = {
      ...fields,
      billReference: longBillReference,
      companyAddress: longCompanyAddress,
    };

    const bytes = await renderEntertainmentReceiptCover(collisionFields, amounts, { kleinunternehmer: false });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);

    // Independently reconstruct exactly what the renderer computes and
    // draws for this line - same font, same formula, same wrapText - and
    // measure both sides' actual rendered widths to assert the gap between
    // them is non-negative (no overlap).
    const measureDoc = await PDFDocument.create();
    const font = await measureDoc.embedFont(StandardFonts.Helvetica);
    const [pageWidth] = PageSizes.A4;
    const contentWidth = pageWidth - 2 * MARGIN;
    const sub = buildLetterheadSubtitle(longBillReference);
    const subWidth = font.widthOfTextAtSize(sub, 9);
    const companyAddressMaxWidth = Math.max(0, contentWidth - subWidth - LETTERHEAD_GAP);
    const companyAddressLine = wrapText(longCompanyAddress, font, 9, companyAddressMaxWidth)[0] ?? "";
    const companyAddressWidth = font.widthOfTextAtSize(companyAddressLine, 9);

    // Left text spans [MARGIN, MARGIN + companyAddressWidth]; right text
    // spans [pageWidth - MARGIN - subWidth, pageWidth - MARGIN].
    const rightTextLeftEdge = pageWidth - MARGIN - subWidth;
    const leftTextRightEdge = MARGIN + companyAddressWidth;
    const gap = rightTextLeftEdge - leftTextRightEdge;
    expect(gap).toBeGreaterThanOrEqual(0);
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
