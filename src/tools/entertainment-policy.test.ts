import { describe, expect, it } from "vitest";
import {
  accountAdvice,
  allShareholderManagers,
  collectMissingPolicyFields,
  consistencyWarnings,
  isBusinessAnlass,
  MISSING_INVOICE_TREATMENT_HELP,
  noInvoiceWarnings,
  resolveEntertainmentContext,
  SHAREHOLDER_MANAGER_TREATMENT_HELP,
  splitGross,
  typeFromParticipants,
  variantNote,
} from "./entertainment-policy.js";

// All data is invented.

describe("splitGross", () => {
  it("splits 37.50 into 26.25 / 11.25", () => {
    expect(splitGross(37.5)).toEqual({ deductible: 26.25, nonDeductible: 11.25 });
  });
  it("uses the same split for practice_70_30_no_vat", () => {
    expect(splitGross(37.5, "practice_70_30_no_vat")).toEqual({ deductible: 26.25, nonDeductible: 11.25 });
  });
  it("puts everything on the non-deductible side for conservative_100_nondeductible", () => {
    expect(splitGross(37.5, "conservative_100_nondeductible")).toEqual({ deductible: 0, nonDeductible: 37.5 });
  });
  it("keeps the sum exact for odd cents", () => {
    const s = splitGross(10.01);
    expect(Math.round((s.deductible + s.nonDeductible) * 100)).toBe(1001);
  });
});

describe("isBusinessAnlass", () => {
  it("is true for business and business_mixed", () => {
    expect(isBusinessAnlass("business")).toBe(true);
    expect(isBusinessAnlass("business_mixed")).toBe(true);
  });
  it("is false for internal_employees, attention and sole_proprietor_self", () => {
    expect(isBusinessAnlass("internal_employees")).toBe(false);
    expect(isBusinessAnlass("attention")).toBe(false);
    expect(isBusinessAnlass("sole_proprietor_self")).toBe(false);
  });
  it("follows the treatment for internal_shareholder_managers when everyone is a shareholder_manager", () => {
    expect(isBusinessAnlass("internal_shareholder_managers", "business_70_30")).toBe(true);
    expect(isBusinessAnlass("internal_shareholder_managers", "as_employees")).toBe(false);
    expect(isBusinessAnlass("internal_shareholder_managers", "business_70_30", ["shareholder_manager", "shareholder_manager"])).toBe(true);
  });
  it("ignores the treatment for a mixed group: external-like participant -> business, otherwise internal", () => {
    expect(isBusinessAnlass("internal_shareholder_managers", "as_employees", ["shareholder_manager", "external"])).toBe(true);
    expect(isBusinessAnlass("internal_shareholder_managers", "business_70_30", ["shareholder_manager", "employee"])).toBe(false);
  });
});

describe("allShareholderManagers", () => {
  it("is true when relations are unknown or all shareholder_manager", () => {
    expect(allShareholderManagers(undefined)).toBe(true);
    expect(allShareholderManagers(["shareholder_manager"])).toBe(true);
  });
  it("is false for an empty list or a mixed group", () => {
    expect(allShareholderManagers([])).toBe(false);
    expect(allShareholderManagers(["shareholder_manager", "employee"])).toBe(false);
  });
});

