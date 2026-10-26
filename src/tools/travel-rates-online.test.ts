import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RATES_2026 } from "./travel-rates-2026.js";
import { fixtureHtml, respond } from "./travel-rates-online.fixture.js";
import { clearRateTableCache, fetchRateTable, rateTableUrl, resolveRateTables } from "./travel-rates-online.js";

const NOW = new Date("2026-10-26T10:00:00Z");
const lsth = rateTableUrl("lsth.bundesfinanzministerium.de", 2027);
const ksth = rateTableUrl("ksth.bundesfinanzministerium.de", 2027);
const mockFetch = (handler: (url: string) => Response | Promise<Response>) =>
  vi.fn(async (input: string | URL | Request, _init?: RequestInit) => handler(String(input)));
const run = (fetchImpl: ReturnType<typeof mockFetch>, extra: { now?: () => Date; env?: Record<string, string | undefined> } = {}) =>
  fetchRateTable(2027, { fetchImpl: fetchImpl as unknown as typeof fetch, now: extra.now ?? (() => NOW), env: extra.env ?? {} });

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  clearRateTableCache();
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());

describe("fetchRateTable", () => {
  it("builds the URL from the year on the LStH host", () => {
    expect(lsth).toBe("https://lsth.bundesfinanzministerium.de/lsth/2027/B-Anhaenge/Anhang-25/I/inhalt.html");
  });

  it("returns a validated online table with source URL and retrieval date", async () => {
    const fetchImpl = mockFetch((url) => respond(fixtureHtml(2027), { url }));
    const table = await run(fetchImpl);
    expect(table).not.toBeNull();
    expect(table!.year).toBe(2027);
    expect(table!.origin).toBe("online");
    expect(table!.entries).toHaveLength(RATES_2026.entries.length);
    expect(table!.retrievedAt).toBe("2026-10-26");
    expect(table!.source).toBe(`BMF, LStH 2027 Anhang 25 I, online abgerufen am 2026-10-26: ${lsth}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("falls back to the ksth host after an lsth failure", async () => {
    const fetchImpl = mockFetch((url) => (url.includes("lsth.") ? respond("nicht gefunden", { status: 404, url }) : respond(fixtureHtml(2027), { url })));
    const table = await run(fetchImpl);
    expect(table?.source).toContain(ksth);
    expect(fetchImpl.mock.calls.map(([u]) => String(u))).toEqual([lsth, ksth]);
  });

  it.each<[string, (url: string) => Response | Promise<Response>]>([
    ["HTTP 404", (url) => respond("nicht gefunden", { status: 404, url })],
    ["heading with another year", (url) => respond(fixtureHtml(2026), { url })],
    ["heading missing", (url) => respond(fixtureHtml(2027).replace(/Übersicht über die ab 1\. Januar 2027/, "Übersicht"), { url })],
    ["too few countries", (url) => respond(fixtureHtml(2027, RATES_2026.entries.slice(0, 100)), { url })],
    ["Luxemburg missing", (url) => respond(fixtureHtml(2027, RATES_2026.entries.filter((e) => e.country !== "Luxemburg")), { url })],
    ["Österreich missing", (url) => respond(fixtureHtml(2027, RATES_2026.entries.filter((e) => e.country !== "Österreich")), { url })],
    ["partial above full", (url) => respond(fixtureHtml(2027, RATES_2026.entries.map((e, i) => (i === 0 ? { ...e, partial: e.full + 1 } : e))), { url })],
    ["value out of range", (url) => respond(fixtureHtml(2027, RATES_2026.entries.map((e, i) => (i === 0 ? { ...e, night: 1001 } : e))), { url })],
    [
      "city block without 'im Übrigen'",
      (url) => respond(fixtureHtml(2027, RATES_2026.entries.filter((e) => !(e.country === "Frankreich" && e.place === "im Übrigen"))), { url }),
    ],
    ["no table at all", (url) => respond("<html><body>Wartung</body></html>", { url })],
    ["redirect to a foreign host", () => respond(fixtureHtml(2027), { url: "https://example.org/lsth/2027/inhalt.html" })],
    ["redirect to http", () => respond(fixtureHtml(2027), { url: lsth.replace("https:", "http:") })],
    ["wrong content-type", (url) => respond(fixtureHtml(2027), { url, contentType: "application/json" })],
    ["content-length above 3 MB", (url) => respond(fixtureHtml(2027), { url, headers: { "content-length": String(4 * 1024 * 1024) } })],
    ["body above 3 MB", (url) => respond(fixtureHtml(2027) + " ".repeat(3 * 1024 * 1024), { url })],
    [
      "timeout",
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    ],
    [
      "abort",
      () => {
        throw new DOMException("This operation was aborted", "AbortError");
      },
    ],
  ])("treats %s as not available (null, both hosts tried, one log line)", async (_name, handler) => {
    const fetchImpl = mockFetch(handler);
    expect(await run(fetchImpl)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("does not touch the network when BHB_TRAVEL_RATES_ONLINE is 0 or false", async () => {
    for (const value of ["0", "false", " FALSE "]) {
      const fetchImpl = mockFetch((url) => respond(fixtureHtml(2027), { url }));
      expect(await run(fetchImpl, { env: { BHB_TRAVEL_RATES_ONLINE: value } })).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("rejects years outside 2025..2100 and non-integers without a request", async () => {
    const fetchImpl = mockFetch((url) => respond(fixtureHtml(2027), { url }));
    for (const year of [2024, 2101, 2027.5, Number.NaN]) {
      expect(await fetchRateTable(year, { fetchImpl: fetchImpl as unknown as typeof fetch, env: {} })).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caches a success for the process", async () => {
    const fetchImpl = mockFetch((url) => respond(fixtureHtml(2027), { url }));
    const first = await run(fetchImpl);
    const second = await run(fetchImpl, { now: () => new Date("2027-06-01T00:00:00Z") });
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("remembers a failure for 10 minutes", async () => {
    const fetchImpl = mockFetch((url) => respond("nicht gefunden", { status: 404, url }));
    const at = (minutes: number) => () => new Date(NOW.getTime() + minutes * 60_000);
    expect(await run(fetchImpl, { now: at(0) })).toBeNull();
    expect(await run(fetchImpl, { now: at(9) })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await run(fetchImpl, { now: at(11) })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe("resolveRateTables", () => {
  it("uses the built-in table without a request, online if available, else provisional", async () => {
    const online = mockFetch((url) => respond(fixtureHtml(2027), { url }));
    const resolved = await resolveRateTables([2026, 2027], { fetchImpl: online as unknown as typeof fetch, now: () => NOW, env: {} });
    expect(resolved[2026]?.origin).toBe("builtin");
    expect(resolved[2027]?.origin).toBe("online");
    expect(online).toHaveBeenCalledTimes(1);

    clearRateTableCache();
    const missing = mockFetch((url) => respond("nicht gefunden", { status: 404, url }));
    const provisional = await resolveRateTables([2027], { fetchImpl: missing as unknown as typeof fetch, now: () => NOW, env: {} });
    expect(provisional[2027]).toMatchObject({ year: 2027, origin: "provisional", provisionalFrom: 2026 });
  });
});
