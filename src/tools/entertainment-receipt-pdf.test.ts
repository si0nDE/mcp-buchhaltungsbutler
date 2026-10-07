import { describe, expect, it } from "vitest";
import { PDFDocument, PageSizes, StandardFonts } from "pdf-lib";
import {
  assertOccasionIsConcrete,
  buildAmountTable,
  buildConfirmationDisclaimer,
  buildDeductibleLabel,
  buildHostConfirmationLines,
  buildLetterheadSubtitle,
  buildNonDeductibleLabel,
  computeAmounts,
  formatConfirmationTimestamp,
  formatEuro,
  formatLocationLines,
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

describe("formatLocationLines", () => {
  it("puts the restaurant name on its own line, address below, without the separating comma", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = formatLocationLines(
      "B. Neumann Residenzgaststätten GmbH (Biergarten), Waldkugelweg 5, 97082 Würzburg",
      font,
      10.5,
      400
    );
    expect(lines).toEqual(["B. Neumann Residenzgaststätten GmbH (Biergarten)", "Waldkugelweg 5, 97082 Würzburg"]);
  });

  it("keeps a location without any comma as a single line", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(formatLocationLines("Restaurant Zur Alten Post", font, 10.5, 400)).toEqual(["Restaurant Zur Alten Post"]);
  });

  it("does not produce an empty line for a trailing or leading comma", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(formatLocationLines("Restaurant Zur Alten Post,", font, 10.5, 400)).toEqual(["Restaurant Zur Alten Post"]);
    expect(formatLocationLines(", Musterstraße 1", font, 10.5, 400)).toEqual(["Musterstraße 1"]);
  });

  it("never produces a line wider than maxWidth for a long name and address", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = formatLocationLines(
      "Gasthaus Zum Goldenen Hirschen und Weinstube der Familie Müller-Lüdenscheidt, Musterstraße Allee der Wissenschaften 12345678, 12345 Musterstadt-Oberdorf",
      font,
      10.5,
      200
    );
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, 10.5)).toBeLessThanOrEqual(200);
    }
  });
});

describe("buildAmountTable", () => {
  const input = { foodNet: 32.5, foodVat: 2.28, drinksNet: 38.0, drinksVat: 7.22, tip: 4.5 };
  const computed = computeAmounts({ ...input, kleinunternehmer: false });

  it("itemizes Speisen/Getränke/Trinkgeld with net, USt and gross for Regelbesteuerung", () => {
    const table = buildAmountTable(input, computed, false);
    expect(table.hasVatColumns).toBe(true);
    expect(table.rows).toEqual([
      { label: "Speisen", net: "32,50 €", vat: "2,28 €", gross: "34,78 €" },
      { label: "Getränke", net: "38,00 €", vat: "7,22 €", gross: "45,22 €" },
      { label: "Trinkgeld", net: "4,50 €", vat: "-", gross: "4,50 €" },
    ]);
    // Net total includes the tip (it carries no USt) - it is the 70/30 base.
    expect(table.total).toEqual({ label: "Gesamtbetrag", net: "75,00 €", vat: "9,50 €", gross: "84,50 €" });
    expect(table.vatNote).toEqual({ label: "davon Vorsteuer (100 % abziehbar)", amount: "9,50 €" });
  });

  it("shows gross only and no Vorsteuer note for Kleinunternehmer", () => {
    const kuComputed = computeAmounts({ ...input, kleinunternehmer: true });
    const table = buildAmountTable(input, kuComputed, true);
    expect(table.hasVatColumns).toBe(false);
    expect(table.rows).toEqual([
      { label: "Speisen", gross: "34,78 €" },
      { label: "Getränke", gross: "45,22 €" },
      { label: "Trinkgeld", gross: "4,50 €" },
    ]);
    expect(table.total).toEqual({ label: "Gesamtbetrag", gross: "84,50 €" });
    expect(table.vatNote).toBeUndefined();
  });

  it("omits the Trinkgeld row entirely when there is no tip", () => {
    const noTip = { ...input, tip: 0 };
    const noTipComputed = computeAmounts({ ...noTip, kleinunternehmer: false });
    const table = buildAmountTable(noTip, noTipComputed, false);
    expect(table.rows.some((row) => row.label === "Trinkgeld")).toBe(false);
  });

  it("omits a Speisen or Getränke row that is zero", () => {
    const drinksOnly = { ...input, foodNet: 0, foodVat: 0, tip: 0 };
    const table = buildAmountTable(drinksOnly, computeAmounts({ ...drinksOnly, kleinunternehmer: false }), false);
    expect(table.rows.map((row) => row.label)).toEqual(["Getränke"]);
  });
});

