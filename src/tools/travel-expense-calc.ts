import { DOMESTIC_COUNTRY, lookupRate, type ResolvedRate } from "./travel-rates.js";

export type TravellerType = "employee" | "self_employed";
export type Meal = "breakfast" | "lunch" | "dinner";
export type Transport = "car" | "train" | "flight" | "ship" | "other";

export interface Stop {
  country: string;
  place?: string;
  /** Arrival at this place, local time there, "YYYY-MM-DDTHH:mm". */
  arrival: string;
  /** Mode of transport of the leg that leads to this stop. */
  transport?: Transport;
}

export interface TripInput {
  travellerType: TravellerType;
  /** Leaving home / first workplace, "YYYY-MM-DDTHH:mm". */
  departure: string;
  /** Returning home / first workplace, "YYYY-MM-DDTHH:mm". */
  returnTime: string;
  stops: Stop[];
  /** Meals provided per date "YYYY-MM-DD" (§ 9 Abs. 4a Satz 8 ff. EStG). */
  mealsProvided?: Record<string, Meal[]>;
  /** Work through the night without accommodation (14 EUR for the day with the larger part of the absence). */
  overnightWithoutAccommodation?: boolean;
  /** Start date at the same Tätigkeitsstätte, for the three-month rule (§ 9 Abs. 4a Satz 6 EStG). */
  sameLocationSince?: string;
  /** Lodging flat rates, only for employee reimbursement by the employer. */
  useLodgingFlatRate?: boolean;
}

export interface DayResult {
  date: string;
  hours: number;
  country: string;
  place: string | null;
  kind: "none" | "partial" | "full";
  baseAmount: number;
  reduction: number;
  amount: number;
  meals: Meal[];
  /** 24-hour rate of the day's country: basis for the meal reduction and the breakfast part of a hotel price. */
  fullRate: number;
  note?: string;
}

export interface LodgingFlatLine {
  date: string;
  country: string;
  amount: number;
}

export interface TripResult {
  days: DayResult[];
  nights: number;
  lodgingFlat: LodgingFlatLine[];
  allowanceTotal: number;
  lodgingFlatTotal: number;
  warnings: string[];
  sources: string[];
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MEAL_SHARE: Record<Meal, number> = { breakfast: 0.2, lunch: 0.4, dinner: 0.4 };

export const round2 = (value: number): number => Math.round(value * 100) / 100;

// Clock times are treated as UTC only for arithmetic: no time zone or DST math, the day is what the clock says.
export function parseLocal(value: string): number {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) throw new Error(`Ungültige Zeitangabe "${value}" (erwartet YYYY-MM-DDTHH:mm).`);
  const ms = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]);
  // Date.UTC rolls 2026-02-31 over to March: reject anything that does not round-trip.
  if (new Date(ms).toISOString().slice(0, 16) !== value) throw new Error(`Ungültige Zeitangabe "${value}".`);
  return ms;
}

export const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

function addMonths(ms: number, months: number): number {
  const date = new Date(ms);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(date.getUTCDate(), lastDay));
}

