import { describe, expect, it } from "vitest";
import { computeTrip, type TripInput } from "./travel-expense-calc.js";
import { getRateTable, lookupRate } from "./travel-rates.js";

const inland = (overrides: Partial<TripInput> = {}): TripInput => ({
  travellerType: "employee",
  departure: "2026-03-09T07:00",
  returnTime: "2026-03-11T18:00",
  stops: [{ country: "Deutschland", arrival: "2026-03-09T09:00" }],
  ...overrides,
});
const amounts = (input: TripInput) => computeTrip(input).days.map((d) => d.amount);

describe("computeTrip - Inland", () => {
  it("pays nothing for exactly 8 hours and 14 EUR above", () => {
    const single = (end: string) =>
      amounts(inland({ departure: "2026-03-09T08:00", returnTime: end, stops: [{ country: "Deutschland", arrival: "2026-03-09T09:00" }] }));
    expect(single("2026-03-09T16:00")).toEqual([0]);
    expect(single("2026-03-09T16:01")).toEqual([14]);
  });

  it("multi-day: arrival and departure day 14, full day 28, nights from the date difference", () => {
    const result = computeTrip(inland());
    expect(result.days.map((d) => [d.date, d.kind, d.amount])).toEqual([
      ["2026-03-09", "partial", 14],
      ["2026-03-10", "full", 28],
      ["2026-03-11", "partial", 14],
    ]);
    expect(result.allowanceTotal).toBe(56);
    expect(result.nights).toBe(2);
  });

  it("employees can claim 20 EUR lodging flat rate per night, self-employed cannot", () => {
    const withFlat = computeTrip(inland({ useLodgingFlatRate: true }));
    expect(withFlat.lodgingFlat.map((l) => l.amount)).toEqual([20, 20]);
    expect(withFlat.lodgingFlatTotal).toBe(40);
    expect(() => computeTrip(inland({ travellerType: "self_employed", useLodgingFlatRate: true }))).toThrow(
      /tatsächliche/
    );
  });

  it("reduces for provided meals: 20 % / 40 % of 28, never below zero", () => {
    const meals = (list: Array<"breakfast" | "lunch" | "dinner">) =>
      computeTrip(inland({ mealsProvided: { "2026-03-10": list } })).days[1];
    expect(meals(["breakfast"]).amount).toBe(22.4);
    expect(meals(["breakfast"]).reduction).toBe(5.6);
    expect(meals(["lunch", "dinner"]).amount).toBe(5.6);
    expect(meals(["breakfast", "lunch", "dinner"]).amount).toBe(0);
  });

  it("counts a meal given twice once and warns about meals outside the trip", () => {
    const twice = computeTrip(inland({ mealsProvided: { "2026-03-10": ["breakfast", "breakfast"] } }));
    expect(twice.days[1].amount).toBe(22.4);
    const outside = computeTrip(inland({ mealsProvided: { "2026-04-01": ["breakfast"] } }));
    expect(outside.warnings.some((w) => w.includes("2026-04-01") && w.includes("außerhalb"))).toBe(true);
  });

  it("treats a return at exactly 00:00 as the end of the previous day: no trailing day, no night for it", () => {
    const at = (departure: string, returnTime: string) =>
      computeTrip(
        inland({ departure, returnTime, stops: [{ country: "Deutschland", arrival: departure }], useLodgingFlatRate: true })
      );
    const single = at("2026-03-09T08:00", "2026-03-10T00:00");
    expect(single.days.map((d) => [d.date, d.hours, d.amount])).toEqual([["2026-03-09", 16, 14]]);
    expect(single.nights).toBe(0);
    expect(single.lodgingFlatTotal).toBe(0);
    const short = at("2026-03-09T17:00", "2026-03-10T00:00");
    expect(short.days.map((d) => [d.hours, d.amount])).toEqual([[7, 0]]);
    const two = at("2026-03-09T08:00", "2026-03-11T00:00");
    expect(two.days.map((d) => [d.date, d.kind, d.amount])).toEqual([
      ["2026-03-09", "partial", 14],
      ["2026-03-10", "partial", 14],
    ]);
    expect(two.nights).toBe(1);
  });

  it("gives no allowance for work through the night when both days together are 8 hours or less", () => {
    const result = computeTrip(
      inland({
        departure: "2026-03-09T22:00",
        returnTime: "2026-03-10T03:00",
        stops: [{ country: "Deutschland", arrival: "2026-03-09T22:30" }],
        overnightWithoutAccommodation: true,
      })
    );
    expect(result.days.map((d) => d.amount)).toEqual([0, 0]);
  });

  it("treats work through the night without accommodation as 14 EUR for the day with most absence", () => {
    const result = computeTrip(
      inland({
        departure: "2026-03-09T20:00",
        returnTime: "2026-03-10T09:00",
        stops: [{ country: "Deutschland", arrival: "2026-03-09T21:00" }],
        overnightWithoutAccommodation: true,
      })
    );
    expect(result.days.map((d) => d.amount)).toEqual([0, 14]);
    expect(result.nights).toBe(0);
  });
});

