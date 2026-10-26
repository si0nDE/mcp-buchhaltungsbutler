// Test fixtures for the online lookup of the BMF table (used by travel-rates-online.test.ts and travel-expense-report.test.ts).
import { RATES_2026 } from "./travel-rates-2026.js";
import type { RateEntry } from "./travel-rates.js";

// Fixture built from the built-in 2026 table with another heading year, in the structure of the LStH page.
export function fixtureHtml(year: number, entries: RateEntry[] = RATES_2026.entries): string {
  const rows: string[] = [];
  let open: string | null = null;
  for (const e of entries) {
    if (e.place === null) {
      rows.push(`<tr><td>${e.country}</td><td class="center">${e.full}</td><td class="center">${e.partial}</td><td class="center">${e.night}</td></tr>`);
      continue;
    }
    if (open !== e.country) {
      rows.push(`<tr><td>${e.country}</td><td class="center">&nbsp;</td><td class="center">&nbsp;</td><td class="center">&nbsp;</td></tr>`);
      open = e.country;
    }
    rows.push(`<tr><td>${e.place}<br/></td><td class="center">${e.full}</td><td class="center">${e.partial}</td><td class="center">${e.night}</td></tr>`);
    if (e.place === "im Übrigen") open = null;
  }
  return (
    `<html><body><h1>LStH ${year}</h1><p>Übersicht über die ab 1. Januar ${year} geltenden Pauschbeträge für ` +
    `Verpflegungsmehraufwendungen und Übernachtungskosten im Ausland</p><table>` +
    `<tr class="table-header-row"><td>Land</td><td>€</td><td>€</td><td>€</td></tr>${rows.join("")}</table></body></html>`
  );
}

export function respond(body: string, init: { status?: number; contentType?: string; url?: string; headers?: Record<string, string> } = {}): Response {
  const res = new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "text/html;charset=utf-8", ...init.headers },
  });
  if (init.url) Object.defineProperty(res, "url", { value: init.url });
  return res;
}