export function computeTrip(input: TripInput): TripResult {
  if (input.travellerType === "self_employed" && input.useLodgingFlatRate) {
    throw new Error(
      "Übernachtungspauschalen gibt es nur bei Erstattung durch den Arbeitgeber (Arbeitnehmer, R 9.7 Abs. 3 LStR). " +
        "Selbstständige und Geschäftsführer rechnen tatsächliche Übernachtungskosten mit Beleg ab (R 4.12 EStR)."
    );
  }
  const departure = parseLocal(input.departure);
  const returnMs = parseLocal(input.returnTime);
  if (returnMs <= departure) throw new Error("Die Rückkehr muss nach der Abreise liegen.");
  if (input.stops.length === 0) {
    throw new Error('Mindestens eine Station angeben (stops), z. B. { country: "Deutschland", arrival: "…" }.');
  }

  const stops = input.stops.map((stop) => ({ ...stop, arrivalMs: parseLocal(stop.arrival) }));
  let previous = departure;
  for (const stop of stops) {
    if (stop.arrivalMs < previous) {
      throw new Error(`Station "${stop.country}": Ankunft ${stop.arrival} liegt vor der vorigen Station bzw. der Abreise.`);
    }
    if (stop.arrivalMs > returnMs) {
      throw new Error(`Station "${stop.country}": Ankunft ${stop.arrival} liegt nach der Rückkehr.`);
    }
    previous = stop.arrivalMs;
  }

  const firstDay = startOfDay(departure);
  const lastDay = startOfDay(returnMs);
  const multiDay = lastDay > firstDay;
  if (input.overnightWithoutAccommodation && (lastDay - firstDay) / DAY_MS !== 1) {
    throw new Error("overnight_without_accommodation gilt nur für Einsätze über genau zwei Kalendertage.");
  }
  const hoursOf = (day: number): number =>
    (Math.min(returnMs, day + DAY_MS) - Math.max(departure, day)) / HOUR_MS;
  const overnightDay = input.overnightWithoutAccommodation
    ? hoursOf(firstDay) >= hoursOf(lastDay)
      ? firstDay
      : lastDay
    : undefined;

  // R 9.6 Abs. 3 LStR: days in between on long flights (more than two calendar days) use Österreich,
  // days in between on ship passages use Luxemburg.
  const transitCountry = new Map<string, string>();
  stops.forEach((stop, index) => {
    if (stop.transport !== "flight" && stop.transport !== "ship") return;
    const legStart = startOfDay(index === 0 ? departure : stops[index - 1].arrivalMs);
    const legEnd = startOfDay(stop.arrivalMs);
    if (stop.transport === "flight" && (legEnd - legStart) / DAY_MS < 2) return;
    for (let day = legStart + DAY_MS; day < legEnd; day += DAY_MS) {
      transitCountry.set(dayKey(day), stop.transport === "flight" ? "Österreich" : "Luxemburg");
    }
  });

  const locate = (day: number, isLast: boolean): { country: string; place?: string } => {
    if (isLast) return stops[stops.length - 1];
    const transit = transitCountry.get(dayKey(day));
    if (transit) return { country: transit };
    const reached = stops.filter((stop) => startOfDay(stop.arrivalMs) <= day).pop();
    return reached ?? { country: DOMESTIC_COUNTRY };
  };

  const warnings = new Set<string>();
  const sources = new Set<string>();
  const noteRate = (rate: ResolvedRate, place?: string) => {
    if (rate.source) sources.add(rate.source);
    if (rate.fallback === "luxembourg") {
      warnings.add(
        `Land "${rate.country}" steht nicht in der BMF-Tabelle: Luxemburg-Satz angesetzt (nicht erfasste Länder, BMF 05.12.2025).`
      );
    }
    if (place?.trim() && rate.placeMatched === "rest") {
      warnings.add(
        `Ort "${place.trim()}" (${rate.country}) nicht in der BMF-Tabelle erkannt: Satz "im Übrigen" angesetzt, Stadtsatz prüfen.`
      );
    }
  };

  const fristEnd = input.sameLocationSince
    ? addMonths(parseLocal(`${input.sameLocationSince}T00:00`), 3) - DAY_MS
    : undefined;
  if (fristEnd === undefined) {
    warnings.add(
      "Dreimonatsfrist nicht geprüft (same_location_since fehlt): Die Verpflegungspauschale entfällt nach drei Monaten an " +
        "derselben Tätigkeitsstätte, eine Unterbrechung von mindestens vier Wochen setzt die Frist zurück (§ 9 Abs. 4a Satz 6 und 7 EStG)."
    );
  }

  const days: DayResult[] = [];
  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    const key = dayKey(day);
    const hours = hoursOf(day);
    const isLast = day === lastDay;
    let kind: DayResult["kind"] = "none";
    if (!multiDay) kind = hours > 8 ? "partial" : "none";
    else if (input.overnightWithoutAccommodation) kind = day === overnightDay ? "partial" : "none";
    else if (hours > 0) kind = day === firstDay || isLast ? "partial" : "full";

    const where = locate(day, isLast);
    const rate = lookupRate(where.country, where.place, Number(key.slice(0, 4)));
    noteRate(rate, where.place);
    if (transitCountry.has(key)) {
      warnings.add("Flug- oder Schiffsreise über mehrere Kalendertage: Zwischentage nach R 9.6 Abs. 3 LStR (Österreich bzw. Luxemburg).");
    }

    const meals = [...new Set(input.mealsProvided?.[key] ?? [])];
    const base = kind === "full" ? rate.full : kind === "partial" ? rate.partial : 0;
    const share = meals.reduce((sum, meal) => sum + MEAL_SHARE[meal], 0);
    let reduction = base > 0 ? Math.min(base, round2(rate.full * share)) : 0;
    let amount = round2(base - reduction);
    let note: string | undefined;
    if (fristEnd !== undefined && day > fristEnd && base > 0) {
      amount = 0;
      reduction = 0;
      note = "Dreimonatsfrist abgelaufen (§ 9 Abs. 4a Satz 6 EStG): keine Verpflegungspauschale.";
    }
    days.push({
      date: key,
      hours: round2(hours),
      country: rate.country,
      place: rate.place,
      kind,
      baseAmount: base,
      reduction,
      amount,
      meals,
      fullRate: rate.full,
      note,
    });
  }

  for (const key of Object.keys(input.mealsProvided ?? {})) {
    if (!days.some((d) => d.date === key)) {
      warnings.add(`Mahlzeiten für ${key} ignoriert: das Datum liegt außerhalb der Reise.`);
    }
  }

  const dayDifference = (lastDay - firstDay) / DAY_MS;
  const nights = input.overnightWithoutAccommodation ? 0 : Math.max(0, dayDifference - (hoursOf(lastDay) === 0 ? 1 : 0));
  const lodgingFlat: LodgingFlatLine[] = [];
  if (input.useLodgingFlatRate) {
    for (let night = 0; night < nights; night += 1) {
      const day = firstDay + night * DAY_MS;
      const where = locate(day, false);
      const rate = lookupRate(where.country, where.place, Number(dayKey(day).slice(0, 4)));
      lodgingFlat.push({ date: dayKey(day), country: rate.country, amount: rate.country === DOMESTIC_COUNTRY ? 20 : rate.night });
    }
  }

  return {
    days,
    nights,
    lodgingFlat,
    allowanceTotal: round2(days.reduce((sum, d) => sum + d.amount, 0)),
    lodgingFlatTotal: round2(lodgingFlat.reduce((sum, l) => sum + l.amount, 0)),
    warnings: [...warnings],
    sources: [...sources],
  };
}