describe("computeTrip - Ausland", () => {
  it("uses the country of the last Tätigkeitsort on the departure day", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-03-09T06:00",
      returnTime: "2026-03-10T20:00",
      stops: [{ country: "Frankreich", arrival: "2026-03-09T10:00" }],
    });
    expect(result.days.map((d) => [d.country, d.amount])).toEqual([
      ["Frankreich", 36],
      ["Frankreich", 36],
    ]);
  });

  it("travelling overnight from Germany: first evening domestic, middle day abroad full rate", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-03-09T22:00",
      returnTime: "2026-03-11T20:00",
      stops: [{ country: "Frankreich", arrival: "2026-03-10T06:00" }],
    });
    expect(result.days.map((d) => [d.country, d.amount])).toEqual([
      ["Deutschland", 14],
      ["Frankreich", 53],
      ["Frankreich", 36],
    ]);
    expect(result.allowanceTotal).toBe(103);
  });

  it("matches the BMF example Kopenhagen: breakfast reduces by 20 % of 75 EUR = 15 EUR", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-03-09T08:00",
      returnTime: "2026-03-10T12:00",
      stops: [{ country: "Dänemark", arrival: "2026-03-09T23:00" }],
      mealsProvided: { "2026-03-10": ["breakfast"] },
    });
    expect(result.days[1].reduction).toBe(15);
    expect(result.days[1].amount).toBe(35);
    expect(result.allowanceTotal).toBe(85);
    expect(result.sources[0]).toContain("IV C 5 - S 2353/00094/007/012");
  });

  it("uses Österreich for the days in between on flights over more than two calendar days", () => {
    const tokio = lookupRate("Japan", "Tokio", 2026);
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-05-04T10:00",
      returnTime: "2026-05-08T20:00",
      stops: [{ country: "Japan", place: "Tokio", arrival: "2026-05-07T08:00", transport: "flight" }],
    });
    expect(result.days.map((d) => [d.date, d.country, d.amount])).toEqual([
      ["2026-05-04", "Deutschland", 14],
      ["2026-05-05", "Österreich", 50],
      ["2026-05-06", "Österreich", 50],
      ["2026-05-07", "Japan", tokio.full],
      ["2026-05-08", "Japan", tokio.partial],
    ]);
    expect(result.warnings.some((w) => w.includes("R 9.6 Abs. 3 LStR"))).toBe(true);
  });

  it("uses Luxemburg for the days in between on a ship passage", () => {
    const lux = lookupRate("Luxemburg", undefined, 2026);
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-06-01T10:00",
      returnTime: "2026-06-06T20:00",
      stops: [{ country: "Dänemark", arrival: "2026-06-04T08:00", transport: "ship" }],
    });
    expect(result.days.filter((d) => d.country === "Luxemburg").map((d) => d.amount)).toEqual([lux.full, lux.full]);
  });

  it("falls back to the Luxemburg rate for unknown countries and warns", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-03-09T06:00",
      returnTime: "2026-03-09T20:00",
      stops: [{ country: "Atlantis", arrival: "2026-03-09T09:00" }],
    });
    expect(result.days[0].amount).toBe(42);
    expect(result.warnings.some((w) => w.includes("Atlantis") && w.includes("Luxemburg"))).toBe(true);
  });
});

