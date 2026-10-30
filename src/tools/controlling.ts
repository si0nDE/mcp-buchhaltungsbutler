import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { BuchhaltungsButlerApiError } from "../bb-client/errors.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

// Nachbau des Dashboards "Controlling (Beta)" > "Profitabilität" der BHB-Oberfläche. BHB liefert dafür keine API; alle
// Zahlen des Dashboards lassen sich aber aus der BWA ableiten (Stand 30.10.2026 gegen ein Livekonto, SKR03, ohne Waren-
// einkauf und ohne sonstigen neutralen Aufwand nachgerechnet). Der Konnektor holt die BWA für Zeitraum, Vergleichszeit-
// raum und die sechs Monate der Zeitreihe, nacheinander, weil immer nur eine BWA gleichzeitig entstehen kann und jede
// neue die vorige ersetzt. Das Rendern übernimmt das Modell (Artefakt); hier entstehen nur geprüfte Zahlen.

interface BwaClass {
  amountsSum?: number;
  empty?: boolean;
  // Leere Klassen kommen als [] statt als Objekt.
  postingaccounts?: Record<string, { amountsSum?: number; name?: string }> | unknown[];
}
interface BwaGroup {
  amountsSum?: number;
  classes?: Record<string, BwaClass>;
}
interface Bwa {
  groups?: Record<string, BwaGroup>;
  totals?: Record<string, { amountsSum?: number }>;
  integrityError?: boolean;
  uncompletedPostingsCount?: number;
}

const GROUP = {
  output: "Gesamtleistung",
  goods: "Waren/Material/Leistungen",
  costs: "Gesamtkosten",
  neutralCost: "Neutraler Aufwand",
  neutralIncome: "Neutraler Ertrag",
} as const;

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (num: number, den: number): number | null => (den === 0 ? null : r2((num / den) * 100));
// Änderung in Prozent gegenüber dem Vergleichswert; ohne Vergleichswert gibt es keine sinnvolle Zahl.
const change = (cur: number, prev: number): number | null => (prev === 0 ? null : r2(((cur - prev) / Math.abs(prev)) * 100));
const diff = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : r2(a - b));

const groupSum = (bwa: Bwa, g: string) => bwa.groups?.[g]?.amountsSum ?? 0;
const classSum = (bwa: Bwa, g: string, c: string) => bwa.groups?.[g]?.classes?.[c]?.amountsSum ?? 0;

export interface AccountLine {
  nummer: number;
  name: string;
  amount: number;
}

export interface CostLine {
  name: string;
  amount: number;
  konten: AccountLine[];
}

export interface Kpis {
  gesamtleistung: number;
  umsatzerloese: number;
  ertraege: number;
  kosten: number;
  ebit: number;
  ebitda: number;
  gesamtergebnis: number;
  abschreibungen: number;
  zinsaufwand: number;
  personalkosten: number;
  cogs: number;
  ebit_marge_pct: number | null;
  ebitda_marge_pct: number | null;
  umsatzrentabilitaet_pct: number | null;
  cogs_marge_pct: number | null;
  personalaufwandsquote_pct: number | null;
  kostenarten: CostLine[];
}

