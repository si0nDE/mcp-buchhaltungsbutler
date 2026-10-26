import { describe, expect, it } from "vitest";
import { computeTrip, type TripInput } from "./travel-expense-calc.js";
import { lookupRate } from "./travel-rates.js";

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

  it("gives no allowance for the last day when the return is exactly 00:00 and no night for it", () => {
    const result = computeTrip(
      inland({ departure: "2026-03-09T08:00", returnTime: "2026-03-10T00:00", useLodgingFlatRate: true })
    );
    expect(result.days.map((d) => d.amount)).toEqual([14, 0]);
    expect(result.nights).toBe(0);
    expect(result.lodgingFlatTotal).toBe(0);
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

  it("year change: foreign trip without a 2027 table throws, domestic trip works", () => {
    const base = { travellerType: "employee" as const, departure: "2026-12-31T08:00", returnTime: "2027-01-02T18:00" };
    expect(() => computeTrip({ ...base, stops: [{ country: "Frankreich", arrival: "2026-12-31T12:00" }] })).toThrow(/2027/);
    expect(amounts({ ...base, stops: [{ country: "Deutschland", arrival: "2026-12-31T12:00" }] })).toEqual([14, 28, 14]);
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
    });
    expect(result.days.map((d) => d.amount)).toEqual([14, 28, 28, 14]);
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
    const belgium = lookupRate("Belgien", "Brüssel", 2026);
    const netherlands = lookupRate("Niederlande", "Amsterdam", 2026);
    expect(result.days.map((d) => [d.date, d.country, d.amount])).toEqual([
      ["2026-03-09", "Deutschland", 14],
      ["2026-03-10", "Belgien", belgium.full],
      ["2026-03-11", "Niederlande", netherlands.full],
      ["2026-03-12", "Niederlande", netherlands.partial],
    ]);
  });
});
