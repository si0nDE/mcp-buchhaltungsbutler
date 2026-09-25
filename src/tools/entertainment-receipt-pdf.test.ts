import { describe, expect, it } from "vitest";
import { assertOccasionIsConcrete, computeAmounts } from "./entertainment-receipt-pdf.js";

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
