import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { createReportRunner, type Range, type RunnerOptions } from "./report-runner.js";
import { seriesMonths } from "./controlling.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";
import { finishWithExport } from "./export-file.js";

// Nachbau des Dashboards "Controlling (Beta) > Liquidität" der BHB-Oberfläche. Stand 30.10.2026 gegen ein Livekonto
// (SKR03, EÜR, ohne Debitoren/Kreditoren) nachgerechnet; was auf den Cent stimmt und was nicht, steht in `hinweise`.
//
// Cash-Bestand und Working Capital kommen aus der Summen- und Saldenliste zum Monatsende (gebuchte Buchungen):
//   Cash-Bestand    = Summe der Salden aller Konten der Klasse "Finanzkonto" (auch Darlehens- und Verrechnungskonten
//                     dieser Klasse, nicht nur Bank und Kasse)
//   Working Capital = Cash-Bestand - Saldo Vorsteuer - Saldo Umsatzsteuer + Saldo Verbindlichkeiten (Salden Soll positiv)
//                     Die Vorzeichen sind ungewöhnlich, aber so rechnet BHB: drei Monate auf den Cent bestätigt.
// Forderungen und Verbindlichkeiten sind die offenen Belege (Summe aller, auch Gutschriften).

type Row = Record<string, unknown>;

