import { describe, expect, it } from "vitest";
import { COUNTRY_ALIASES, getRateTable, lookupRate } from "./travel-rates.js";

const rate = (country: string, place: string | undefined) => {
  const r = lookupRate(country, place, 2026);
  return [r.full, r.partial, r.night];
};

describe("lookupRate", () => {
  it("returns the domestic rates without a table, also for years without a table", () => {
    const r = lookupRate("Deutschland", undefined, 2027);
    expect([r.full, r.partial, r.night, r.source]).toEqual([28, 14, 20, null]);
    expect(lookupRate("de", undefined, 2026).country).toBe("Deutschland");
  });

  it("throws for a foreign country when the year has no table (no silent fallback to a previous year)", () => {
    expect(() => lookupRate("Frankreich", undefined, 2027)).toThrow(/2027/);
    expect(() => getRateTable(2027)).toThrow(/Dezember/);
  });

  it.each([
    ["Österreich", undefined, [50, 33, 117]],
    ["Schweiz", "Bern", [82, 55, 195]],
    ["Schweiz", undefined, [70, 47, 195]],
    ["Frankreich", "Paris", [58, 39, 159]],
    ["Frankreich", undefined, [53, 36, 105]],
    ["Italien", "Rom", [48, 32, 150]],
    ["Spanien", "Palma de Mallorca", [44, 29, 142]],
    ["Niederlande", undefined, [58, 39, 167]],
    ["Vereinigtes Königreich", "London", [66, 44, 163]],
    ["USA", "New York City", [66, 44, 308]],
    ["USA", undefined, [59, 40, 182]],
    ["Türkei", undefined, [24, 16, 107]],
    ["China", "Peking", [57, 38, 184]],
    ["Luxemburg", undefined, [63, 42, 139]],
    ["Dänemark", undefined, [75, 50, 183]],
  ])("resolves %s %s", (country, place, expected) => {
    expect(rate(country, place)).toEqual(expected);
  });

  it("falls back to the Luxemburg rates for unknown countries and marks it", () => {
    const r = lookupRate("Atlantis", undefined, 2026);
    expect([r.full, r.partial, r.night, r.fallback]).toEqual([63, 42, 139, "luxembourg"]);
  });

  it("maps Mikronesien to the Philippinen rates (BMF note)", () => {
    expect(rate("Mikronesien", undefined)).toEqual(rate("Philippinen", undefined));
  });

  it("is case and whitespace insensitive", () => {
    expect(rate("  FRANKREICH ", " paris ")).toEqual([58, 39, 159]);
  });
});

describe("table integrity", () => {
  const table = getRateTable(2026);

  it("carries source and retrieval date", () => {
    expect(table.source).toContain("IV C 5 - S 2353/00094/007/012");
    expect(table.retrievedAt).toBe("2026-10-26");
  });

  it("every alias points to a country in the table", () => {
    const countries = new Set(table.entries.map((e) => e.country));
    for (const [alias, target] of Object.entries(COUNTRY_ALIASES)) {
      expect(countries.has(target), `${alias} -> ${target}`).toBe(true);
    }
  });

  it("every country with cities has an 'im Übrigen' row", () => {
    const byCountry = new Map<string, string[]>();
    for (const e of table.entries) byCountry.set(e.country, [...(byCountry.get(e.country) ?? []), e.place ?? ""]);
    for (const [country, places] of byCountry) {
      if (places.length > 1) expect(places, country).toContain("im Übrigen");
    }
  });

  it("has a plausible size and monotone rates", () => {
    expect(new Set(table.entries.map((e) => e.country)).size).toBe(166);
    for (const e of table.entries) expect(e.partial).toBeLessThanOrEqual(e.full);
  });
});