// Alle Beträge positiv: BHB führt Kosten in der BWA negativ.
export function kpisFromBwa(bwa: Bwa): Kpis {
  const gesamtleistung = groupSum(bwa, GROUP.output);
  const umsatz = classSum(bwa, GROUP.output, "Umsatzerlöse");
  const abschreibungen = -classSum(bwa, GROUP.costs, "Abschreibungen");
  const zinsaufwand = -classSum(bwa, GROUP.neutralCost, "Zinsaufwand");
  const personal = -classSum(bwa, GROUP.costs, "Personalkosten");
  const warenabgabe = -classSum(bwa, GROUP.costs, "Kosten Warenabgabe");
  const waren = -groupSum(bwa, GROUP.goods);
  const ebit = bwa.totals?.["Betriebsergebnis"]?.amountsSum ?? 0;
  const ergebnis = bwa.totals?.["Ergebnis"]?.amountsSum ?? 0;
  const ebitda = ebit + abschreibungen;
  // Dashboard-Definition (nachgerechnet): Erträge = Gesamtleistung + neutraler Ertrag; Kosten = Gesamtkosten + Wareneinsatz
  // + neutraler Aufwand; Ergebnis = Erträge - Kosten.
  const ertraege = gesamtleistung + groupSum(bwa, GROUP.neutralIncome);
  const kosten = -groupSum(bwa, GROUP.costs) + waren - groupSum(bwa, GROUP.neutralCost);
  const cogs = warenabgabe + waren;

  const kostenarten: CostLine[] = [];
  for (const g of [GROUP.goods, GROUP.costs, GROUP.neutralCost]) {
    for (const [name, c] of Object.entries(bwa.groups?.[g]?.classes ?? {})) {
      const amount = -(c.amountsSum ?? 0);
      if (amount === 0) continue;
      const pa = c.postingaccounts;
      const konten = !pa || Array.isArray(pa)
        ? []
        : Object.entries(pa as Record<string, { amountsSum?: number; name?: string }>)
            .map(([nr, a]) => ({ nummer: Number(nr), name: a.name ?? "", amount: r2(-(a.amountsSum ?? 0)) }))
            .filter((a) => a.amount !== 0)
            .sort((a, b) => b.amount - a.amount);
      kostenarten.push({ name, amount: r2(amount), konten });
    }
  }
  return {
    gesamtleistung: r2(gesamtleistung),
    umsatzerloese: r2(umsatz),
    ertraege: r2(ertraege),
    kosten: r2(kosten),
    ebit: r2(ebit),
    ebitda: r2(ebitda),
    gesamtergebnis: r2(ergebnis),
    abschreibungen: r2(abschreibungen),
    zinsaufwand: r2(zinsaufwand),
    personalkosten: r2(personal),
    cogs: r2(cogs),
    ebit_marge_pct: pct(ebit, gesamtleistung),
    ebitda_marge_pct: pct(ebitda, gesamtleistung),
    umsatzrentabilitaet_pct: pct(ebit, umsatz),
    cogs_marge_pct: pct(cogs, gesamtleistung),
    personalaufwandsquote_pct: pct(personal, gesamtleistung),
    kostenarten,
  };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const utc = (s: string) => {
  const m = DATE.exec(s);
  if (!m) throw new Error(`Datum "${s}" ist nicht im Format YYYY-MM-DD.`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== s) throw new Error(`Datum "${s}" gibt es nicht.`);
  return d;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (y: number, m0: number) => iso(new Date(Date.UTC(y, m0, 1)));
const monthEnd = (y: number, m0: number) => iso(new Date(Date.UTC(y, m0 + 1, 0)));

export interface Range {
  from: string;
  to: string;
}

// Zeitraum direkt davor: bei ganzen Monaten gleich viele Monate davor, sonst gleich viele Tage.
export function previousRange(r: Range): Range {
  const f = utc(r.from);
  const t = utc(r.to);
  const wholeMonths = f.getUTCDate() === 1 && iso(t) === monthEnd(t.getUTCFullYear(), t.getUTCMonth());
  if (wholeMonths) {
    const n = (t.getUTCFullYear() * 12 + t.getUTCMonth()) - (f.getUTCFullYear() * 12 + f.getUTCMonth()) + 1;
    const start = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() - n, 1));
    return { from: iso(start), to: monthEnd(start.getUTCFullYear(), start.getUTCMonth() + n - 1) };
  }
  const days = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  const to = new Date(f.getTime() - 86400000);
  return { from: iso(new Date(to.getTime() - (days - 1) * 86400000)), to: iso(to) };
}

// Sechs Kalendermonate bis einschließlich dem Monat von `to` (wie die Zeitreihen im Dashboard).
export function seriesMonths(to: string, count = 6): Range[] {
  const t = utc(to);
  const out: Range[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - i, 1));
    out.push({ from: monthStart(d.getUTCFullYear(), d.getUTCMonth()), to: monthEnd(d.getUTCFullYear(), d.getUTCMonth()) });
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const monthLabel = (r: Range) => `${MONTHS[Number(r.from.slice(5, 7)) - 1]} ${r.from.slice(0, 4)}`;

export interface ControllingOptions {
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxWaitMs?: number;
}

const NOT_READY = /not been finished/i;