describe("formatConfirmationTimestamp", () => {
  it("formats in Europe/Berlin (summer time, CEST = UTC+2)", () => {
    expect(formatConfirmationTimestamp(new Date("2026-10-07T07:41:00Z"))).toBe("07.10.2026, 09:41 Uhr");
  });

  it("formats in Europe/Berlin (winter time, CET = UTC+1) and rolls the date over correctly", () => {
    expect(formatConfirmationTimestamp(new Date("2026-12-31T23:30:00Z"))).toBe("01.01.2027, 00:30 Uhr");
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

describe("buildDeductibleLabel / buildNonDeductibleLabel", () => {
  // Avoids a bare "NN %" immediately next to a Euro amount - a plausible
  // (unconfirmed) source of confusion for a receiving system's own OCR/VAT-
  // rate heuristics when this page is uploaded and scanned as if it were an
  // independent invoice. Cheap to avoid even without proof it's the cause.
  it("expresses the 70/30 split as a decimal factor, not a bare percentage", () => {
    expect(buildDeductibleLabel(false)).toBe("Abziehbar (Faktor 0,70 v. Netto)");
    expect(buildNonDeductibleLabel()).toBe("Nicht abziehbar (Faktor 0,30)");
  });

  it("labels the Kleinunternehmer basis as Brutto instead of Netto", () => {
    expect(buildDeductibleLabel(true)).toBe("Abziehbar (Faktor 0,70 v. Brutto)");
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

  it("renders with a fixed confirmedAt timestamp without throwing", async () => {
    const bytes = await renderEntertainmentReceiptCover(fields, amounts, {
      kleinunternehmer: false,
      confirmedAt: new Date("2026-10-07T07:41:00Z"),
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("keeps the clamped companyName from overlapping the billReference subtitle even when both are long", async () => {
    // A long billReference widens the right-aligned `sub` line past any
    // fixed split, so a companyName clamped to a fixed split could still
    // land to the right of `sub`'s left edge. The renderer instead computes
    // the left column's max width from the ACTUAL rendered width of `sub`.
    const longBillReference = "RE-2026-00123456";
    const longCompanyName =
      "Musterstraße Allee der Wissenschaften und Industrie Beratungsgesellschaft mit beschränkter Haftung";
    const collisionFields = { ...fields, billReference: longBillReference, companyName: longCompanyName };

    const bytes = await renderEntertainmentReceiptCover(collisionFields, amounts, { kleinunternehmer: false });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);

    // Independently reconstruct exactly what the renderer computes and
    // draws for this line - same fonts, same formula, same wrapText - and
    // assert the gap between both sides' actual rendered widths is
    // non-negative (no overlap).
    const measureDoc = await PDFDocument.create();
    const font = await measureDoc.embedFont(StandardFonts.Helvetica);
    const bold = await measureDoc.embedFont(StandardFonts.HelveticaBold);
    const [pageWidth] = PageSizes.A4;
    const contentWidth = pageWidth - 2 * MARGIN;
    const sub = buildLetterheadSubtitle(longBillReference);
    const subWidth = font.widthOfTextAtSize(sub, 9);
    const companyNameMaxWidth = Math.max(0, contentWidth - subWidth - LETTERHEAD_GAP);
    const companyNameLine = wrapText(longCompanyName, bold, 10, companyNameMaxWidth)[0] ?? "";
    const companyNameWidth = bold.widthOfTextAtSize(companyNameLine, 10);

    const rightTextLeftEdge = pageWidth - MARGIN - subWidth;
    const leftTextRightEdge = MARGIN + companyNameWidth;
    expect(rightTextLeftEdge - leftTextRightEdge).toBeGreaterThanOrEqual(0);
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
