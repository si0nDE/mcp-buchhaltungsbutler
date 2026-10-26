import { builtinRateTable, provisionalRateTable, type RateTable, type RateTables } from "./travel-rates.js";
import { parseRatesHtml, type ParsedRate } from "./travel-rates-parse.js";

// Online lookup of the BMF table of foreign per-diem rates for years without a built-in table (LStH Anhang 25 I).
// Only these two hosts, https only, URL built from an integer year; redirects are followed by hand (at most 3 hops) and
// only to https on these hosts, checked before the target is requested. The page is parsed as data and validated.
// Any problem (network, HTTP status, redirect, size, content type, validation) means "not available", never an error:
// the caller then continues with a provisional table. Opt-out: BHB_TRAVEL_RATES_ONLINE=0 or false.
export const RATE_HOSTS = ["lsth.bundesfinanzministerium.de", "ksth.bundesfinanzministerium.de"] as const;
const MIN_YEAR = 2025;
const MAX_YEAR = 2100;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 3 * 1024 * 1024;
const FAILURE_TTL_MS = 10 * 60_000;
const MIN_COUNTRIES = 150;
const MAX_REDIRECTS = 3;
const MAX_LOG_TEXT = 60;

export interface FetchRateOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

// Successes are kept for the process, failures for 10 minutes (so repeated tool calls do not each wait for a timeout).
const cache = new Map<number, { table: RateTable | null; at: number }>();
// Concurrent calls for the same year share one lookup.
const inflight = new Map<number, Promise<RateTable | null>>();
export const clearRateTableCache = (): void => {
  cache.clear();
  inflight.clear();
};

// Page-derived text (country names, redirect targets) is shortened before it goes into a message or log line.
const clip = (text: string): string => (text.length > MAX_LOG_TEXT ? `${text.slice(0, MAX_LOG_TEXT - 1)}…` : text);

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // the body is not needed; a failing cancel changes nothing
  }
}

const allowedUrl = (url: URL): boolean => url.protocol === "https:" && (RATE_HOSTS as readonly string[]).includes(url.hostname);

export const rateTableUrl = (host: string, year: number): string => `https://${host}/lsth/${year}/B-Anhaenge/Anhang-25/I/inhalt.html`;

