import { describe, expect, it } from "vitest";
import {
  assertEntertainmentExpenseFields,
  computeEntertainmentReclass,
  guardEntertainmentBooking,
  formatEntertainmentExpenseNote,
  matchEntertainmentAccount,
} from "./entertainment-expense.js";

describe("matchEntertainmentAccount", () => {
  it("returns undefined for an ordinary expense account", () => {
    expect(matchEntertainmentAccount(6815)).toBeUndefined();
  });

  it("matches the SKR03 deductible account (4650)", () => {
    expect(matchEntertainmentAccount(4650)).toBe("deductible");
  });

  it("matches the SKR03 non-deductible account (4654)", () => {
    expect(matchEntertainmentAccount(4654)).toBe("non_deductible");
  });

  it("matches the SKR04 deductible account (6640)", () => {
    expect(matchEntertainmentAccount(6640)).toBe("deductible");
  });

  it("matches the SKR04 non-deductible account (6644)", () => {
    expect(matchEntertainmentAccount(6644)).toBe("non_deductible");
  });
});

const validFields = { participants: "Person A, Person B", occasion: "Kundengespräch", host_confirmed: true as const };

describe("assertEntertainmentExpenseFields", () => {
  it("does nothing and returns undefined when no split is an entertainment-expense account", () => {
    expect(
      assertEntertainmentExpenseFields([{ postingaccount: 6815, amount: "100.00" }], {})
    ).toBeUndefined();
  });

  it("throws when the deductible split has no paired non-deductible split", () => {
    expect(() =>
      assertEntertainmentExpenseFields([{ postingaccount: 4650, amount: "70.00" }], validFields)
    ).toThrow(/4654/);
  });

  it("throws when the non-deductible split has no paired deductible split", () => {
    expect(() =>
      assertEntertainmentExpenseFields([{ postingaccount: 4654, amount: "30.00" }], validFields)
    ).toThrow(/4650/);
  });

  it("throws asking for participants when missing", () => {
    expect(() =>
      assertEntertainmentExpenseFields(
        [
          { postingaccount: 4650, amount: "70.00" },
          { postingaccount: 4654, amount: "30.00" },
        ],
        { occasion: "Kundengespräch", host_confirmed: true }
      )
    ).toThrow(/participants/);
  });

  it("throws asking for the occasion when missing", () => {
    expect(() =>
      assertEntertainmentExpenseFields(
        [
          { postingaccount: 4650, amount: "70.00" },
          { postingaccount: 4654, amount: "30.00" },
        ],
        { participants: "Person A, Person B", host_confirmed: true }
      )
    ).toThrow(/occasion/);
  });

  it("throws asking the caller to confirm a signed Bewirtungsbeleg when host_confirmed is missing", () => {
    expect(() =>
      assertEntertainmentExpenseFields(
        [
          { postingaccount: 4650, amount: "70.00" },
          { postingaccount: 4654, amount: "30.00" },
        ],
        { participants: "Person A, Person B", occasion: "Kundengespräch" }
      )
    ).toThrow(/ask the user/);
  });

  it("throws when host_confirmed is explicitly false, instructing the caller to ask the user rather than book the standard split", () => {
    expect(() =>
      assertEntertainmentExpenseFields(
        [
          { postingaccount: 4650, amount: "70.00" },
          { postingaccount: 4654, amount: "30.00" },
        ],
        { participants: "Person A, Person B", occasion: "Kundengespräch", host_confirmed: false }
      )
    ).toThrow(/ask the user/);
  });

  it("throws when the split ratio is not approximately 70/30", () => {
    expect(() =>
      assertEntertainmentExpenseFields(
        [
          { postingaccount: 4650, amount: "50.00" },
          { postingaccount: 4654, amount: "50.00" },
        ],
        validFields
      )
    ).toThrow(/70.*30/);
  });

  it("ignores an accompanying VAT split when checking the ratio", () => {
    expect(
      assertEntertainmentExpenseFields(
        [
          { postingaccount: 4650, amount: "70.00" },
          { postingaccount: 4654, amount: "30.00" },
          { postingaccount: 1576, amount: "19.00" },
        ],
        validFields
      )
    ).toBe(true);
  });

  it("accepts a ratio within the ±0.02 EUR rounding tolerance", () => {
    expect(
      assertEntertainmentExpenseFields(
        [
          { postingaccount: 4650, amount: "70.01" },
          { postingaccount: 4654, amount: "29.99" },
        ],
        validFields
      )
    ).toBe(true);
  });

  it("rejects a ratio just outside the ±0.02 EUR tolerance", () => {
    expect(() =>
      assertEntertainmentExpenseFields(
        [
          { postingaccount: 4650, amount: "70.05" },
          { postingaccount: 4654, amount: "29.95" },
        ],
        validFields
      )
    ).toThrow(/70.*30/);
  });

  it("sums multiple splits on the same band before checking the ratio", () => {
    expect(
      assertEntertainmentExpenseFields(
        [
          { postingaccount: 4650, amount: "40.00" },
          { postingaccount: 4650, amount: "30.00" },
          { postingaccount: 4654, amount: "30.00" },
        ],
        validFields
      )
    ).toBe(true);
  });

  it("works for the SKR04 accounts (6640/6644)", () => {
    expect(
      assertEntertainmentExpenseFields(
        [
          { postingaccount: 6640, amount: "70.00" },
          { postingaccount: 6644, amount: "30.00" },
        ],
        validFields
      )
    ).toBe(true);
  });
});