interface SumsEntry {
  postingaccount?: { class?: string; type?: string; name?: string; postingaccount_number?: number };
  balanceAfterAbsolute?: number;
  balanceAfterSide?: string;
}
interface Sums {
  sums?: Record<string, SumsEntry>;
  integrityError?: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const signed = (e: SumsEntry) => (e.balanceAfterSide === "credit" ? -1 : 1) * (e.balanceAfterAbsolute ?? 0);

export interface Balances {
  cash: number;
  vorsteuer: number;
  umsatzsteuer: number;
  verbindlichkeiten: number;
  workingCapital: number;
  finanzkonten: string[];
  interimskonten: string[];
}

export function balancesFromSums(report: Sums): Balances {
  const by = { fin: 0, vst: 0, ust: 0, verb: 0 };
  const finanzkonten: string[] = [];
  const interimskonten: string[] = [];
  for (const [nr, e] of Object.entries(report.sums ?? {})) {
    const cls = e.postingaccount?.class;
    if (cls === "Finanzkonto") {
      by.fin += signed(e);
      finanzkonten.push(nr);
    } else if (cls === "Vorsteuer") by.vst += signed(e);
    else if (cls === "Umsatzsteuer") by.ust += signed(e);
    else if (cls === "Verbindlichkeiten") by.verb += signed(e);
    else if (cls === "Interimskonto" || cls === "Saldovortrag") interimskonten.push(nr);
  }
  return {
    cash: r2(by.fin),
    vorsteuer: r2(by.vst),
    umsatzsteuer: r2(by.ust),
    verbindlichkeiten: r2(by.verb),
    workingCapital: r2(by.fin - by.vst - by.ust + by.verb),
    finanzkonten,
    interimskonten,
  };
}

// Einzahlungen und Auszahlungen je Monat aus den Buchungen auf Finanzkonten (nach Buchungsdatum). Buchungen gegen
// Interims- und Geldtransitkonten (zurückgebuchte Lastschriften, Umbuchungen), gegen das Saldenvortragskonto
// (Anfangssalden) und zwischen Finanzkonten zählen nicht.
export function cashflowByMonth(
  postings: Row[],
  finanzkonten: Set<string>,
  ausgenommen: Set<string>,
  months: string[]
): Map<string, { ein: number; aus: number }> {
  const out = new Map(months.map((m) => [m, { ein: 0, aus: 0 }]));
  for (const p of postings) {
    const m = String(p.date ?? "").slice(0, 7);
    const slot = out.get(m);
    if (!slot) continue;
    const amount = Number(p.amount);
    const db = String(p.debit_postingaccount_number ?? "");
    const cr = String(p.credit_postingaccount_number ?? "");
    if (!Number.isFinite(amount)) continue;
    if (finanzkonten.has(db) && !finanzkonten.has(cr) && !ausgenommen.has(cr)) slot.ein += amount;
    else if (finanzkonten.has(cr) && !finanzkonten.has(db) && !ausgenommen.has(db)) slot.aus += amount;
  }
  return out;
}

const DAY = 86400000;
const day = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};
const minusYear = (iso: string) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4, 10)}`;

export interface OpenKpis {
  summe: number;
  anzahl: number;
  top: Array<{ name: string; betrag: number }>;
  zweifelhaft: { betrag: number; anteil_pct: number | null };
}

// Offene Belege: Summe aller (Gutschriften mindern), die drei größten Gegenparteien unter den offenen Belegen der letzten
// zwölf Monate, und der Teil, der seit mindestens 90 Tagen überfällig ist (Fälligkeit, ohne Fälligkeit Belegdatum).
export function openReceiptKpis(rows: Row[], asOf: string, topN = 3): OpenKpis {
  const since = day(minusYear(asOf));
  const now = day(asOf);
  let summe = 0;
  let zweifelhaft = 0;
  const by = new Map<string, number>();
  for (const r of rows) {
    const amount = Number(r.amount);
    if (!Number.isFinite(amount)) continue;
    summe += amount;
    const date = day(String(r.date ?? ""));
    if (date >= since) by.set(String(r.counterparty ?? ""), (by.get(String(r.counterparty ?? "")) ?? 0) + amount);
    const due = day(String(r.due_date ?? r.date ?? ""));
    if (Number.isFinite(due) && Math.floor((now - due) / DAY) >= 90) zweifelhaft += amount;
  }
  const top = [...by.entries()]
    .map(([name, betrag]) => ({ name, betrag: r2(betrag) }))
    .sort((a, b) => b.betrag - a.betrag)
    .slice(0, topN);
  return {
    summe: r2(summe),
    anzahl: rows.length,
    top,
    zweifelhaft: { betrag: r2(zweifelhaft), anteil_pct: summe === 0 ? null : r2((zweifelhaft / summe) * 100) },
  };
}

export interface OpenReceipt {
  id: number;
  datum: string;
  faellig: string | null;
  nummer: string;
  gegenpartei: string;
  betrag: number;
  // Tage seit der Fälligkeit (ohne Fälligkeit seit dem Belegdatum); negativ = noch nicht fällig.
  tage_ueberfaellig: number | null;
}

export function openReceiptRows(rows: Row[], asOf: string): OpenReceipt[] {
  const now = day(asOf);
  return rows
    .map((r) => {
      const ref = day(String(r.due_date ?? r.date ?? ""));
      return {
        id: Number(r.id_by_customer),
        datum: String(r.date ?? "").slice(0, 10),
        faellig: r.due_date ? String(r.due_date).slice(0, 10) : null,
        nummer: String(r.invoicenumber ?? ""),
        gegenpartei: String(r.counterparty ?? ""),
        betrag: r2(Number(r.amount)),
        tage_ueberfaellig: Number.isFinite(ref) ? Math.floor((now - ref) / DAY) : null,
      };
    })
    .filter((r) => Number.isFinite(r.betrag))
    .sort((a, b) => a.gegenpartei.localeCompare(b.gegenpartei, "de") || a.datum.localeCompare(b.datum));
}

export interface OpenParty {
  name: string;
  offen: number;
  anzahl: number;
  ueberfaellig_90: number;
  aelteste_faelligkeit: string | null;
}

// Offene Belege je Gegenpartei, größte offene Summe zuerst.
export function openByParty(rows: OpenReceipt[]): OpenParty[] {
  const by = new Map<string, OpenParty>();
  for (const r of rows) {
    const p = by.get(r.gegenpartei) ?? { name: r.gegenpartei, offen: 0, anzahl: 0, ueberfaellig_90: 0, aelteste_faelligkeit: null };
    p.offen += r.betrag;
    p.anzahl += 1;
    if (r.tage_ueberfaellig !== null && r.tage_ueberfaellig >= 90) p.ueberfaellig_90 += r.betrag;
    const ref = r.faellig ?? r.datum;
    if (ref && (p.aelteste_faelligkeit === null || ref < p.aelteste_faelligkeit)) p.aelteste_faelligkeit = ref;
    by.set(r.gegenpartei, p);
  }
  return [...by.values()]
    .map((p) => ({ ...p, offen: r2(p.offen), ueberfaellig_90: r2(p.ueberfaellig_90) }))
    .sort((a, b) => b.offen - a.offen || a.name.localeCompare(b.name, "de"));
}

// Durchschnittliche Tage vom Belegdatum bis zur Zahlungsbuchung, über Zahlungen der letzten zwölf Monate auf Belege der
// letzten zwölf Monate; Sammelzahlungen auf mehrere Belege zählen nicht. NÄHERUNG: im Livekonto (30.10.2026) lag sie um einige
// Tage über BHBs Werten, mit Sammelzahlungen noch weiter darüber. BHBs genaue Definition ist unbekannt.
export function averagePaymentDays(postings: Row[], type: "invoice outbound" | "invoice inbound", finanzkonten: Set<string>, asOf: string) {
  const since = day(minusYear(asOf));
  let sum = 0;
  let n = 0;
  for (const p of postings) {
    const types = String(p.receipts_assigned_types ?? "").split(/,\s*/).filter(Boolean);
    const dates = String(p.receipts_assigned_dates ?? "").split(/,\s*/).filter(Boolean);
    if (types.length !== 1 || dates.length !== 1) continue;
    const db = String(p.debit_postingaccount_number ?? "");
    const cr = String(p.credit_postingaccount_number ?? "");
    if (!finanzkonten.has(db) && !finanzkonten.has(cr)) continue;
    const paid = day(String(p.date ?? ""));
    types.forEach((t, i) => {
      const rd = day(dates[i]);
      if (t !== type || !(rd >= since) || !Number.isFinite(paid)) return;
      sum += Math.round((paid - rd) / DAY);
      n++;
    });
  }
  return { tage: n === 0 ? null : r2(sum / n), anzahl: n };
}

async function readAll(client: BBClient, key: "receiptsGet" | "postingsGet", params: Record<string, unknown>, page: number): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  for (let i = 0; i < 20; i++) {
    const res = await client.call<BBListResult>(key, { ...params, limit: page, offset: i * page });
    rows.push(...(res.data ?? []));
    if ((res.data ?? []).length < page) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

export function createLiquidityTools(client: BBClient, opts: RunnerOptions = {}): [ToolDef] {
  const runReport = createReportRunner(client, { pollMs: 4000, ...opts });

  const getLiquidity = defineTool({
    name: "get_liquidity",
    description:
      "Liquiditäts-Auswertung wie das Dashboard 'Controlling > Liquidität' von BuchhaltungsButler (Beta, kostenpflichtiges Add-on; " +
      "die API hat dafür keinen Endpunkt): Cash-Bestand, Working Capital und Cashflow (Ein-/Auszahlungen) über 12 Monate, " +
      "Burn Rate und Cash Runway, offene Forderungen und Verbindlichkeiten mit den drei größten Kunden/Lieferanten, Anteil " +
      "zweifelhafter Forderungen (mindestens 90 Tage überfällig), Debitoren-/Kreditorenlaufzeit, Quick Ratio, Future Cash-Inflow, " +
      "dazu alle offenen Belege je Firma (parteien) und einzeln (belege) zum Anklicken. " +
      "Fragt der Nutzer nach Liquidität, Cash, Working Capital, Burn Rate oder offenen Posten, dieses Tool aufrufen und als " +
      "Artefakt darstellen (Skill dataviz laden). Es erzeugt je Monat eine Summen- und Saldenliste (bis 12, je einige Sekunden; " +
      "months senkt die Zahl) und ERSETZT damit die zuletzt in BHB erzeugte SuSa. Nur bestätigte Buchungen zählen. Cash-Bestand, " +
      "Working Capital, Forderungen, Verbindlichkeiten, Top-Kunden/-Lieferanten, Zweifelhaftes, Quick Ratio und Future Cash-Inflow " +
      "sind gegen BHBs Dashboard auf den Cent belegt; Cashflow, Burn Rate, Runway und die Laufzeiten weichen ab (siehe hinweise). " +
      "as_of als YYYY-MM-DD, Standard heute.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      as_of: z.string().optional().describe("YYYY-MM-DD, Stichtag. Standard: heute."),
      months: z.number().int().min(1).max(12).optional().describe("Monate der Zeitreihe, Standard 12. Weniger spart Summen- und Saldenlisten."),
      save_as: z.string().optional().describe("Dateiname (ohne Pfad): das volle Ergebnis wird als JSON unter ~/.mcp-buchhaltungsbutler/exports/ gespeichert und nur eine Kurzfassung zurückgegeben. Für Artefakte und große Auswertungen."),
    },
    async handler(args) {
      const asOf = args.as_of ?? new Date().toISOString().slice(0, 10);
      if (!Number.isFinite(day(asOf))) throw new Error(`as_of "${asOf}" ist nicht im Format YYYY-MM-DD.`);
      const count = args.months ?? 12;
      const monthRanges = seriesMonths(asOf, count);
      const keys = monthRanges.map((r) => r.from.slice(0, 7));

      // Nacheinander: BHB führt nur eine Summen- und Saldenliste gleichzeitig.
      const balances: Balances[] = [];
      let integrity = false;
      for (const m of monthRanges) {
        const range: Range = { from: `${m.from.slice(0, 4)}-01-01`, to: m.to > asOf ? asOf : m.to };
        const report = await runReport<Sums>("sums", range);
        integrity = integrity || report.integrityError === true;
        balances.push(balancesFromSums(report));
      }
      const last = balances[balances.length - 1];
      const fin = new Set(last.finanzkonten);
      const excluded = new Set(last.interimskonten);

      const [outbound, inbound, postings] = await Promise.all([
        readAll(client, "receiptsGet", { list_direction: "outbound", payment_status: "unpaid", deleted: false }, 500),
        readAll(client, "receiptsGet", { list_direction: "inbound", payment_status: "unpaid", deleted: false }, 500),
        readAll(client, "postingsGet", { date_from: monthRanges[0].from, date_to: asOf, posting_status: "all" }, 1000),
      ]);
      const forderungen = openReceiptKpis(outbound.rows, asOf);
      const verbindlichkeiten = openReceiptKpis(inbound.rows, asOf);
      const outRows = openReceiptRows(outbound.rows, asOf);
      const inRows = openReceiptRows(inbound.rows, asOf);
      const flow = cashflowByMonth(postings.rows, fin, excluded, keys);
      const ein = keys.map((k) => r2(flow.get(k)!.ein));
      const aus = keys.map((k) => r2(flow.get(k)!.aus));
      const cashflow = ein.map((e, i) => r2(e - aus[i]));
      // BHB: Burn Rate = Mittel von (Auszahlungen - Einzahlungen) über die Monate; Runway = Cash-Bestand durch Burn Rate.
      const burn = r2(aus.reduce((a, b) => a + b, 0) / count - ein.reduce((a, b) => a + b, 0) / count);
      const dso = averagePaymentDays(postings.rows, "invoice outbound", fin, asOf);
      const dpo = averagePaymentDays(postings.rows, "invoice inbound", fin, asOf);

      const warnings: string[] = [];
      if (integrity) warnings.push("BHB meldet einen Integritätsfehler in einer Summen- und Saldenliste; Zahlen nicht verwenden, bis er geklärt ist.");
      if (fin.size === 0) warnings.push("Kein Konto der Klasse Finanzkonto gefunden: Cash-Bestand und Working Capital sind 0.");
      for (const [label, r] of [["Belege (offene Ausgangsrechnungen)", outbound], ["Belege (offene Eingangsrechnungen)", inbound], ["Buchungen", postings]] as const) {
        if (r.truncated) warnings.push(`${label}: Abfrage nach 20 Seiten abgebrochen, Summen unvollständig.`);
      }

      return finishWithExport(args.save_as, {
        as_of: asOf,
        cash: {
          bestand: last.cash,
          working_capital: last.workingCapital,
          burn_rate: burn,
          cash_runway: burn === 0 ? null : r2(last.cash / burn),
          komponenten_working_capital: {
            finanzkonten: last.cash,
            vorsteuer: last.vorsteuer,
            umsatzsteuer: last.umsatzsteuer,
            verbindlichkeiten_konten: last.verbindlichkeiten,
          },
        },
        forderungen: { ...forderungen, debitorenlaufzeit_tage: dso.tage, debitorenlaufzeit_belege: dso.anzahl, parteien: openByParty(outRows), belege: outRows },
        verbindlichkeiten: { ...verbindlichkeiten, kreditorenlaufzeit_tage: dpo.tage, kreditorenlaufzeit_belege: dpo.anzahl, parteien: openByParty(inRows), belege: inRows },
        kennzahlen: {
          quick_ratio: verbindlichkeiten.summe === 0 ? null : r2((last.cash + forderungen.summe) / verbindlichkeiten.summe),
          future_cash_inflow: r2(forderungen.summe - verbindlichkeiten.summe),
        },
        zeitreihe: {
          monate: monthRanges.map((m) => `${MONTHS[Number(m.from.slice(5, 7)) - 1]} ${m.from.slice(0, 4)}`),
          cash_bestand: balances.map((b) => b.cash),
          working_capital: balances.map((b) => b.workingCapital),
          einzahlungen: ein,
          auszahlungen: aus,
          cashflow,
        },
        hinweise: [
          "Cash-Bestand = Summe der Salden aller Konten der Klasse Finanzkonto in der Summen- und Saldenliste (gebuchte Buchungen), auch Darlehens- und Verrechnungskonten dieser Klasse. Ein Darlehenskonto im Minus drückt ihn tief ins Negative.",
          "Working Capital = Cash-Bestand - Saldo Vorsteuer - Saldo Umsatzsteuer + Saldo Verbindlichkeiten (Soll positiv): so rechnet BHB, die Vorzeichen sind ungewöhnlich. Auf den Cent belegt gegen BHB für drei Monate; ohne Debitoren/Kreditoren-Konten geprüft, deren Behandlung ist nicht belegt.",
          "Forderungen und Verbindlichkeiten = Summe der offenen Belege (Gutschriften mindern). Top-Kunden und -Lieferanten: offene Belege der letzten zwölf Monate je Gegenpartei. Zweifelhaft: Fälligkeit (ohne Fälligkeit Belegdatum) mindestens 90 Tage her.",
          "Cashflow aus den Buchungen auf Finanzkonten nach Buchungsdatum, ohne Interims-/Geldtransitkonten und ohne Anfangssalden (Saldenvortrag). Stimmt mit BHB bis auf wenige Euro je Monat; in einem Monat wich BHB im Livekonto bei den Auszahlungen deutlich ab (Ursache nicht geklärt), dadurch weichen Burn Rate und Cash Runway ab.",
          "Cash Runway = Cash-Bestand durch Burn Rate (BHB beschriftet das mit Tagen, rechnerisch sind es Monate). Bei negativem Cash-Bestand und negativer Burn Rate ist die Zahl nicht aussagekräftig.",
          "Debitoren-/Kreditorenlaufzeit sind Näherungen (Zahlungsbuchung minus Belegdatum, Zahlungen auf genau einen Beleg, Belege der letzten zwölf Monate): BHB zeigte im Livekonto niedrigere Werte als diese Näherung. BHBs Definition ist unbekannt.",
        ],
        warnings,
      });
    },
  });

  return [getLiquidity];
}
