import { describe, expect, it } from "vitest";
import {
  COUNTRY_ALIASES,
  PLACE_ALIASES,
  builtinRateTable,
  getRateTable,
  lookupRate,
  provisionalRateTable,
  type RateTable,
} from "./travel-rates.js";

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

  it("uses supplied tables before the built-in registry and marks provisional tables", () => {
    const base = getRateTable(2026);
    const online: RateTable = { ...base, year: 2027, origin: "online", entries: base.entries.map((e) => ({ ...e, full: e.full + 1 })) };
    const fromOnline = lookupRate("Österreich", undefined, 2027, { 2027: online });
    expect([fromOnline.full, fromOnline.provisional]).toEqual([51, false]);
    const provisional = lookupRate("Österreich", undefined, 2027, { 2027: provisionalRateTable(2027) });
    expect([provisional.full, provisional.provisional, provisional.provisionalFrom]).toEqual([50, true, 2026]);
    expect(lookupRate("Österreich", undefined, 2026).provisional).toBe(false);
    expect(lookupRate("Deutschland", undefined, 2027, {}).provisional).toBe(false);
  });

  it("builtinRateTable marks the origin, provisionalRateTable takes the latest table up to the year, else the highest", () => {
    expect(builtinRateTable(2026)?.origin).toBe("builtin");
    expect(builtinRateTable(2027)).toBeUndefined();
    const p2027 = provisionalRateTable(2027);
    expect([p2027.year, p2027.origin, p2027.provisionalFrom]).toEqual([2027, "provisional", 2026]);
    expect(p2027.source).toContain("Vorläufig");
    expect(p2027.entries).toBe(getRateTable(2026).entries);
    expect(provisionalRateTable(2020).provisionalFrom).toBe(2026);
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
    expect([r.full, r.partial, r.night, r.fallback]).toEqual([
      63,
      42,
      139,
      "luxembourg",
    ]);
  });

  it("maps Mikronesien to the Philippinen rates (BMF note)", () => {
    expect(rate("Mikronesien", undefined)).toEqual(
      rate("Philippinen", undefined),
    );
  });

  it("is case and whitespace insensitive", () => {
    expect(rate("  FRANKREICH ", " paris ")).toEqual([58, 39, 159]);
  });
});

describe("place matching", () => {
  const hit = (country: string, place: string | undefined) => {
    const r = lookupRate(country, place, 2026);
    return [r.full, r.partial, r.night, r.placeMatched];
  };

  it("treats a whitespace-only place as no place", () => {
    expect(hit("USA", " ")).toEqual([59, 40, 182, "rest"]);
    expect(hit("USA", undefined)).toEqual([59, 40, 182, "rest"]);
  });

  it("does not match very short strings to unrelated cities", () => {
    expect(hit("Australien", "a")).toEqual([57, 38, 173, "rest"]);
    expect(hit("Spanien", "e")).toEqual([34, 23, 103, "rest"]);
    expect(hit("USA", "Los")).toEqual([64, 43, 262, "city"]); // 3 chars, unique prefix
  });

  it("matches unique prefixes, aliases and exact names", () => {
    expect(hit("Spanien", "Palma")).toEqual([44, 29, 142, "city"]);
    expect(hit("USA", "Washington")).toEqual([66, 44, 203, "city"]);
    expect(hit("USA", "Washington DC")).toEqual([66, 44, 203, "city"]);
    expect(hit("Japan", "Tokyo")).toEqual([50, 33, 285, "city"]);
    expect(hit("Spanien", "Teneriffa")).toEqual([36, 24, 103, "city"]);
    expect(hit("Frankreich", "Roissy")).toEqual([58, 39, 159, "city"]);
  });

  it("resolves 'San' in the USA to San Francisco (the only San* row)", () => {
    expect(hit("USA", "San")).toEqual([59, 40, 327, "city"]);
  });

  it("uses the 'im Übrigen' row with placeMatched 'rest' for an unmatched place", () => {
    expect(hit("Frankreich", "Atlantis-Stadt")).toEqual([53, 36, 105, "rest"]);
  });

  it("reports n/a for single-row countries and domestic", () => {
    expect(hit("Österreich", "Wien")).toEqual([50, 33, 117, "n/a"]);
    expect(hit("Luxemburg", undefined)).toEqual([63, 42, 139, "n/a"]);
    expect(hit("Deutschland", undefined)[3]).toBe("n/a");
  });
});

describe("table integrity", () => {
  it("every place alias points to an existing place in the table", () => {
    const places = new Set(getRateTable(2026).entries.map((e) => e.place));
    for (const [alias, target] of Object.entries(PLACE_ALIASES)) {
      expect(places.has(target), `${alias} -> ${target}`).toBe(true);
    }
  });

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
    for (const e of table.entries)
      byCountry.set(e.country, [
        ...(byCountry.get(e.country) ?? []),
        e.place ?? "",
      ]);
    for (const [country, places] of byCountry) {
      if (places.length > 1) expect(places, country).toContain("im Übrigen");
    }
  });

  it("has a plausible size and monotone rates", () => {
    expect(new Set(table.entries.map((e) => e.country)).size).toBe(166);
    for (const e of table.entries)
      expect(e.partial).toBeLessThanOrEqual(e.full);
  });
});