describe("formatEntertainmentExpenseNote", () => {
  it("includes participants and occasion", () => {
    const note = formatEntertainmentExpenseNote({ participants: "Person A, Person B", occasion: "Kundengespräch" });
    expect(note).toContain("Person A, Person B");
    expect(note).toContain("Kundengespräch");
  });
});

const guardBase = { participants: "Max Mustermann, Erika Beispiel", occasion: "Besprechung zur Angebotsplanung 2026" };
const noInvoicePractice = {
  ...guardBase,
  original_invoice_status: "missing_requested" as const,
  entertainment_type: "business" as const,
  missing_invoice_treatment: "practice_70_30_no_vat" as const,
  bewirtungsangaben_signed: true,
};

describe("guardEntertainmentBooking", () => {
  it("returns nothing for an ordinary account and no entertainment fields", () => {
    expect(guardEntertainmentBooking([{ postingaccount: 6815, amount: "10.00", vat: "19_pre" }], {})).toEqual({
      entertainment: undefined,
      warnings: [],
    });
  });

  it("blocks a _pre code without invoice on ANY account, also 4140", () => {
    expect(() =>
      guardEntertainmentBooking([{ postingaccount: 4140, amount: "37.50", vat: "19_pre" }], {
        original_invoice_status: "lost",
        entertainment_type: "internal_employees",
      })
    ).toThrow(/Vorsteuer ohne Rechnung/);
    expect(() =>
      guardEntertainmentBooking(
        [
          { postingaccount: 4650, amount: "26.25", vat: "7_pre" },
          { postingaccount: 4654, amount: "11.25", vat: "0_none" },
        ],
        noInvoicePractice
      )
    ).toThrow(/Vorsteuer ohne Rechnung/);
  });

  it("practice: 70/30 with 0_none passes and warns with BFH X R 57/09 and Q42", () => {
    const result = guardEntertainmentBooking(
      [
        { postingaccount: 4650, amount: "26.25", vat: "0_none" },
        { postingaccount: 4654, amount: "11.25", vat: "0_none" },
      ],
      noInvoicePractice
    );
    expect(result.entertainment).toBe(true);
    expect(result.warnings.join(" ")).toContain("X R 57/09");
    expect(result.variant).toContain("practice_70_30_no_vat");
  });

  it("practice requires bewirtungsangaben_signed", () => {
    expect(() =>
      guardEntertainmentBooking(
        [
          { postingaccount: 4650, amount: "26.25", vat: "0_none" },
          { postingaccount: 4654, amount: "11.25", vat: "0_none" },
        ],
        { ...noInvoicePractice, bewirtungsangaben_signed: false }
      )
    ).toThrow(/bewirtungsangaben_signed/);
  });

  it("practice still enforces the 70/30 ratio", () => {
    expect(() =>
      guardEntertainmentBooking(
        [
          { postingaccount: 4650, amount: "37.50", vat: "0_none" },
          { postingaccount: 4654, amount: "0.00", vat: "0_none" },
        ],
        noInvoicePractice
      )
    ).toThrow();
  });

  it("conservative: only 4654 passes, an unsigned page only warns", () => {
    const fields = {
      ...guardBase,
      original_invoice_status: "lost" as const,
      entertainment_type: "business" as const,
      missing_invoice_treatment: "conservative_100_nondeductible" as const,
      bewirtungsangaben_signed: false,
    };
    const result = guardEntertainmentBooking([{ postingaccount: 4654, amount: "37.50", vat: "0_none" }], fields);
    expect(result.entertainment).toBe(true);
    expect(result.warnings.join(" ")).toContain("bewirtungsangaben_signed");
  });

  it("conservative rejects a deductible 4650 split", () => {
    expect(() =>
      guardEntertainmentBooking(
        [
          { postingaccount: 4650, amount: "26.25", vat: "0_none" },
          { postingaccount: 4654, amount: "11.25", vat: "0_none" },
        ],
        {
          ...guardBase,
          original_invoice_status: "lost",
          entertainment_type: "business",
          missing_invoice_treatment: "conservative_100_nondeductible",
          bewirtungsangaben_signed: true,
        }
      )
    ).toThrow(/4654/);
  });

  it("rejects net_reclass without an invoice (no net amount exists)", () => {
    expect(() =>
      guardEntertainmentBooking([{ postingaccount: 4650, amount: "37.50", vat: "0_none" }], {
        ...noInvoicePractice,
        entertainment_split_mode: "net_reclass",
      })
    ).toThrow(/net_reclass/);
  });

  it("keeps the legacy alias path unchanged: host_confirmed true with a 70/30 split and an input VAT code", () => {
    const result = guardEntertainmentBooking(
      [
        { postingaccount: 4650, amount: "30.80", vat: "19_pre" },
        { postingaccount: 4654, amount: "13.20", vat: "0_none" },
      ],
      { participants: "Person A", occasion: "Kundengespräch zur Planung", host_confirmed: true }
    );
    expect(result.entertainment).toBe(true);
    expect(result.warnings.some((w) => w.includes("deprecated"))).toBe(true);
  });

  it("rejects the alias together with original_invoice_status", () => {
    expect(() =>
      guardEntertainmentBooking([{ postingaccount: 4650, amount: "30.80", vat: "0_none" }], {
        ...guardBase,
        host_confirmed: true,
        original_invoice_status: "present",
      })
    ).toThrow(/host_confirmed/);
  });

  it("a non-business type on 4650/4654 only warns and does not enforce the 70/30 split", () => {
    const result = guardEntertainmentBooking([{ postingaccount: 4650, amount: "37.50", vat: "19_pre" }], {
      ...guardBase,
      bewirtungsangaben_signed: true,
      entertainment_type: "internal_employees",
    });
    expect(result.entertainment).toBe(true);
    expect(result.warnings.join(" ")).toContain("4140");
  });

  it("advises on 4140 for an internal type without an invoice and does not mark it as entertainment", () => {
    const result = guardEntertainmentBooking([{ postingaccount: 4140, amount: "37.50", vat: "0_none" }], {
      original_invoice_status: "lost",
      entertainment_type: "internal_employees",
    });
    expect(result.entertainment).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("R 4.10 Abs. 5 Satz 9");
  });
  it("sole_proprietor_self: one specific warning instead of the internal no-invoice text", () => {
    const present = guardEntertainmentBooking([{ postingaccount: 4140, amount: "37.50", vat: "0_none" }], {
      original_invoice_status: "present",
      entertainment_type: "sole_proprietor_self",
    });
    expect(present.warnings.join(" ")).toContain("Verpflegungsmehraufwendungen (14 € / 28 €)");
    expect(present.warnings.join(" ")).not.toContain("R 4.10 Abs. 5 Satz 9");
    const lost = guardEntertainmentBooking([{ postingaccount: 4140, amount: "37.50", vat: "0_none" }], {
      original_invoice_status: "lost",
      entertainment_type: "sole_proprietor_self",
    });
    expect(lost.warnings.filter((w) => w.includes("sole_proprietor_self"))).toHaveLength(1);
    expect(lost.warnings.join(" ")).not.toContain("R 4.10 Abs. 5 Satz 9");
  });
});

