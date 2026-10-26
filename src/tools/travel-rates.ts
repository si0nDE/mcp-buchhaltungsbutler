import { RATES_2026 } from "./travel-rates-2026.js";

export interface RateEntry {
  country: string;
  place: string | null;
  full: number; // 24 hours absence per calendar day
  partial: number; // arrival/departure day and more than 8 hours
  night: number; // lodging flat rate (only for employer reimbursement)
}

export interface RateTable {
  year: number;
  source: string;
  retrievedAt: string;
  entries: RateEntry[];
}

export interface ResolvedRate extends RateEntry {
  fallback: "none" | "luxembourg";
  source: string | null;
}

export const DOMESTIC_COUNTRY = "Deutschland";
// § 9 Abs. 4a Satz 3 EStG (28/14 €) and R 9.7 Abs. 3 LStR (20 € lodging flat rate, employer reimbursement only).
const DOMESTIC: RateEntry = { country: DOMESTIC_COUNTRY, place: null, full: 28, partial: 14, night: 20 };
const REST = "im Übrigen";

// One table per year. A year is only available after its BMF letter was published (usually in December of
// the previous year) and generated with scripts/generate-travel-rates.ts - never reuse another year's rates.
const TABLES: Record<number, RateTable> = { 2026: RATES_2026 };

const norm = (value: string): string => value.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
const DOMESTIC_NAMES = new Set(["deutschland", "de", "inland"]);

const UK = "Vereinigtes Königreich von Großbritannien und Nordirland";
const TRINIDAD = "Trinidad und Tobago";
// Keys are normalized (lowercase). Notes of the BMF letter: Mikronesien uses the Philippinen rates, several
// Caribbean states use the Trinidad-und-Tobago rates.
export const COUNTRY_ALIASES: Record<string, string> = {
  usa: "Vereinigte Staaten von Amerika (USA)",
  "vereinigte staaten": "Vereinigte Staaten von Amerika (USA)",
  uk: UK,
  großbritannien: UK,
  england: UK,
  "vereinigtes königreich": UK,
  oesterreich: "Österreich",
  tschechien: "Tschechische Republik",
  slowakei: "Slowakische Republik",
  russland: "Russische Föderation",
  belarus: "Weißrussland",
  südkorea: "Korea, Republik",
  vae: "Vereinigte Arabische Emirate",
  elfenbeinküste: "Côte d’Ivoire",
  mikronesien: "Philippinen",
  antigua: TRINIDAD,
  "antigua und barbuda": TRINIDAD,
  dominica: TRINIDAD,
  grenada: TRINIDAD,
  guyana: TRINIDAD,
  "st. kitts und nevis": TRINIDAD,
  "st. lucia": TRINIDAD,
  "st. vincent und grenadinen": TRINIDAD,
  suriname: TRINIDAD,
};

export function getRateTable(year: number): RateTable {
  const table = TABLES[year];
  if (!table) {
    throw new Error(
      `Für das Reisejahr ${year} ist keine BMF-Auslandstabelle hinterlegt (vorhanden: ${Object.keys(TABLES).join(", ")}). ` +
        `Das BMF veröffentlicht die Tabelle für das Folgejahr üblicherweise im Dezember. Nicht mit Vorjahreswerten ` +
        `rechnen: Tabelle mit scripts/generate-travel-rates.ts erzeugen und in travel-rates.ts eintragen.`
    );
  }
  return table;
}

export function lookupRate(country: string, place: string | undefined, year: number): ResolvedRate {
  const wanted = norm(country);
  if (DOMESTIC_NAMES.has(wanted)) return { ...DOMESTIC, fallback: "none", source: null };

  const table = getRateTable(year);
  const canonical = norm(COUNTRY_ALIASES[wanted] ?? country);
  const entries = table.entries.filter((entry) => norm(entry.country) === canonical);

  if (entries.length === 0) {
    const luxembourg = table.entries.find((entry) => entry.country === "Luxemburg");
    if (!luxembourg) throw new Error("Die BMF-Tabelle enthält keinen Luxemburg-Satz für den Fallback.");
    return { ...luxembourg, country: country.trim(), fallback: "luxembourg", source: table.source };
  }
  if (entries.length === 1) return { ...entries[0], fallback: "none", source: table.source };

  const wantedPlace = place ? norm(place) : undefined;
  const city = wantedPlace
    ? entries.find(
        (entry) =>
          entry.place !== null &&
          norm(entry.place) !== norm(REST) &&
          (norm(entry.place).includes(wantedPlace) || wantedPlace.includes(norm(entry.place)))
      )
    : undefined;
  const rest = entries.find((entry) => entry.place !== null && norm(entry.place) === norm(REST));
  const hit = city ?? rest;
  if (!hit) throw new Error(`Für ${country} fehlt in der BMF-Tabelle die Zeile "im Übrigen".`);
  return { ...hit, fallback: "none", source: table.source };
}
