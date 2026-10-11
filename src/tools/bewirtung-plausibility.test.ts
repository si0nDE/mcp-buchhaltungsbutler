import { describe, expect, it } from "vitest";
import {
  daysBetween,
  extractDateCandidates,
  largeAmountNotice,
  parseFlexibleDate,
  transactionDateWarnings,
  vatRatePlausibility,
  zeitnahWarning,
} from "./bewirtung-plausibility.js";

describe("dates", () => {
  it("parses ISO, ISO with time and German dates", () => {
    expect(parseFlexibleDate("2026-07-29")).toBe(parseFlexibleDate("29.07.2026"));
    expect(parseFlexibleDate("2026-07-29 00:00:00")).toBe(parseFlexibleDate("2026-07-29"));
    expect(parseFlexibleDate("kein Datum")).toBeUndefined();
  });
  it("counts calendar days", () => {
    expect(daysBetween("2026-07-29", "2026-07-31")).toBe(2);
  });
});

describe("transactionDateWarnings", () => {
  it("does not warn up to 3 days (card bookings run 1-2 days late)", () => {
    expect(transactionDateWarnings("2026-07-29", "2026-07-31 00:00:00")).toEqual([]);
    expect(transactionDateWarnings("2026-07-29", "2026-08-01 00:00:00")).toEqual([]);
  });
  it("warns from 4 days", () => {
    expect(transactionDateWarnings("2026-07-29", "2026-08-02 00:00:00")[0]).toContain("4 Kalendertage");
  });
});

describe("zeitnahWarning", () => {
  it("does not warn within 10 days", () => {
    expect(zeitnahWarning("2026-07-29", new Date("2026-08-08T10:00:00Z"))).toBeUndefined();
  });
  it("warns after more than 10 days and names GoBD Rz. 47 and the BMF Rn.", () => {
    const text = zeitnahWarning("2026-07-29", new Date("2026-10-11T10:00:00Z"))!;
    expect(text).toContain("74 Tage");
    expect(text).toContain("Orientierung an GoBD Rz. 47 (10 Tage), keine Frist speziell für Bewirtungsbelege");
    expect(text).toContain("Rn. 1");
  });
});

describe("vatRatePlausibility", () => {
  const food = (net: number, rate: number) => ({ foodNet: net, foodVat: Math.round(net * rate) / 100, drinksNet: 0, drinksVat: 0 });
  it("flags 19 % on food from 2026 as a conflict", () => {
    const r = vatRatePlausibility({ date: "2026-03-01", ...food(100, 19) });
    expect(r.warnings.length).toBe(1);
    expect(r.hints).toEqual([]);
  });
  it("flags 7 % on food in the second half of 2020 (5 % then)", () => {
    expect(vatRatePlausibility({ date: "2020-09-01", ...food(100, 7) }).warnings.length).toBe(1);
  });
  it("only hints at 7 % on food in 2025 (takeaway is a delivery)", () => {
    const r = vatRatePlausibility({ date: "2025-05-10", ...food(100, 7) });
    expect(r.warnings).toEqual([]);
    expect(r.hints[0]).toContain("Mitnehmen");
  });
  it("does not check drinks and stays silent for 7 % food in 2026", () => {
    expect(vatRatePlausibility({ date: "2025-05-10", foodNet: 0, foodVat: 0, drinksNet: 100, drinksVat: 19 })).toEqual({ warnings: [], hints: [] });
    expect(vatRatePlausibility({ date: "2026-05-10", ...food(100, 7) })).toEqual({ warnings: [], hints: [] });
  });
});

describe("largeAmountNotice", () => {
  it("is silent up to 250 EUR including the tip and names Rn. 9-12 above", () => {
    expect(largeAmountNotice(250)).toBeUndefined();
    expect(largeAmountNotice(255)).toContain("Rn. 9");
  });
});

describe("extractDateCandidates", () => {
  it("finds German, ISO and short-year dates, unique and sorted", () => {
    const text = "Datum: 08.10.2026 11:01\nTSE Start 2026-10-08T11:01\nDruck 08.10.26 11:33\nFällig 22.10.2026";
    expect(extractDateCandidates(text)).toEqual(["2026-10-08", "2026-10-22"]);
  });
  it("returns an empty list for text without dates", () => {
    expect(extractDateCandidates("kein Datum hier")).toEqual([]);
  });
});
