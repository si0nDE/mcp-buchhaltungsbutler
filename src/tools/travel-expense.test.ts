import { describe, expect, it } from "vitest";
import { assertTravelExpenseFields, formatTravelExpenseNote, matchTravelExpenseAccount } from "./travel-expense.js";

describe("matchTravelExpenseAccount", () => {
  it("returns undefined for an ordinary expense account", () => {
    expect(matchTravelExpenseAccount(6815)).toBeUndefined();
  });

  it("matches the SKR03 Arbeitnehmer range (4660-4668)", () => {
    expect(matchTravelExpenseAccount(4663)).toEqual({ role: "employee", label: "Arbeitnehmer" });
    expect(matchTravelExpenseAccount(4660)).toEqual({ role: "employee", label: "Arbeitnehmer" });
    expect(matchTravelExpenseAccount(4668)).toEqual({ role: "employee", label: "Arbeitnehmer" });
  });

  it("excludes accounts just outside the SKR03 Arbeitnehmer range", () => {
    expect(matchTravelExpenseAccount(4659)).toBeUndefined();
    expect(matchTravelExpenseAccount(4669)).toBeUndefined();
  });

  it("matches the SKR03 Unternehmer range (4670-4678)", () => {
    expect(matchTravelExpenseAccount(4673)).toEqual({ role: "owner_manager", label: "Unternehmer" });
    expect(matchTravelExpenseAccount(4670)).toEqual({ role: "owner_manager", label: "Unternehmer" });
    expect(matchTravelExpenseAccount(4678)).toEqual({ role: "owner_manager", label: "Unternehmer" });
  });

  it("matches the SKR04 Arbeitnehmer range (6650-6668)", () => {
    expect(matchTravelExpenseAccount(6663)).toEqual({ role: "employee", label: "Arbeitnehmer" });
    expect(matchTravelExpenseAccount(6650)).toEqual({ role: "employee", label: "Arbeitnehmer" });
    expect(matchTravelExpenseAccount(6668)).toEqual({ role: "employee", label: "Arbeitnehmer" });
  });

  it("matches the SKR04 Unternehmer range (6670-6680)", () => {
    expect(matchTravelExpenseAccount(6673)).toEqual({ role: "owner_manager", label: "Unternehmer" });
    expect(matchTravelExpenseAccount(6670)).toEqual({ role: "owner_manager", label: "Unternehmer" });
    expect(matchTravelExpenseAccount(6680)).toEqual({ role: "owner_manager", label: "Unternehmer" });
  });

  it("excludes accounts just outside the SKR04 ranges", () => {
    expect(matchTravelExpenseAccount(6649)).toBeUndefined();
    expect(matchTravelExpenseAccount(6669)).toBeUndefined();
    expect(matchTravelExpenseAccount(6681)).toBeUndefined();
  });
});

describe("assertTravelExpenseFields", () => {
  it("does nothing and returns undefined when no account is a travel-expense account", () => {
    expect(assertTravelExpenseFields([6815, 1576], {})).toBeUndefined();
  });

  it("throws asking the caller to find out who traveled when traveler_name is missing", () => {
    expect(() => assertTravelExpenseFields([4663], { traveler_role: "employee", business_purpose: "Kundentermin" })).toThrow(
      /traveler_name/
    );
  });

  it("throws asking the caller to clarify the role when traveler_role is missing", () => {
    expect(() =>
      assertTravelExpenseFields([4663], { traveler_name: "Person A", business_purpose: "Kundentermin" })
    ).toThrow(/traveler_role/);
  });

  it("throws when traveler_role is 'unclear', instructing the caller to ask the user rather than guess", () => {
    expect(() =>
      assertTravelExpenseFields([4663], {
        traveler_name: "Person A",
        traveler_role: "unclear",
        business_purpose: "Kundentermin",
      })
    ).toThrow(/ask the user/);
  });

  it("throws asking for the business purpose when it is missing", () => {
    expect(() =>
      assertTravelExpenseFields([4663], { traveler_name: "Person A", traveler_role: "employee" })
    ).toThrow(/business_purpose/);
  });

  it("throws on a role/account-range mismatch instead of silently booking", () => {
    expect(() =>
      assertTravelExpenseFields([4663], {
        traveler_name: "Person A",
        traveler_role: "owner_manager",
        business_purpose: "Kundentermin",
      })
    ).toThrow(/4660.{1,5}4668/);
  });

  it("returns the matched band when all fields are present and consistent", () => {
    expect(
      assertTravelExpenseFields([4673], {
        traveler_name: "Person A",
        traveler_role: "owner_manager",
        business_purpose: "Kundentermin in München",
      })
    ).toEqual({ role: "owner_manager", label: "Unternehmer" });
  });
});

describe("formatTravelExpenseNote", () => {
  it("includes traveler name, role label, and business purpose", () => {
    const note = formatTravelExpenseNote({
      traveler_name: "Person A",
      traveler_role: "owner_manager",
      business_purpose: "Kundentermin in München",
    });
    expect(note).toContain("Person A");
    expect(note).toContain("Unternehmer");
    expect(note).toContain("Kundentermin in München");
  });
});
