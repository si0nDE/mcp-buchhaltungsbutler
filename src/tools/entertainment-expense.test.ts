import { describe, expect, it } from "vitest";
import {
  assertEntertainmentExpenseFields,
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