export function createControllingTools(client: BBClient, opts: ControllingOptions = {}): [ToolDef] {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 3000;
  const maxWaitMs = opts.maxWaitMs ?? 120_000;

  async function fetchBwa(range: Range): Promise<Bwa> {
    const created = await client.call<{ id_by_customer?: string | number }>("reportsCreateBwa", {
      date_from: range.from,
      date_to: range.to,
    });
    const id = Number(created.id_by_customer);
    if (!Number.isInteger(id)) throw new Error(`BHB hat für ${range.from} bis ${range.to} keine Report-ID geliefert.`);
    for (let waited = 0; ; waited += pollMs) {
      try {
        const res = await client.call<{ report?: Bwa }>("reportsGetBwa", { report_id_by_customer: id });
        if (!res.report) throw new Error(`BWA ${id} (${range.from} bis ${range.to}) kam ohne Inhalt zurück.`);
        return res.report;
      } catch (e) {
        const pending = e instanceof BuchhaltungsButlerApiError && e.statusCode === 400 && NOT_READY.test(e.message);
        if (!pending) throw e;
        if (waited >= maxWaitMs) throw new Error(`BWA ${id} (${range.from} bis ${range.to}) war nach ${maxWaitMs / 1000} s nicht fertig.`);
        await sleep(pollMs);
      }
    }
  }

  const getControlling = defineTool({
    name: "get_controlling",
    description:
      "Controlling-Auswertung wie das Dashboard 'Controlling > Profitabilität' von BuchhaltungsButler (Beta, kostenpflichtiges Add-on; " +
      "die API hat dafür keinen Endpunkt), gerechnet aus der BWA: Erträge, Kosten, Gesamtergebnis, EBIT und EBITDA mit Marge, " +
      "Umsatzrentabilität, Kosten nach Kostenart mit Anteil und Veränderung, COGS, Personalaufwandsquote, 'Rule of BHB' und eine " +
      "Zeitreihe über sechs Monate - Zeitraum gegen Vergleichszeitraum. Fragt der Nutzer nach Controlling, Kennzahlen, EBITDA, " +
      "Profitabilität oder Kostenstruktur, dieses Tool aufrufen und das Ergebnis als Artefakt darstellen (Skill dataviz laden): " +
      "Kennzahlen-Kacheln mit Differenz zum Vergleich, Linien für Erträge/Kosten/Ergebnis, Balken für Kostenarten. " +
      "Es erzeugt nacheinander BWA-Reports (2, mit series bis 8; je einige Sekunden) und ERSETZT damit die zuletzt in BHB " +
      "erzeugte BWA. Nur bestätigte Buchungen zählen; die Antwort warnt bei unbestätigten. Nicht enthalten: Kapitalrentabilität " +
      "(braucht Eigen-/Fremdkapital) und die Jahresvergleiche von COGS und Personalkosten. period_*/comparison_* als YYYY-MM-DD.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      period_from: z.string().describe("YYYY-MM-DD, erster Tag des Zeitraums."),
      period_to: z.string().describe("YYYY-MM-DD, letzter Tag des Zeitraums."),
      comparison_from: z.string().optional().describe("YYYY-MM-DD. Ohne Angabe: der Zeitraum direkt davor, gleich lang."),
      comparison_to: z.string().optional().describe("YYYY-MM-DD, nur zusammen mit comparison_from."),
      series: z.boolean().optional().describe("Zeitreihe über sechs Monate bis zum Ende des Zeitraums (Standard true). false spart sechs Reports."),
    },
    async handler(args) {
      const period: Range = { from: args.period_from, to: args.period_to };
      if (utc(period.from) > utc(period.to)) throw new Error("period_from liegt nach period_to.");
      if ((args.comparison_from === undefined) !== (args.comparison_to === undefined)) {
        throw new Error("comparison_from und comparison_to gehören zusammen.");
      }
      const comparison: Range =
        args.comparison_from !== undefined && args.comparison_to !== undefined
          ? { from: args.comparison_from, to: args.comparison_to }
          : previousRange(period);
      if (utc(comparison.from) > utc(comparison.to)) throw new Error("comparison_from liegt nach comparison_to.");

      // Gleiche Zeiträume nur einmal holen (z. B. ein einzelner Monat, der auch Teil der Zeitreihe ist).
      const cache = new Map<string, Promise<Bwa>>();
      const get = (r: Range) => {
        const key = `${r.from}|${r.to}`;
        if (!cache.has(key)) cache.set(key, fetchBwa(r));
        return cache.get(key)!;
      };
      // Nacheinander, nie parallel: BHB führt nur eine BWA gleichzeitig.
      const cur = await get(period);
      const prev = await get(comparison);
      const months = args.series === false ? [] : seriesMonths(period.to);
      const monthly: Kpis[] = [];
      for (const m of months) monthly.push(kpisFromBwa(await get(m)));

      const k = kpisFromBwa(cur);
      const p = kpisFromBwa(prev);

      const prevByName = new Map(p.kostenarten.map((c) => [c.name, c]));
      const curByName = new Map(k.kostenarten.map((c) => [c.name, c]));
      const names = new Set([...curByName.keys(), ...prevByName.keys()]);
      const kostenarten = [...names]
        .map((name) => {
          const amount = curByName.get(name)?.amount ?? 0;
          const before = prevByName.get(name)?.amount ?? 0;
          // Konten beider Zeiträume, damit auch ein Konto sichtbar ist, das nur im Vergleich Umsatz hatte.
          const nrs = new Set([...(curByName.get(name)?.konten ?? []), ...(prevByName.get(name)?.konten ?? [])].map((a) => a.nummer));
          const konten = [...nrs]
            .map((nummer) => {
              const c = curByName.get(name)?.konten.find((a) => a.nummer === nummer);
              const v = prevByName.get(name)?.konten.find((a) => a.nummer === nummer);
              return {
                nummer,
                name: c?.name ?? v?.name ?? "",
                amount: c?.amount ?? 0,
                anteil_an_kostenart_pct: pct(c?.amount ?? 0, amount),
                vergleich: v?.amount ?? 0,
                veraenderung_pct: change(c?.amount ?? 0, v?.amount ?? 0),
              };
            })
            .sort((a, b) => b.amount - a.amount || b.vergleich - a.vergleich);
          return { name, amount, anteil_pct: pct(amount, k.kosten), vergleich: before, veraenderung_pct: change(amount, before), konten };
        })
        .sort((a, b) => b.amount - a.amount);

      const umsatzwachstum = change(k.umsatzerloese, p.umsatzerloese);
      const warnings: string[] = [];
      for (const [label, bwa] of [["Zeitraum", cur], ["Vergleichszeitraum", prev]] as const) {
        if (bwa.integrityError) warnings.push(`BHB meldet für den ${label} einen Integritätsfehler in der BWA; Zahlen nicht verwenden, bis er geklärt ist.`);
        if ((bwa.uncompletedPostingsCount ?? 0) > 0) {
          warnings.push(`${label}: ${bwa.uncompletedPostingsCount} unvollständige Buchungen (uncompletedPostingsCount) sind in der BWA nicht enthalten.`);
        }
      }
      if (k.gesamtleistung === 0) warnings.push("Gesamtleistung im Zeitraum ist 0: Margen und Quoten sind nicht berechenbar (null).");

      return ok({
        period,
        comparison,
        kpis: {
          zeitraum: k,
          vergleichszeitraum: p,
          differenz: {
            ebit: r2(k.ebit - p.ebit),
            ebitda: r2(k.ebitda - p.ebitda),
            ebit_marge_pp: diff(k.ebit_marge_pct, p.ebit_marge_pct),
            ebitda_marge_pp: diff(k.ebitda_marge_pct, p.ebitda_marge_pct),
            umsatzrentabilitaet_pp: diff(k.umsatzrentabilitaet_pct, p.umsatzrentabilitaet_pct),
            cogs_marge_pp: diff(k.cogs_marge_pct, p.cogs_marge_pct),
            personalaufwandsquote_pp: diff(k.personalaufwandsquote_pct, p.personalaufwandsquote_pct),
            umsatzerloese_pct: umsatzwachstum,
            kosten_pct: change(k.kosten, p.kosten),
            personalkosten_pct: change(k.personalkosten, p.personalkosten),
            cogs_pct: change(k.cogs, p.cogs),
          },
          // Nachgerechnet gegen ein Dashboard-Beispiel (gerundet gleich), aber nicht von BHB dokumentiert: Umsatzwachstum
          // plus EBIT/Umsatz. BHB beschreibt nur "Umsatzwachstum und EBIT-Marge im ausgewählten Zeitraum".
          rule_of_bhb: umsatzwachstum === null || k.umsatzrentabilitaet_pct === null ? null : r2(umsatzwachstum + k.umsatzrentabilitaet_pct),
        },
        kostenarten,
        zeitreihe: {
          monate: months.map(monthLabel),
          ertraege: monthly.map((m) => m.ertraege),
          kosten: monthly.map((m) => m.kosten),
          gesamtergebnis: monthly.map((m) => m.gesamtergebnis),
          umsatzerloese: monthly.map((m) => m.umsatzerloese),
        },
        hinweise: [
          "Quelle ist die BWA (nur bestätigte Buchungen). EBIT = Betriebsergebnis, EBITDA = EBIT + Abschreibungen, Margen auf die Gesamtleistung, Umsatzrentabilität auf die Umsatzerlöse.",
          "Kosten (Gesamtkosten im Dashboard) = Gesamtkosten + Wareneinsatz + neutraler Aufwand (z. B. Zinsaufwand); Erträge = Gesamtleistung + neutraler Ertrag. Gegen ein Livekonto ohne Wareneinsatz und ohne sonstigen neutralen Aufwand nachgerechnet; mit Wareneinsatz nicht belegt.",
          "COGS = Kosten Warenabgabe + Wareneinsatz (BHB: produktbezogene Kosten ohne Personal); rule_of_bhb ist eine Ableitung, keine dokumentierte Formel.",
          "Nicht enthalten: Kapitalrentabilität (Eigen-/Fremd-/Gesamtkapital) und die Jahresvergleiche von COGS und Personalkosten.",
        ],
        warnings,
      });
    },
  });

  return [getControlling];
}
