import { describe, expect, it } from "vitest";
import { assertGeneratorType, planMissingInvoice, type MissingInvoiceArgs } from "./entertainment-missing-invoice.js";

// All data is invented.
const base: MissingInvoiceArgs = {
  original_invoice_status: "missing_requested",
  entertainment_type: "business",
  missing_invoice_treatment: "practice_70_30_no_vat",
  gross_amount: 37.5,
  payment_evidence: { transaction_id_by_customer: 1001 },
  invoice_requests: [{ date: "2026-07-31", channel: "E-Mail" }],
  counterparty: "Beispiel-Gaststätte",
};

describe("assertGeneratorType", () => {
  it("rejects sole_proprietor_self with the Verpflegungspauschale hint", () => {
    expect(() => assertGeneratorType("sole_proprietor_self")).toThrow(/Verpflegungs/);
  });
  it("accepts every other type and undefined", () => {
    expect(() => assertGeneratorType("business")).not.toThrow();
    expect(() => assertGeneratorType(undefined)).not.toThrow();
  });
});

describe("planMissingInvoice", () => {
  it("splits 37.50 into 26.25 / 11.25 for the practice variant", () => {
    const plan = planMissingInvoice(base, { requireCounterparty: true });
    expect(plan).toMatchObject({ gross: 37.5, deductible: 26.25, nonDeductible: 11.25, business: true, treatment: "practice_70_30_no_vat" });
    expect(plan.warnings.join(" ")).toContain("X R 57/09");
  });

  it("books 100 % non-deductible for the conservative variant", () => {
    const plan = planMissingInvoice({ ...base, missing_invoice_treatment: "conservative_100_nondeductible" }, { requireCounterparty: true });
    expect(plan).toMatchObject({ deductible: 0, nonDeductible: 37.5 });
  });

  it("treats non-business types as fully deductible and needs no treatment", () => {
    const plan = planMissingInvoice(
      { ...base, entertainment_type: "internal_employees", missing_invoice_treatment: undefined },
      { requireCounterparty: true }
    );
    expect(plan).toMatchObject({ business: false, treatment: "internal", deductible: 37.5, nonDeductible: 0 });
    expect(plan.warnings.join(" ")).toContain("R 4.10 Abs. 5 Satz 9");
  });

  it("lists ALL missing fields in one message, including counterparty", () => {
    let message = "";
    try {
      planMissingInvoice(
        { original_invoice_status: "missing_requested", entertainment_type: "business" },
        { requireCounterparty: true }
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    for (const field of ["missing_invoice_treatment", "gross_amount", "payment_evidence", "invoice_requests", "counterparty"]) {
      expect(message).toContain(field);
    }
  });

  it("does not require counterparty when a source receipt is given, nor invoice_requests for lost", () => {
    expect(() =>
      planMissingInvoice(
        { ...base, original_invoice_status: "lost", invoice_requests: undefined, counterparty: undefined, source_receipt_id_by_customer: 530 },
        { requireCounterparty: true }
      )
    ).not.toThrow();
  });

  it("rejects food/drinks amounts and a tip above the gross amount", () => {
    expect(() => planMissingInvoice({ ...base, food_net: 10 }, { requireCounterparty: true })).toThrow(/food|drinks/);
    expect(() => planMissingInvoice({ ...base, tip: 50 }, { requireCounterparty: true })).toThrow(/tip/);
  });

  it("requires acknowledge_practice_over_250 above 250 EUR for the practice variant", () => {
    expect(() => planMissingInvoice({ ...base, gross_amount: 260 }, { requireCounterparty: true })).toThrow(/acknowledge_practice_over_250/);
    const plan = planMissingInvoice({ ...base, gross_amount: 260, acknowledge_practice_over_250: true }, { requireCounterparty: true });
    expect(plan.warnings.join(" ")).toContain("keine Quelle");
  });

  it("allows conservative above 250 EUR without acknowledgement", () => {
    expect(() =>
      planMissingInvoice(
        { ...base, gross_amount: 260, missing_invoice_treatment: "conservative_100_nondeductible" },
        { requireCounterparty: true }
      )
    ).not.toThrow();
  });

  it("builds page notes with status, requests and payment evidence", () => {
    const plan = planMissingInvoice(base, { requireCounterparty: true });
    const notes = plan.page.noteLines.join("\n");
    expect(notes).toContain("nicht vorhanden");
    expect(notes).toContain("2026-07-31");
    expect(notes).toContain("1001");
  });

  it("rejects sole_proprietor_self on its own, with the Verpflegungspauschale hint", () => {
    expect(() => planMissingInvoice({ ...base, entertainment_type: "sole_proprietor_self" }, { requireCounterparty: true })).toThrow(/Verpflegungs/);
  });

  it("puts the practice warnings and Q42 into the page notes, with the Vorsteuer sentence once", () => {
    const notes = planMissingInvoice(base, { requireCounterparty: true }).page.noteLines.join("\n");
    expect(notes).toContain("X R 57/09");
    expect(notes).toContain("Q42");
    expect(notes.split("Kein Vorsteuerabzug").length - 1).toBe(1);
  });

  it("puts the conservative 100 % note into the page notes, with the Vorsteuer sentence once", () => {
    const notes = planMissingInvoice(
      { ...base, missing_invoice_treatment: "conservative_100_nondeductible" },
      { requireCounterparty: true }
    ).page.noteLines.join("\n");
    expect(notes).toContain("100 % nicht abziehbar");
    expect(notes.split("Kein Vorsteuerabzug").length - 1).toBe(1);
  });

  it("puts the internal R 4.10 note into the page notes for non-business types", () => {
    const notes = planMissingInvoice(
      { ...base, entertainment_type: "internal_employees", missing_invoice_treatment: undefined },
      { requireCounterparty: true }
    ).page.noteLines.join("\n");
    expect(notes).toContain("R 4.10 Abs. 5 Satz 9");
  });

  it("rejects a gross amount of 0 or below", () => {
    expect(() => planMissingInvoice({ ...base, gross_amount: 0 }, { requireCounterparty: true })).toThrow(/gross_amount/);
    expect(() => planMissingInvoice({ ...base, gross_amount: -5 }, { requireCounterparty: true })).toThrow(/gross_amount/);
  });

  it("rejects a NaN gross amount", () => {
    expect(() => planMissingInvoice({ ...base, gross_amount: Number.NaN }, { requireCounterparty: true })).toThrow(/gross_amount/);
  });

  it("rejects a negative tip", () => {
    expect(() => planMissingInvoice({ ...base, tip: -1 }, { requireCounterparty: true })).toThrow(/tip/);
  });
});

describe("planMissingInvoice final review", () => {
  it("item 6: business with only employees yields the consistency warning exactly once", () => {
    const plan = planMissingInvoice({ ...base, participant_relations: ["employee", "employee"] }, { requireCounterparty: true });
    expect(plan.warnings.filter((w) => w.includes("kein Teilnehmer mit relation external"))).toHaveLength(1);
  });

  it("item 9: no repo path in the page notes, but the pointer stays in the warnings", () => {
    const plan = planMissingInvoice({ ...base, missing_invoice_treatment: "conservative_100_nondeductible" }, { requireCounterparty: true });
    expect(plan.page.noteLines.join("\n")).not.toContain("docs/");
    expect(plan.page.noteLines.join("\n")).toContain("100 % nicht abziehbar");
    expect(plan.warnings.join(" ")).toContain("docs/bewirtungsbeleg-faq.md");
  });
});