describe("computeEntertainmentReclass with invoice_net_total", () => {
  const splits = [
    { postingaccount: 4650, amount: "14.15", vat: "7_pre" },
    { postingaccount: 4650, amount: "8.80", vat: "19_pre" },
  ];
  it("uses the invoice net 20.60 -> reclass 6.18", () => {
    const hint = computeEntertainmentReclass(splits, 20.6)!;
    expect(hint.net_total).toBe("20.60");
    expect(hint.amount).toBe("6.18");
  });
  it("derives 20.62 -> 6.19 without the override and points at invoice_net_total", () => {
    const hint = computeEntertainmentReclass(splits)!;
    expect(hint.net_total).toBe("20.62");
    expect(hint.amount).toBe("6.19");
    expect(hint.note).toContain("invoice_net_total");
  });
});

describe("formatEntertainmentExpenseNote with variant", () => {
  it("appends the variant and stays within 210 bytes", () => {
    const note = formatEntertainmentExpenseNote({
      participants: "Max Mustermann (Beispiel GmbH), Erika Beispiel (Muster AG), Hans Testmann (Test KG)",
      occasion: "Gespräch mit Netzwerkpartnern zur Planung einer gemeinsamen Veranstaltung im Herbst 2026 inklusive Budgetabstimmung",
      variant: "Rechnung lost; Variante: practice_70_30_no_vat (Q42) – Nutzerentscheid",
    });
    expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(210);
    expect(note).toContain("Variante: practice_70_30_no_vat");
  });
});

