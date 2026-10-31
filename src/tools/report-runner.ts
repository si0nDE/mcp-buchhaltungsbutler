import type { BBClient } from "../bb-client/client.js";
import { BuchhaltungsButlerApiError } from "../bb-client/errors.js";

// Legt einen BWA- oder SuSa-Report an und wartet, bis BHB ihn fertig hat. BHB erzeugt nur einen Report je Typ gleichzeitig
// (auch die, die das Controlling-Dashboard der Oberfläche selbst anstößt): läuft ein fremder, lehnt es mit HTTP 400 ab
// ("already in progress"); ein noch nicht fertiger antwortet beim Abholen mit 400 ("has not been finished yet"). Beides
// wird hier abgewartet. Aufrufer holen Reports nacheinander, nie parallel.

export interface Range {
  from: string;
  to: string;
}

export interface RunnerOptions {
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxWaitMs?: number;
}

const NOT_READY = /not been finished/i;
const BUSY = /already in progress/i;

const KINDS = {
  bwa: { create: "reportsCreateBwa", get: "reportsGetBwa", label: "BWA" },
  sums: { create: "reportsCreateSums", get: "reportsGetSums", label: "Summen- und Saldenliste" },
} as const;

export function createReportRunner(client: BBClient, opts: RunnerOptions = {}) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 3000;
  const maxWaitMs = opts.maxWaitMs ?? 120_000;

  // base gilt nur für die SuSa: "date_delivery_else_date" rechnet nach Leistungsdatum (so rechnet BHB Bilanz und Kapital).
  return async function run<T>(kind: keyof typeof KINDS, range: Range, base?: "date" | "date_delivery_else_date"): Promise<T> {
    const k = KINDS[kind];
    let created: { id_by_customer?: string | number } | undefined;
    for (let waited = 0; !created; waited += pollMs) {
      try {
        created = await client.call<{ id_by_customer?: string | number }>(k.create, {
          date_from: range.from,
          date_to: range.to,
          ...(base && kind === "sums" ? { base } : {}),
        });
      } catch (e) {
        const busy = e instanceof BuchhaltungsButlerApiError && e.statusCode === 400 && BUSY.test(e.message);
        if (!busy) throw e;
        if (waited >= maxWaitMs) {
          throw new Error(`BHB rechnet seit ${maxWaitMs / 1000} s eine andere ${k.label} (vermutlich die Auswertung in der Oberfläche); später erneut versuchen.`);
        }
        await sleep(pollMs);
      }
    }
    const id = Number(created.id_by_customer);
    if (!Number.isInteger(id)) throw new Error(`BHB hat für ${range.from} bis ${range.to} keine Report-ID geliefert.`);
    for (let waited = 0; ; waited += pollMs) {
      try {
        const res = await client.call<{ report?: T }>(k.get, { report_id_by_customer: id });
        if (!res.report) throw new Error(`${k.label} ${id} (${range.from} bis ${range.to}) kam ohne Inhalt zurück.`);
        return res.report;
      } catch (e) {
        const pending = e instanceof BuchhaltungsButlerApiError && e.statusCode === 400 && NOT_READY.test(e.message);
        if (!pending) throw e;
        if (waited >= maxWaitMs) throw new Error(`${k.label} ${id} (${range.from} bis ${range.to}) war nach ${maxWaitMs / 1000} s nicht fertig.`);
        await sleep(pollMs);
      }
    }
  };
}