describe("computeTrip - Dreimonatsfrist", () => {
  const day = (date: string, since?: string) =>
    computeTrip({
      travellerType: "employee",
      departure: `${date}T08:00`,
      returnTime: `${date}T18:00`,
      stops: [{ country: "Deutschland", arrival: `${date}T09:00` }],
      sameLocationSince: since,
    });

  it("pays through the last day of the three months and nothing after", () => {
    expect(day("2026-04-09", "2026-01-10").days[0].amount).toBe(14);
    const late = day("2026-04-10", "2026-01-10");
    expect(late.days[0].amount).toBe(0);
    expect(late.days[0].note).toContain("Dreimonatsfrist");
  });

  it("warns that the rule was not checked when same_location_since is missing", () => {
    expect(day("2026-04-10").warnings.some((w) => w.includes("Dreimonatsfrist nicht geprüft"))).toBe(true);
  });
});

describe("computeTrip - Eingabefehler", () => {
  it("rejects a return before the departure", () => {
    expect(() => computeTrip(inland({ returnTime: "2026-03-09T06:00" }))).toThrow(/Rückkehr/);
  });

  it("rejects stops before the departure and after the return", () => {
    expect(() => computeTrip(inland({ stops: [{ country: "Deutschland", arrival: "2026-03-09T06:00" }] }))).toThrow(/Ankunft/);
    expect(() => computeTrip(inland({ stops: [{ country: "Deutschland", arrival: "2026-03-12T06:00" }] }))).toThrow(/Ankunft/);
  });

  it("rejects an empty stop list and impossible dates", () => {
    expect(() => computeTrip(inland({ stops: [] }))).toThrow(/Station/);
    expect(() => computeTrip(inland({ departure: "2026-02-31T08:00" }))).toThrow(/Ungültige Zeitangabe/);
    expect(() => computeTrip(inland({ departure: "09.03.2026 08:00" }))).toThrow(/YYYY-MM-DDTHH:mm/);
  });

  it("year change: foreign days without a 2027 table are provisional with the 2026 values and a warning; domestic trip works", () => {
    const base = { travellerType: "employee" as const, departure: "2026-12-31T08:00", returnTime: "2027-01-02T18:00" };
    const foreign = computeTrip({ ...base, stops: [{ country: "Frankreich", arrival: "2026-12-31T12:00" }] });
    expect(foreign.days.map((d) => [d.date, d.amount, d.provisional ?? false])).toEqual([
      ["2026-12-31", 36, false],
      ["2027-01-01", 53, true],
      ["2027-01-02", 36, true],
    ]);
    expect(
      foreign.warnings.filter((w) =>
        w.startsWith("BMF-Auslandstabelle 2027 nicht verfügbar (noch nicht veröffentlicht oder Abruf nicht möglich): Auslandssätze vorläufig mit der Tabelle 2026 berechnet.")
      )
    ).toHaveLength(1);
    expect(foreign.rateTables.map((t) => [t.year, t.origin, t.provisionalFrom])).toEqual([
      [2026, "builtin", undefined],
      [2027, "provisional", 2026],
    ]);
    const domestic = computeTrip({ ...base, stops: [{ country: "Deutschland", arrival: "2026-12-31T12:00" }] });
    expect(domestic.days.map((d) => d.amount)).toEqual([14, 28, 14]);
    expect(domestic.rateTables).toEqual([]);
  });

  it("years before 2025: dedicated warning that the rates are not those of the travel year (still provisional, no throw)", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2024-03-09T06:00",
      returnTime: "2024-03-09T20:00",
      stops: [{ country: "Frankreich", arrival: "2024-03-09T10:00" }],
    });
    expect(result.days[0]).toMatchObject({ amount: 36, provisional: true });
    expect(result.warnings).toContain(
      "BMF-Auslandstabelle 2024 nicht eingebaut und nicht online abrufbar (Abruf nur ab 2025): Sätze der Tabelle 2026 sind NICHT die Sätze des Reisejahrs, Abrechnung nicht übernehmen."
    );
    expect(result.warnings.some((w) => w.includes("Nach Veröffentlichung neu berechnen"))).toBe(false);
  });

  it("uses supplied rate tables (e.g. online) for a year without a built-in table", () => {
    const online = { ...getRateTable(2026), year: 2027, origin: "online" as const, source: "BMF, LStH 2027 Anhang 25 I, online", entries: getRateTable(2026).entries.map((e) => ({ ...e, full: e.full + 2, partial: e.partial + 1 })) };
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-12-31T08:00",
      returnTime: "2027-01-02T18:00",
      stops: [{ country: "Frankreich", arrival: "2026-12-31T12:00" }],
      rateTables: { 2027: online },
    });
    expect(result.days.map((d) => [d.amount, d.provisional ?? false])).toEqual([
      [36, false],
      [55, false],
      [37, false],
    ]);
    expect(result.warnings.some((w) => w.includes("nicht verfügbar"))).toBe(false);
    expect(result.sources).toContain("BMF, LStH 2027 Anhang 25 I, online");
  });
});

