import {
  builtinRateTable,
  DOMESTIC_COUNTRY,
  isDomesticCountry,
  lookupRate,
  ONLINE_RATES_FROM_YEAR,
  provisionalRateTable,
  type RateTable,
  type RateTables,
  type ResolvedRate,
} from "./travel-rates.js";

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
  /**
   * Start of the leg to this stop, local time at the previous place, "YYYY-MM-DDTHH:mm". Only for stops after the first
   * (the first leg starts at the departure). Without it, a flight/ship leg gets no days in between or nights on board.
   */
  departs?: string;
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
  /** Caps the number of nights derived from the times (non-negative integer). */
  lodgingNights?: number;
  /**
   * Foreign rate tables per year resolved by the caller (online or provisional), consulted before the built-in ones.
   * A year without a table here and without a built-in table is calculated provisionally with the latest built-in table.
   */
  rateTables?: RateTables;
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
  /** true if the rate comes from a provisional table (another year's values). */
  provisional?: boolean;
}

export interface LodgingFlatLine {
  date: string;
  country: string;
  amount: number;
}

/** The foreign rate table used for a year (without its entries). */
export type RateTableInfo = Pick<RateTable, "year" | "origin" | "source" | "retrievedAt" | "provisionalFrom">;

export interface TripResult {
  days: DayResult[];
  /** Informational: nights derived from the times (before the transit exclusion) or lodgingNights; lodgingFlat.length is what is paid. */
  nights: number;
  lodgingFlat: LodgingFlatLine[];
  allowanceTotal: number;
  lodgingFlatTotal: number;
  warnings: string[];
  sources: string[];
  /** Foreign rate tables used, one per year with foreign days (empty for domestic-only trips). */
  rateTables: RateTableInfo[];
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
        "Selbstständige und Gesellschafter-Geschäftsführer ohne Anstellungsvertrag rechnen tatsächliche Übernachtungskosten mit Beleg ab (R 4.12 EStR)."
    );
  }
  const departure = parseLocal(input.departure);
  const returnMs = parseLocal(input.returnTime);
  if (returnMs <= departure) throw new Error("Die Rückkehr muss nach der Abreise liegen.");
  if (input.stops.length === 0) {
    throw new Error('Mindestens eine Station angeben (stops), z. B. { country: "Deutschland", arrival: "…" }.');
  }

  const stops = input.stops.map((stop) => ({
    ...stop,
    arrivalMs: parseLocal(stop.arrival),
    departsMs: stop.departs === undefined ? undefined : parseLocal(stop.departs),
  }));
  let previous = departure;
  stops.forEach((stop, index) => {
    if (stop.arrivalMs < previous) {
      throw new Error(`Station "${stop.country}": Ankunft ${stop.arrival} liegt vor der vorigen Station bzw. der Abreise.`);
    }
    if (stop.arrivalMs > returnMs) {
      throw new Error(`Station "${stop.country}": Ankunft ${stop.arrival} liegt nach der Rückkehr.`);
    }
    if (stop.departsMs !== undefined) {
      if (index === 0) {
        throw new Error(`Station "${stop.country}": departs_at gilt erst ab der zweiten Station; die erste Etappe beginnt mit der Abreise (departure).`);
      }
      if (stop.departsMs < previous || stop.departsMs > stop.arrivalMs) {
        throw new Error(
          `Station "${stop.country}": departs_at ${stop.departs} muss zwischen der Ankunft an der vorigen Station und der Ankunft ${stop.arrival} liegen.`
        );
      }
    }
    previous = stop.arrivalMs;
  });

  const firstDay = startOfDay(departure);
  // A return at exactly 00:00 ends the absence at 24:00 of the previous day: that day is the last one.
  const effectiveReturn = returnMs % DAY_MS === 0 ? returnMs - 60_000 : returnMs;
  const lastDay = startOfDay(effectiveReturn);
  const multiDay = lastDay > firstDay;
  if ((lastDay - firstDay) / DAY_MS > 365) throw new Error("Die Reise darf höchstens 366 Kalendertage umfassen.");
  if (input.lodgingNights !== undefined && (!Number.isInteger(input.lodgingNights) || input.lodgingNights < 0)) {
    throw new Error("lodgingNights muss eine nicht-negative ganze Zahl sein.");
  }
  if (input.overnightWithoutAccommodation && (lastDay - firstDay) / DAY_MS > 1) {
    throw new Error("overnight_without_accommodation gilt nur für Einsätze über genau zwei Kalendertage.");
  }
  const hoursOf = (day: number): number =>
    (Math.min(returnMs, day + DAY_MS) - Math.max(departure, day)) / HOUR_MS;
  // Both days together must exceed 8 hours (§ 9 Abs. 4a Satz 3 Nr. 3 EStG), the day with the larger part gets the 14 EUR.
  const overnightDay =
    input.overnightWithoutAccommodation && multiDay && hoursOf(firstDay) + hoursOf(lastDay) > 8
      ? hoursOf(firstDay) >= hoursOf(lastDay)
        ? firstDay
        : lastDay
      : undefined;

  const warnings = new Set<string>();
  // R 9.6 Abs. 3 LStR: days in between on long flights (more than two calendar days) use Österreich,
  // days in between on ship passages use Luxemburg.
  const transitCountry = new Map<string, string>();
  // The night of a leg's start date is spent in the air or on board when the leg has days in between.
  const transitNights = new Set<string>();
  stops.forEach((stop, index) => {
    if (stop.transport !== "flight" && stop.transport !== "ship") return;
    // A stop has no departure time of its own: after the first stop the leg start is only known from departs.
    // Without it the leg is treated as a leg within the arrival day (the previous arrival may be days earlier).
    if (index > 0 && stop.departsMs === undefined) {
      if (startOfDay(stop.arrivalMs) - startOfDay(stops[index - 1].arrivalMs) >= 2 * DAY_MS) {
        warnings.add(
          `Flug-/Schiffsetappe nach Station ${index + 1} ohne departs_at: Zwischentage und Transitnächte nicht berechnet; ` +
            "bei einer Reise über mehrere Kalendertage departs_at angeben."
        );
      }
      return;
    }
    const legStart = startOfDay(index === 0 ? departure : (stop.departsMs as number));
    const legEnd = startOfDay(stop.arrivalMs);
    if (stop.transport === "flight" && (legEnd - legStart) / DAY_MS < 2) return;
    if (legEnd - legStart > DAY_MS) transitNights.add(dayKey(legStart));
    for (let day = legStart + DAY_MS; day < legEnd; day += DAY_MS) {
      transitCountry.set(dayKey(day), stop.transport === "flight" ? "Österreich" : "Luxemburg");
    }
  });

  // § 9 Abs. 4a Satz 5 EStG: if the place reached last is in Germany, the last place of work abroad counts. Applied to
  // the return day only, when the return to Germany was entered as the last stop and the first domestic stop after
  // the last foreign one arrives on the return day (an earlier domestic stop means work in Germany before returning).
  const lastStop = stops[stops.length - 1];
  let lastForeignIndex = -1;
  if (isDomesticCountry(lastStop.country)) {
    for (let i = stops.length - 1; i >= 0 && lastForeignIndex < 0; i -= 1) if (!isDomesticCountry(stops[i].country)) lastForeignIndex = i;
  }
  const lastForeign =
    lastForeignIndex >= 0 && startOfDay(Math.min(stops[lastForeignIndex + 1].arrivalMs, effectiveReturn)) === lastDay
      ? stops[lastForeignIndex]
      : undefined;
  if (lastForeign) {
    warnings.add(
      `Rückreise nach Deutschland als Station erfasst: Rückreisetag mit dem letzten Auslandsort (${lastForeign.country.trim()}) angesetzt (§ 9 Abs. 4a Satz 5 EStG).`
    );
  }
  const locate = (day: number, isLast: boolean): { country: string; place?: string } => {
    if (isLast) return lastForeign ?? lastStop;
    const transit = transitCountry.get(dayKey(day));
    if (transit) return { country: transit };
    const reached = stops.filter((stop) => startOfDay(stop.arrivalMs) <= day).pop();
    return reached ?? { country: DOMESTIC_COUNTRY };
  };

  // Foreign lookups only: a missing year falls back to a provisional table (marked and warned), never silently.
  const tables: RateTables = { ...input.rateTables };
  const usedYears = new Set<number>();
  const rateOf = (country: string, place: string | undefined, year: number): ResolvedRate => {
    if (!isDomesticCountry(country) && !tables[year]) tables[year] = builtinRateTable(year) ?? provisionalRateTable(year);
    return lookupRate(country, place, year, tables);
  };
  const sources = new Set<string>();
  const noteRate = (rate: ResolvedRate, year: number, place?: string) => {
    if (rate.source) {
      sources.add(rate.source);
      usedYears.add(year);
    }
    if (rate.provisional) {
      warnings.add(
        year < ONLINE_RATES_FROM_YEAR
          ? `BMF-Auslandstabelle ${year} nicht eingebaut und nicht online abrufbar (Abruf nur ab ${ONLINE_RATES_FROM_YEAR}): Sätze der Tabelle ` +
              `${rate.provisionalFrom} sind NICHT die Sätze des Reisejahrs, Abrechnung nicht übernehmen.`
          : `BMF-Auslandstabelle ${year} nicht verfügbar (noch nicht veröffentlicht oder Abruf nicht möglich): Auslandssätze vorläufig mit der ` +
              `Tabelle ${rate.provisionalFrom} berechnet. Nach Veröffentlichung neu berechnen, bevor die Buchung bestätigt wird.`
      );
    }
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

  let sinceMs: number | undefined;
  if (input.sameLocationSince) {
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sameLocationSince)) throw new Error("format");
      sinceMs = parseLocal(`${input.sameLocationSince}T00:00`);
    } catch {
      throw new Error(`Ungültiges Datum für same_location_since "${input.sameLocationSince}" (erwartet YYYY-MM-DD).`);
    }
    if (sinceMs > firstDay) throw new Error("same_location_since darf nicht nach dem ersten Reisetag liegen.");
  }
  const fristEnd = sinceMs === undefined ? undefined : addMonths(sinceMs, 3) - DAY_MS;
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
    const year = Number(key.slice(0, 4));
    const rate = rateOf(where.country, where.place, year);
    noteRate(rate, year, where.place);
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
      ...(rate.provisional ? { provisional: true } : {}),
    });
  }

  for (const key of Object.keys(input.mealsProvided ?? {})) {
    if (!days.some((d) => d.date === key)) {
      warnings.add(`Mahlzeiten für ${key} ignoriert: das Datum liegt außerhalb der Reise.`);
    }
  }

  // Nights from the date difference; a return before 06:00 is the journey home, not a night in accommodation.
  const returnedEarly = effectiveReturn - lastDay < 6 * HOUR_MS;
  const derivedNights = input.overnightWithoutAccommodation
    ? 0
    : Math.max(0, (lastDay - firstDay) / DAY_MS - (returnedEarly && multiDay ? 1 : 0));
  // Nights in the air or on a ship (days in between, R 9.6 Abs. 3 LStR) are no accommodation nights.
  const lodgingDates: number[] = [];
  for (let night = 0; night < derivedNights; night += 1) {
    const day = firstDay + night * DAY_MS;
    if (!transitCountry.has(dayKey(day)) && !transitNights.has(dayKey(day))) lodgingDates.push(day);
  }
  if (input.lodgingNights !== undefined && input.lodgingNights > lodgingDates.length) {
    throw new Error(
      `lodgingNights (${input.lodgingNights}) ist größer als die aus den Zeiten abgeleitete Zahl der Übernachtungen (${lodgingDates.length}).`
    );
  }
  const nights = input.lodgingNights ?? derivedNights;
  const lodgingFlat: LodgingFlatLine[] = [];
  if (input.useLodgingFlatRate) {
    for (const day of lodgingDates.slice(0, input.lodgingNights ?? lodgingDates.length)) {
      const where = locate(day, false);
      const year = Number(dayKey(day).slice(0, 4));
      const rate = rateOf(where.country, where.place, year);
      noteRate(rate, year);
      lodgingFlat.push({ date: dayKey(day), country: rate.country, amount: rate.country === DOMESTIC_COUNTRY ? 20 : rate.night });
    }
    warnings.add(
      `Übernachtungspauschale für ${lodgingFlat.length} ${lodgingFlat.length === 1 ? "Nacht" : "Nächte"} angesetzt (${
        input.lodgingNights === undefined
          ? "aus den Zeiten abgeleitet: Nacht der Heimreise vor 06:00 und Nächte im Flugzeug oder Schiff zählen nicht; Anzahl mit lodgingNights korrigieren"
          : "Anzahl aus lodgingNights übernommen"
      }).`
    );
  }

  return {
    days,
    nights,
    lodgingFlat,
    allowanceTotal: round2(days.reduce((sum, d) => sum + d.amount, 0)),
    lodgingFlatTotal: round2(lodgingFlat.reduce((sum, l) => sum + l.amount, 0)),
    warnings: [...warnings],
    sources: [...sources],
    rateTables: [...usedYears]
      .sort((a, b) => a - b)
      .map((year) => {
        const t = tables[year] as RateTable;
        return { year, origin: t.origin, source: t.source, retrievedAt: t.retrievedAt, provisionalFrom: t.provisionalFrom };
      }),
  };
}