describe("guardEntertainmentBooking fix round 1", () => {
  it("non-business type on 4650 without participants/occasion/signed only warns", () => {
    const result = guardEntertainmentBooking([{ postingaccount: 4650, amount: "37.50", vat: "0_none" }], {
      entertainment_type: "internal_employees",
    });
    expect(result.entertainment).toBe(true);
    expect(result.warnings.join(" ")).toContain("participants");
    expect(result.warnings.join(" ")).toContain("4140");
  });

  it("sole_proprietor_self on 4650 does not throw and emits exactly one type warning", () => {
    const result = guardEntertainmentBooking([{ postingaccount: 4650, amount: "37.50", vat: "0_none" }], {
      entertainment_type: "sole_proprietor_self",
    });
    expect(result.warnings.filter((w) => w.includes("sole_proprietor_self"))).toHaveLength(1);
  });

  it("business type without signed still throws", () => {
    expect(() =>
      guardEntertainmentBooking(
        [
          { postingaccount: 4650, amount: "26.25", vat: "0_none" },
          { postingaccount: 4654, amount: "11.25", vat: "0_none" },
        ],
        { ...guardBase, entertainment_type: "business", bewirtungsangaben_signed: false }
      )
    ).toThrow(/bewirtungsangaben_signed/);
  });

  it("legacy call without type and unsigned still throws", () => {
    expect(() =>
      guardEntertainmentBooking(
        [
          { postingaccount: 4650, amount: "26.25", vat: "0_none" },
          { postingaccount: 4654, amount: "11.25", vat: "0_none" },
        ],
        guardBase
      )
    ).toThrow(/host_confirmed|bewirtungsangaben_signed/);
  });

  it("blocks a _pre_app code without invoice", () => {
    expect(() =>
      guardEntertainmentBooking([{ postingaccount: 4140, amount: "37.50", vat: "19_pre_app" }], {
        original_invoice_status: "lost",
        entertainment_type: "internal_employees",
      })
    ).toThrow(/Vorsteuer ohne Rechnung/);
  });

  it("a split without vat does not crash and does not trigger the _pre block", () => {
    expect(() =>
      guardEntertainmentBooking([{ postingaccount: 4140, amount: "37.50" }], {
        original_invoice_status: "lost",
        entertainment_type: "internal_employees",
      })
    ).not.toThrow();
  });
});