describe("computeTrip - Ortswarnung", () => {
  const trip = (place: string) =>
    computeTrip({
      travellerType: "employee",
      departure: "2026-03-09T06:00",
      returnTime: "2026-03-09T20:00",
      stops: [{ country: "Frankreich", place, arrival: "2026-03-09T10:00" }],
    });

  it("warns once and uses 'im Übrigen' when the place is not in the BMF table", () => {
    const result = trip("Lyon");
    expect(result.days[0].amount).toBe(36);
    expect(result.days[0].fullRate).toBe(53);
    expect(result.warnings.filter((w) => w.includes('Ort "Lyon" (Frankreich) nicht in der BMF-Tabelle erkannt'))).toHaveLength(1);
  });

  it("does not warn for a place that is in the table", () => {
    const result = trip("Paris");
    expect(result.warnings.some((w) => w.includes("nicht in der BMF-Tabelle erkannt"))).toBe(false);
  });
});

// BMF letter of 25.11.2020 (LStH 2026 Anhang 25 III), Rz. 47 to 52: expected values come from the examples' text.
describe("computeTrip - BMF-Beispiele", () => {
  it("Beispiel 30: night work 19:30 to 06:00 without accommodation gives 14 EUR for the second day", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-03-09T19:30",
      returnTime: "2026-03-10T06:00",
      stops: [{ country: "Deutschland", arrival: "2026-03-09T20:00" }],
      overnightWithoutAccommodation: true,
    });
    expect(result.days.map((d) => d.amount)).toEqual([0, 14]);
  });

  it("Beispiel 31: 17:00 to 07:30 the next day without accommodation gives 14 EUR for the second day", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-05-05T17:00",
      returnTime: "2026-05-06T07:30",
      stops: [{ country: "Deutschland", arrival: "2026-05-05T18:00" }],
      overnightWithoutAccommodation: true,
    });
    expect(result.days.map((d) => [d.date, d.amount])).toEqual([
      ["2026-05-05", 0],
      ["2026-05-06", 14],
    ]);
  });

  it("Beispiel 32: absence 17:00 to 01:30 the next day gives 14 EUR for the first day", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-03-09T17:00",
      returnTime: "2026-03-10T01:30",
      stops: [{ country: "Deutschland", arrival: "2026-03-09T18:00" }],
      overnightWithoutAccommodation: true,
    });
    expect(result.days.map((d) => d.amount)).toEqual([14, 0]);
  });

  it("Beispiel 34: Monday 10:30 to Thursday 01:45 gives 14, 28, 28, 14", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-03-09T10:30",
      returnTime: "2026-03-12T01:45",
      stops: [{ country: "Deutschland", arrival: "2026-03-09T14:00" }],
      useLodgingFlatRate: true,
    });
    expect(result.days.map((d) => d.amount)).toEqual([14, 28, 28, 14]);
    // the return at 01:45 is the journey home: only the nights Mon-Tue and Tue-Wed count
    expect(result.nights).toBe(2);
    expect(result.lodgingFlat.map((l) => [l.date, l.amount])).toEqual([
      ["2026-03-09", 20],
      ["2026-03-10", 20],
    ]);
  });

  it("Beispiel 37: Berlin - Brüssel - Amsterdam - Berlin uses the country reached before 24:00 local time", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-03-09T20:00",
      returnTime: "2026-03-12T22:30",
      stops: [
        { country: "Belgien", place: "Brüssel", arrival: "2026-03-10T02:00" },
        { country: "Niederlande", place: "Amsterdam", arrival: "2026-03-11T14:00" },
      ],
    });
    // 2026 BMF table values
    const belgium = { full: 59, partial: 40 };
    const netherlands = { full: 58, partial: 39 };
    expect(result.days.map((d) => [d.date, d.country, d.amount])).toEqual([
      ["2026-03-09", "Deutschland", 14],
      ["2026-03-10", "Belgien", belgium.full],
      ["2026-03-11", "Niederlande", netherlands.full],
      ["2026-03-12", "Niederlande", netherlands.partial],
    ]);
  });
});