describe("resolveEntertainmentContext", () => {
  it("translates host_confirmed alone into present + signed and warns about the deprecation and the missing type", () => {
    const { context, warnings } = resolveEntertainmentContext({ host_confirmed: true });
    expect(context).toMatchObject({ invoiceStatus: "present", signed: true, viaAlias: true });
    expect(warnings.some((w) => w.includes("deprecated"))).toBe(true);
    expect(warnings.some((w) => w.includes("entertainment_type"))).toBe(true);
  });

  it("suggests a type from the participant relations when entertainment_type is missing", () => {
    const { warnings } = resolveEntertainmentContext({ bewirtungsangaben_signed: true, participant_relations: ["external"] });
    expect(warnings.some((w) => w.includes("Vorschlag") && w.includes("business"))).toBe(true);
  });

  it("rejects host_confirmed together with bewirtungsangaben_signed", () => {
    expect(() => resolveEntertainmentContext({ host_confirmed: true, bewirtungsangaben_signed: true })).toThrow(/host_confirmed/);
  });

  it("rejects host_confirmed together with original_invoice_status, even if the values would fit", () => {
    expect(() => resolveEntertainmentContext({ host_confirmed: true, original_invoice_status: "present" })).toThrow(/host_confirmed/);
  });

  it("allows host_confirmed together with the additional fields", () => {
    const { context } = resolveEntertainmentContext({
      host_confirmed: true,
      entertainment_type: "business",
      participant_relations: ["external"],
    });
    expect(context.type).toBe("business");
    expect(context.business).toBe(true);
  });

  it("uses the new fields when no alias is given", () => {
    const { context, warnings } = resolveEntertainmentContext({ bewirtungsangaben_signed: false, entertainment_type: "business" });
    expect(context).toMatchObject({ invoiceStatus: "present", signed: false, viaAlias: false });
    expect(warnings.some((w) => w.includes("deprecated"))).toBe(false);
  });

  it("requires entertainment_type when the invoice is missing", () => {
    expect(() => resolveEntertainmentContext({ original_invoice_status: "missing_requested" })).toThrow(/entertainment_type/);
  });

  it("lists ALL missing fields in one message", () => {
    let message = "";
    try {
      resolveEntertainmentContext({ original_invoice_status: "lost", entertainment_type: "internal_shareholder_managers" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(SHAREHOLDER_MANAGER_TREATMENT_HELP);
    expect(message).toContain(MISSING_INVOICE_TREATMENT_HELP);
  });

  it("requires missing_invoice_treatment for business types without invoice", () => {
    expect(() => resolveEntertainmentContext({ original_invoice_status: "lost", entertainment_type: "business" })).toThrow(
      /missing_invoice_treatment/
    );
    const { context } = resolveEntertainmentContext({
      original_invoice_status: "lost",
      entertainment_type: "business",
      missing_invoice_treatment: "practice_70_30_no_vat",
    });
    expect(context.missingTreatment).toBe("practice_70_30_no_vat");
  });

  it("does NOT require missing_invoice_treatment for internal_employees, attention or as_employees", () => {
    for (const type of ["internal_employees", "attention"] as const) {
      expect(() => resolveEntertainmentContext({ original_invoice_status: "lost", entertainment_type: type })).not.toThrow();
    }
    const { context } = resolveEntertainmentContext({
      original_invoice_status: "lost",
      entertainment_type: "internal_shareholder_managers",
      shareholder_manager_treatment: "as_employees",
    });
    expect(context.business).toBe(false);
  });

  it("requires shareholder_manager_treatment for internal_shareholder_managers even when the invoice is present", () => {
    expect(() => resolveEntertainmentContext({ entertainment_type: "internal_shareholder_managers" })).toThrow(/shareholder_manager_treatment/);
  });

  it("warns that shareholder_manager_treatment is ignored for a mixed group", () => {
    const { warnings } = resolveEntertainmentContext({
      entertainment_type: "internal_shareholder_managers",
      shareholder_manager_treatment: "business_70_30",
      participant_relations: ["shareholder_manager", "external"],
    });
    expect(warnings.some((w) => w.includes("shareholder_manager_treatment") && w.includes("ignoriert"))).toBe(true);
  });
});

describe("collectMissingPolicyFields", () => {
  it("asks for missing_invoice_treatment together with shareholder_manager_treatment (one round of questions)", () => {
    const missing = collectMissingPolicyFields({ entertainment_type: "internal_shareholder_managers" }, "lost");
    expect(missing).toContain(SHAREHOLDER_MANAGER_TREATMENT_HELP);
    expect(missing).toContain(MISSING_INVOICE_TREATMENT_HELP);
  });
  it("returns nothing when the invoice is present and no type is given", () => {
    expect(collectMissingPolicyFields({}, "present")).toEqual([]);
  });
});

describe("consistencyWarnings", () => {
  it("warns for business without any external participant", () => {
    const w = consistencyWarnings("business", ["shareholder_manager", "shareholder_manager"]);
    expect(w.some((x) => x.includes("Folie 6"))).toBe(true);
  });
  it("does not warn for business with an external participant", () => {
    expect(consistencyWarnings("business", ["shareholder_manager", "external"])).toEqual([]);
  });
  it("treats shareholder and freelancer like external", () => {
    expect(consistencyWarnings("business", ["shareholder"])).toEqual([]);
    expect(consistencyWarnings("business", ["freelancer"])).toEqual([]);
  });
  it("warns about a mixed group for internal_shareholder_managers with an external participant", () => {
    const w = consistencyWarnings("internal_shareholder_managers", ["shareholder_manager", "external"], "as_employees");
    expect(w.some((x) => x.includes("Q16") && x.includes("Q45"))).toBe(true);
  });
  it("warns that a treatment is ignored when it does not apply", () => {
    const w = consistencyWarnings("business", undefined, "as_employees");
    expect(w.some((x) => x.includes("ignoriert"))).toBe(true);
  });
});

describe("typeFromParticipants", () => {
  it("derives the type from the relations", () => {
    expect(typeFromParticipants([])).toBeUndefined();
    expect(typeFromParticipants(["external", "freelancer"])).toBe("business");
    expect(typeFromParticipants(["external", "employee"])).toBe("business_mixed");
    expect(typeFromParticipants(["shareholder_manager", "shareholder_manager"])).toBe("internal_shareholder_managers");
    expect(typeFromParticipants(["employee", "shareholder_manager"])).toBe("internal_employees");
  });
});

describe("accountAdvice", () => {
  it("names 4140 and the Lohnsteuer check for internal_employees", () => {
    const a = accountAdvice("internal_employees")!;
    expect(a).toContain("4140");
    expect(a).toContain("Lohnsteuer");
  });
  it("names 4653/4140 and R 4.10 for attention", () => {
    const a = accountAdvice("attention")!;
    expect(a).toContain("4653");
    expect(a).toContain("R 4.10");
  });
  it("adds the generic Geschäftsführervertrag note for as_employees, without a client reference", () => {
    const a = accountAdvice("internal_shareholder_managers", "as_employees")!;
    expect(a).toContain("Vergütungs- oder Sachbezugsverzicht");
  });
  it("has no advice for business types", () => {
    expect(accountAdvice("business")).toBeUndefined();
    expect(accountAdvice("internal_shareholder_managers", "business_70_30")).toBeUndefined();
  });
});

describe("noInvoiceWarnings and variantNote", () => {
  it("names BFH X R 57/09 and Q42 for practice_70_30_no_vat", () => {
    const { context } = resolveEntertainmentContext({
      original_invoice_status: "lost",
      entertainment_type: "business",
      missing_invoice_treatment: "practice_70_30_no_vat",
    });
    const w = noInvoiceWarnings(context).join(" ");
    expect(w).toContain("X R 57/09");
    expect(w).toContain("Q42");
    expect(variantNote(context)).toContain("practice_70_30_no_vat");
  });
  it("uses the internal text for non-business types", () => {
    const { context } = resolveEntertainmentContext({ original_invoice_status: "lost", entertainment_type: "internal_employees" });
    expect(noInvoiceWarnings(context).join(" ")).toContain("R 4.10 Abs. 5 Satz 9");
    expect(variantNote(context)).toBeUndefined();
  });
  it("produces no warnings when the invoice is present", () => {
    const { context } = resolveEntertainmentContext({ bewirtungsangaben_signed: true, entertainment_type: "business" });
    expect(noInvoiceWarnings(context)).toEqual([]);
  });
});