export function onlineLookupEnabled(env: FetchRateOptions["env"] = process.env): boolean {
  const value = env.BHB_TRAVEL_RATES_ONLINE?.trim().toLowerCase();
  return value !== "0" && value !== "false";
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Antwort größer als 3 MB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Matched on the text without tags: the LStH 2025 page splits the sentence with </span><br/><span>.
const HEADING =
  /Übersicht über die ab 1\.\s*Januar\s+(\d{4})\s+geltenden Pauschbeträge für\s+Verpflegungsmehraufwendungen und Übernachtungskosten im Ausland/g;

// Throws with a short reason if the page is not the table of exactly this year.
export function validateRatePage(year: number, html: string): ParsedRate[] {
  const text = html.replace(/<[^<>]*>/g, " ").replace(/&nbsp;|\u00a0/g, " ").replace(/\s+/g, " ");
  const years = [...text.matchAll(HEADING)].map((m) => Number(m[1]));
  if (years.length === 0 || years.some((y) => y !== year)) throw new Error(`Überschrift nicht für ${year}`);
  const entries = parseRatesHtml(html);
  const countries = new Set(entries.map((e) => e.country));
  if (countries.size < MIN_COUNTRIES) throw new Error(`nur ${countries.size} Länder`);
  for (const required of ["Luxemburg", "Österreich"]) if (!countries.has(required)) throw new Error(`${required} fehlt`);
  for (const e of entries) {
    const values = [e.full, e.partial, e.night];
    if (!values.every((v) => Number.isInteger(v) && v >= 1 && v <= 1000)) throw new Error(`unplausibler Wert bei ${clip(e.country)}`);
    if (e.partial > e.full) throw new Error(`Teilsatz über Vollsatz bei ${clip(e.country)}`);
  }
  for (const country of countries) {
    const rows = entries.filter((e) => e.country === country);
    if (rows.some((e) => e.place !== null) && !rows.some((e) => e.place === "im Übrigen")) throw new Error(`"im Übrigen" fehlt bei ${clip(country)}`);
  }
  return entries;
}

async function fetchFrom(host: string, year: number, fetchImpl: typeof fetch, date: string): Promise<RateTable> {
  let url = rateTableUrl(host, year);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  for (let hop = 0; ; hop += 1) {
    res = await fetchImpl(url, { signal, redirect: "manual", headers: { accept: "text/html" } });
    if (res.status < 300 || res.status > 399) break;
    await discard(res);
    const location = res.headers.get("location");
    if (!location) throw new Error(`HTTP ${res.status} ohne Ziel`);
    if (hop >= MAX_REDIRECTS) throw new Error("mehr als 3 Weiterleitungen");
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new Error(`Weiterleitung auf ungültige Adresse ${clip(location)} abgelehnt`);
    }
    // Checked before the target is contacted.
    if (!allowedUrl(next)) throw new Error(`Weiterleitung auf ${clip(`${next.protocol}//${next.host}`)} abgelehnt`);
    url = next.href;
  }
  // Defence in depth for fetch implementations that follow redirects themselves.
  const finalUrl = new URL(res.url || url);
  if (!allowedUrl(finalUrl)) {
    await discard(res);
    throw new Error(`Weiterleitung auf ${clip(`${finalUrl.protocol}//${finalUrl.host}`)} abgelehnt`);
  }
  if (!res.ok) {
    await discard(res);
    throw new Error(`HTTP ${res.status}`);
  }
  if (!/^text\/html\b/i.test(res.headers.get("content-type") ?? "")) {
    await discard(res);
    throw new Error("kein HTML");
  }
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) {
    await discard(res);
    throw new Error("Antwort größer als 3 MB");
  }
  const html = await readLimited(res);
  if (html.length > MAX_BYTES) throw new Error("Antwort größer als 3 MB");
  const entries = validateRatePage(year, html);
  return {
    year,
    source: `BMF, LStH ${year} Anhang 25 I, online abgerufen am ${date}: ${url}`,
    retrievedAt: date,
    entries,
    origin: "online",
  };
}

/** The BMF table of the year from the LStH page, or null if not available. Never throws for network or validation problems. */
export async function fetchRateTable(year: number, options: FetchRateOptions = {}): Promise<RateTable | null> {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) return null;
  if (!onlineLookupEnabled(options.env)) return null;
  const now = (options.now ?? (() => new Date()))().getTime();
  const cached = cache.get(year);
  if (cached && (cached.table !== null || now - cached.at < FAILURE_TTL_MS)) return cached.table;

  const running = inflight.get(year);
  if (running) return running;
  const lookup = lookupOnline(year, options.fetchImpl ?? globalThis.fetch, now).finally(() => inflight.delete(year));
  inflight.set(year, lookup);
  return lookup;
}

async function lookupOnline(year: number, fetchImpl: typeof fetch, now: number): Promise<RateTable | null> {
  const date = new Date(now).toISOString().slice(0, 10);
  const reasons: string[] = [];
  for (const host of RATE_HOSTS) {
    try {
      const table = await fetchFrom(host, year, fetchImpl, date);
      cache.set(year, { table, at: now });
      return table;
    } catch (error) {
      reasons.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.error(`Reisekosten: BMF-Auslandstabelle ${year} online nicht verfügbar (${reasons.join("; ")}).`);
  cache.set(year, { table: null, at: now });
  return null;
}

/** Table per year: built-in, else online, else provisional (latest built-in table, marked). */
export async function resolveRateTables(years: number[], options: FetchRateOptions = {}): Promise<RateTables> {
  const tables: RateTables = {};
  for (const year of [...new Set(years)]) {
    tables[year] = builtinRateTable(year) ?? (await fetchRateTable(year, options)) ?? provisionalRateTable(year);
  }
  return tables;
}