describe("computeTrip - Übernachtungsnächte", () => {
  it("does not count the lodging flat rate for nights in the air on a long flight and warns about the count", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-05-04T10:00",
      returnTime: "2026-05-08T20:00",
      stops: [{ country: "Japan", place: "Tokio", arrival: "2026-05-07T08:00", transport: "flight" }],
      useLodgingFlatRate: true,
    });
    expect(result.lodgingFlat.map((l) => l.date)).toEqual(["2026-05-07"]);
    expect(result.warnings.some((w) => w.includes("Übernachtungspauschale für 1 Nacht angesetzt"))).toBe(true);
  });

  it("also treats the start-date night of a flight with a day in between as a night in the air", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-05-04T22:00",
      returnTime: "2026-05-08T20:00",
      stops: [{ country: "Japan", place: "Tokio", arrival: "2026-05-06T06:00", transport: "flight" }],
      useLodgingFlatRate: true,
    });
    expect(result.lodgingFlat.map((l) => l.date)).toEqual(["2026-05-06", "2026-05-07"]);
  });

  it("also treats the start-date night of a ship leg with days in between as spent on board", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-06-01T10:00",
      returnTime: "2026-06-06T20:00",
      stops: [{ country: "Dänemark", arrival: "2026-06-04T08:00", transport: "ship" }],
      useLodgingFlatRate: true,
    });
    expect(result.lodgingFlat.map((l) => l.date)).toEqual(["2026-06-04", "2026-06-05"]);
  });

  it("says in the warning when the number comes from lodgingNights", () => {
    const result = computeTrip(inland({ useLodgingFlatRate: true, lodgingNights: 1 }));
    expect(result.warnings.some((w) => w.includes("aus lodgingNights übernommen"))).toBe(true);
  });

  it("counts the last night for a return at 06:00 or later, not before, including 00:30", () => {
    const nightsFor = (returnTime: string) =>
      computeTrip(inland({ returnTime, useLodgingFlatRate: true })).lodgingFlat.length;
    expect(nightsFor("2026-03-11T05:59")).toBe(1);
    expect(nightsFor("2026-03-11T06:00")).toBe(2);
    expect(nightsFor("2026-03-11T00:30")).toBe(1);
  });

  it("caps the nights with lodgingNights and rejects a larger number", () => {
    expect(computeTrip(inland({ useLodgingFlatRate: true, lodgingNights: 1 })).lodgingFlat).toHaveLength(1);
    expect(() => computeTrip(inland({ useLodgingFlatRate: true, lodgingNights: 3 }))).toThrow(/lodgingNights/);
  });
});

describe("computeTrip - Etappen nach der ersten Station (departs)", () => {
  const paris = { country: "Frankreich", place: "Paris", arrival: "2026-04-06T12:00", transport: "train" as const };

  it("short flight home after three nights in Paris without departs: no transit days, hotel nights paid, hint", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-04-06T07:00",
      returnTime: "2026-04-09T19:00",
      stops: [paris, { country: "Deutschland", arrival: "2026-04-09T18:00", transport: "flight" }],
      useLodgingFlatRate: true,
    });
    expect(result.days.map((d) => [d.date, d.country, d.amount])).toEqual([
      ["2026-04-06", "Frankreich", 39],
      ["2026-04-07", "Frankreich", 58],
      ["2026-04-08", "Frankreich", 58],
      ["2026-04-09", "Frankreich", 39],
    ]);
    expect(result.lodgingFlat.map((l) => [l.date, l.amount])).toEqual([
      ["2026-04-06", 159],
      ["2026-04-07", 159],
      ["2026-04-08", 159],
    ]);
    expect(result.warnings.some((w) => w.includes("R 9.6 Abs. 3 LStR"))).toBe(false);
    expect(result.warnings.filter((w) => w.startsWith("Flug-/Schiffsetappe nach Station 2 ohne departs_at"))).toHaveLength(1);
  });

  it("does not hint for a flight leg that ends on the day after the previous arrival", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-04-06T07:00",
      returnTime: "2026-04-07T21:00",
      stops: [paris, { country: "Vereinigtes Königreich", place: "London", arrival: "2026-04-07T10:00", transport: "flight" }],
    });
    expect(result.warnings.some((w) => w.includes("ohne departs_at"))).toBe(false);
  });

  it("Paris, then a flight to London with departs: London from the day of arrival, no transit", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-04-06T07:00",
      returnTime: "2026-04-09T21:00",
      stops: [
        paris,
        { country: "Vereinigtes Königreich", place: "London", departs: "2026-04-08T09:00", arrival: "2026-04-08T09:30", transport: "flight" },
      ],
      useLodgingFlatRate: true,
    });
    expect(result.days.map((d) => [d.date, d.amount])).toEqual([
      ["2026-04-06", 39],
      ["2026-04-07", 58],
      ["2026-04-08", 66],
      ["2026-04-09", 44],
    ]);
    expect(result.lodgingFlat.map((l) => l.amount)).toEqual([159, 159, 163]);
    expect(result.warnings.some((w) => w.includes("departs_at") || w.includes("R 9.6 Abs. 3 LStR"))).toBe(false);
  });

  it("long flight with departs over three calendar days: Österreich for the day in between, no night in the air", () => {
    const tokio = lookupRate("Japan", "Tokio", 2026);
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-05-03T08:00",
      returnTime: "2026-05-09T20:00",
      stops: [
        { country: "Frankreich", place: "Paris", arrival: "2026-05-03T13:00", transport: "train" },
        { country: "Japan", place: "Tokio", departs: "2026-05-05T22:00", arrival: "2026-05-07T08:00", transport: "flight" },
      ],
      useLodgingFlatRate: true,
    });
    expect(result.days.map((d) => [d.date, d.country, d.amount])).toEqual([
      ["2026-05-03", "Frankreich", 39],
      ["2026-05-04", "Frankreich", 58],
      ["2026-05-05", "Frankreich", 58],
      ["2026-05-06", "Österreich", 50],
      ["2026-05-07", "Japan", tokio.full],
      ["2026-05-08", "Japan", tokio.full],
      ["2026-05-09", "Japan", tokio.partial],
    ]);
    expect(result.lodgingFlat.map((l) => l.date)).toEqual(["2026-05-03", "2026-05-04", "2026-05-07", "2026-05-08"]);
    expect(result.warnings.some((w) => w.includes("R 9.6 Abs. 3 LStR"))).toBe(true);
  });

  it("rejects departs outside the previous arrival and this arrival, and on the first stop", () => {
    const trip = (departs: string, first = false) =>
      computeTrip({
        travellerType: "employee",
        departure: "2026-04-06T07:00",
        returnTime: "2026-04-09T21:00",
        stops: first
          ? [{ ...paris, departs }]
          : [paris, { country: "Vereinigtes Königreich", place: "London", departs, arrival: "2026-04-08T09:30", transport: "flight" }],
      });
    expect(() => trip("2026-04-06T11:00")).toThrow(/departs_at/);
    expect(() => trip("2026-04-08T10:00")).toThrow(/departs_at/);
    expect(() => trip("2026-04-08T25:00")).toThrow(/Ungültige Zeitangabe/);
    expect(() => trip("2026-04-06T08:00", true)).toThrow(/departs_at/);
  });
});

describe("computeTrip - Rückreise nach Deutschland als Station (§ 9 Abs. 4a Satz 5 EStG)", () => {
  const home = (arrival: string) => ({ country: "Deutschland", arrival });

  it("Wien: the return day uses Österreich (33 EUR), not the domestic 14 EUR", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-04-06T07:00",
      returnTime: "2026-04-08T21:00",
      stops: [{ country: "Österreich", place: "Wien", arrival: "2026-04-06T12:00" }, home("2026-04-08T20:00")],
    });
    expect(result.days.map((d) => d.amount)).toEqual([33, 50, 33]);
    expect(result.days[2].country).toBe("Österreich");
    expect(
      result.warnings.filter((w) => w.startsWith("Rückreise nach Deutschland als Station erfasst: Rückreisetag mit dem letzten Auslandsort (Österreich)"))
    ).toHaveLength(1);
  });

  it("Basel day trip with the home stop: 47 EUR", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-04-06T07:00",
      returnTime: "2026-04-06T19:00",
      stops: [{ country: "Schweiz", place: "Basel", arrival: "2026-04-06T09:00" }, home("2026-04-06T18:30")],
    });
    expect(result.days.map((d) => d.amount)).toEqual([47]);
  });

  it("Paris, London and the home stop: the return day uses London (44 EUR)", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-04-06T07:00",
      returnTime: "2026-04-09T21:00",
      stops: [
        { country: "Frankreich", place: "Paris", arrival: "2026-04-06T12:00", transport: "train" },
        { country: "Vereinigtes Königreich", place: "London", departs: "2026-04-08T09:00", arrival: "2026-04-08T09:30", transport: "flight" },
        { country: "Deutschland", departs: "2026-04-09T17:00", arrival: "2026-04-09T20:00", transport: "flight" },
      ],
    });
    expect(result.days.map((d) => d.amount)).toEqual([39, 58, 66, 44]);
  });

  it("does not apply when the traveller worked in Germany after the foreign stop (Wien, then München)", () => {
    for (const extra of [[], [home("2026-04-10T17:00")]]) {
      const result = computeTrip({
        travellerType: "employee",
        departure: "2026-04-06T07:00",
        returnTime: "2026-04-10T18:00",
        stops: [
          { country: "Österreich", place: "Wien", arrival: "2026-04-06T12:00" },
          { country: "Deutschland", place: "München", arrival: "2026-04-07T18:00" },
          ...extra,
        ],
      });
      expect(result.days.at(-1)?.amount, `extra=${extra.length}`).toBe(14);
      expect(result.warnings.some((w) => w.includes("Rückreise nach Deutschland"))).toBe(false);
    }
  });

  it("applies when the first domestic stop after the foreign stop arrives on the return day itself", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-04-06T07:00",
      returnTime: "2026-04-08T22:00",
      stops: [
        { country: "Österreich", place: "Wien", arrival: "2026-04-06T12:00" },
        { country: "Deutschland", place: "München", arrival: "2026-04-08T18:00" },
        home("2026-04-08T21:00"),
      ],
    });
    expect(result.days.map((d) => d.amount)).toEqual([33, 50, 33]);
    expect(result.warnings.filter((w) => w.startsWith("Rückreise nach Deutschland als Station erfasst"))).toHaveLength(1);
  });

  it("covers a return at 00:00: the domestic stop arriving at 00:00 belongs to the previous (last) day", () => {
    const result = computeTrip({
      travellerType: "employee",
      departure: "2026-04-06T07:00",
      returnTime: "2026-04-09T00:00",
      stops: [{ country: "Österreich", place: "Wien", arrival: "2026-04-06T12:00" }, home("2026-04-09T00:00")],
    });
    expect(result.days.map((d) => d.amount)).toEqual([33, 50, 33]);
  });

  it("a trip with only domestic stops is unchanged", () => {
    const result = computeTrip(inland({ stops: [home("2026-03-09T09:00"), home("2026-03-11T17:00")] }));
    expect(result.days.map((d) => d.amount)).toEqual([14, 28, 14]);
    expect(result.warnings.some((w) => w.includes("Rückreise nach Deutschland"))).toBe(false);
  });
});

describe("computeTrip - weitere Eingabeprüfungen", () => {
  it("allows 366 calendar days and rejects 367", () => {
    const trip = (returnTime: string) =>
      computeTrip(inland({ departure: "2026-01-01T08:00", returnTime, stops: [{ country: "Deutschland", arrival: "2026-01-01T09:00" }] }));
    expect(trip("2027-01-01T08:00").days).toHaveLength(366);
    expect(() => trip("2027-01-02T08:00")).toThrow(/366/);
  });

  it("validates sameLocationSince as a date not after the trip", () => {
    expect(() => computeTrip(inland({ sameLocationSince: "09.01.2026" }))).toThrow(/same_location_since/);
    expect(() => computeTrip(inland({ sameLocationSince: "2026-03-10" }))).toThrow(/same_location_since/);
  });
});
