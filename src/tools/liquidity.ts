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
  sumPeriodDebit?: number | string | null;
  sumPeriodCredit?: number | string | null;
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
  forderungen: number;
  rueckstellung: number;
  // Salden der Debitoren- und Kreditorenkonten (Soll positiv) und ob es solche Konten gibt (Bilanzierer).
  debitoren: number;
  kreditoren: number;
  hatPersonenkonten: boolean;
  workingCapital: number;
  finanzkonten: string[];
  interimskonten: string[];
}

export function balancesFromSums(report: Sums): Balances {
  const by = { fin: 0, vst: 0, ust: 0, verb: 0, ford: 0, rueck: 0, deb: 0, kred: 0 };
  let personen = false;
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
    else if (cls === "Forderungen") by.ford += signed(e);
    else if (cls === "Rückstellung") by.rueck += signed(e);
    else if (cls === "Debitorenkonto") { by.deb += signed(e); personen = true; }
    else if (cls === "Kreditorenkonto") { by.kred += signed(e); personen = true; }
    else if (cls === "Interimskonto" || cls === "Saldovortrag") interimskonten.push(nr);
  }
  return {
    cash: r2(by.fin),
    vorsteuer: r2(by.vst),
    umsatzsteuer: r2(by.ust),
    verbindlichkeiten: r2(by.verb),
    forderungen: r2(by.ford),
    rueckstellung: r2(by.rueck),
    debitoren: r2(by.deb),
    kreditoren: r2(by.kred),
    hatPersonenkonten: personen,
    workingCapital: r2(by.fin - by.vst - by.ust + by.verb + by.ford + by.rueck),
    finanzkonten,
    interimskonten,
  };
}

// Einzahlungen und Auszahlungen je Monat aus den Buchungen auf Finanzkonten (nach Buchungsdatum), Split für Split.
// Buchungen gegen Interims- und Geldtransitkonten (zurückgebuchte Lastschriften, Umbuchungen), gegen das
// Saldenvortragskonto (Anfangssalden) und zwischen Finanzkonten zählen nicht. Abzüge innerhalb einer Zahlung liefert
// BHB als negative Beträge, Soll und Haben zeigen dann schon die Richtung: es zählt der Betrag ohne Vorzeichen.
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
    const amount = Math.abs(Number(p.amount));
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

// Top-Gegenparteien bei Konten mit Debitoren-/Kreditorenkonten: je Personenkonto der Umsatz auf der Rechnungsseite in den
// letzten zwölf Monaten (Debitoren Soll, Kreditoren Haben), aus einer SuSa über diesen Zeitraum. Je Konto, nicht je Name:
// hat eine Firma zwei Personenkonten, zählt jedes für sich (so zeigt es BHB). Am UG-Livekonto für alle sechs Einträge auf
// den Cent belegt; ein Saldovortrag aus der Zeit davor zählt nicht.
export function topPersonenkonten(report: Sums, cls: "Debitorenkonto" | "Kreditorenkonto", topN = 3): Array<{ name: string; betrag: number }> {
  return Object.values(report.sums ?? {})
    .filter((e) => e.postingaccount?.class === cls)
    .map((e) => ({
      name: e.postingaccount?.name ?? String(e.postingaccount?.postingaccount_number ?? ""),
      betrag: r2(Number(cls === "Debitorenkonto" ? e.sumPeriodDebit : e.sumPeriodCredit) || 0),
    }))
    .filter((t) => t.betrag > 0)
    .sort((a, b) => b.betrag - a.betrag)
    .slice(0, topN);
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

// Debitoren-/Kreditorenlaufzeit: einfaches Mittel aus Zahlungsdatum minus Belegdatum über alle bezahlten Belege der letzten zwölf
// Monate (payment_date des Belegs). Gegen BHBs Dashboard auf die zweite Nachkommastelle bestätigt (Ausgangs- und Eingangsrechnungen).
export function averageDaysToPay(rows: Row[]): { tage: number | null; anzahl: number } {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    const paid = day(String(r.payment_date ?? ""));
    const dated = day(String(r.date ?? ""));
    if (!Number.isFinite(paid) || !Number.isFinite(dated)) continue;
    sum += Math.round((paid - dated) / DAY);
    n++;
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

// Bereich der Tacho-Anzeige "Zweifelhafte Forderungen" im Dashboard (Halbkreis 0-100 %): grün bis 33, gelb bis 66, rot
// darüber (aus BHBs Oberflächen-Code, 30.10.2026).
export function zweifelhaftAmpel(anteilPct: number | null): "gruen" | "gelb" | "rot" | null {
  if (anteilPct === null) return null;
  return anteilPct < 33 ? "gruen" : anteilPct < 66 ? "gelb" : "rot";
}

// Kurze Erklärungen je Kennzahl in eigenen Worten (für Fragen des Nutzers und die Info-Symbole im Artefakt). Sie
// beschreiben, was hier gerechnet wird; wo BHBs Infotext davon abweicht, gilt die Rechnung.
const ERKLAERUNGEN = {
  cash_bestand: "Summe aller Konten der Klasse Finanzkonto zum Monatsende: Bank, Kasse, PayPal und auch Darlehenskonten, die als Finanzkonto geführt werden. Ein Darlehen im Minus drückt den Wert ins Negative.",
  working_capital: "Working Capital heißt Nettoumlaufvermögen: das kurzfristig verfügbare Geld abzüglich kurzfristiger Schulden. BuchhaltungsButler rechnet Cash-Bestand minus Vorsteuer, minus Umsatzsteuer, plus Verbindlichkeiten (die Vorzeichen sind ungewöhnlich). Die offenen Rechnungen sind darin nicht enthalten.",
  cashflow: "Ein- und Auszahlungen je Monat über alle Finanzkonten. Umbuchungen zwischen eigenen Konten (Geldtransit), durchlaufende Posten und Anfangssalden zählen nicht.",
  burn_rate: "Burn Rate heißt wörtlich Verbrennungsrate: der Durchschnitt der letzten zwölf Monate von Auszahlungen minus Einzahlungen. Positiv heißt: es fließt mehr ab als zu. Negativ heißt: im Schnitt kommt mehr herein.",
  cash_runway: "Cash-Bestand geteilt durch die Burn Rate: wie viele Monate das Geld beim jetzigen Verbrauch reicht. BHB beschriftet den Wert mit Tagen, gemeint sind Monate. Nur aussagekräftig bei positivem Cash-Bestand und positiver Burn Rate.",
  forderungen: "Summe der offenen Ausgangsrechnungen, also Geld, das Kunden noch schulden. Gutschriften mindern sie.",
  top_kunden: "Die drei Kunden mit den höchsten offenen Rechnungen aus den letzten zwölf Monaten. Mit Debitorenkonten (Bilanzierer): die drei Kunden mit dem höchsten Rechnungsumsatz der letzten zwölf Monate, bezahlt oder offen.",
  zweifelhaft: "Anteil der offenen Forderungen, die mindestens 90 Tage über der Fälligkeit liegen (ohne Fälligkeit: ab Rechnungsdatum). Die Anzeige ist grün bis 33 %, gelb bis 66 %, darüber rot.",
  debitorenlaufzeit: "Debitoren sind Kunden. Die Debitorenlaufzeit (englisch DSO, Days Sales Outstanding) ist die durchschnittliche Zahl der Tage vom Rechnungsdatum bis zur Zahlung, über alle bezahlten Rechnungen der letzten zwölf Monate. Kürzer ist besser.",
  verbindlichkeiten: "Summe der offenen Eingangsrechnungen, also was das Unternehmen Lieferanten noch schuldet.",
  top_lieferanten: "Die drei Lieferanten mit den höchsten offenen Rechnungen aus den letzten zwölf Monaten. Mit Kreditorenkonten (Bilanzierer): die drei Lieferanten mit dem höchsten Rechnungsumsatz der letzten zwölf Monate, bezahlt oder offen.",
  kreditorenlaufzeit: "Kreditoren sind Lieferanten. Die Kreditorenlaufzeit (englisch DPO, Days Payables Outstanding) ist die durchschnittliche Zahl der Tage vom Rechnungsdatum bis zur eigenen Zahlung. Ideal liegt sie über der Debitorenlaufzeit: Kunden zahlen dann, bevor Lieferanten bezahlt werden müssen.",
  quick_ratio: "Quick Ratio (Liquidität zweiten Grades): Cash-Bestand plus Forderungen geteilt durch Verbindlichkeiten. Über 1 reicht das kurzfristig Verfügbare für alle offenen Rechnungen, ab etwa 1,05 gilt es als gut. Zweifelhafte Forderungen zählen voll mit.",
  future_cash_inflow: "Forderungen minus Verbindlichkeiten: um wie viel sich der Geldbestand ändert, wenn alle offenen Rechnungen in beide Richtungen bezahlt werden (englisch: künftiger Geldzufluss).",
};

export function createLiquidityTools(client: BBClient, opts: RunnerOptions = {}): [ToolDef] {
  const runReport = createReportRunner(client, { pollMs: 4000, ...opts });

  const getLiquidity = defineTool({
    name: "get_liquidity",
    description:
      "Liquiditäts-Auswertung wie das Dashboard 'Controlling > Liquidität' von BuchhaltungsButler (Beta, in der Oberfläche nur bis 20.11.2026; " +
      "die API hat dafür keinen Endpunkt, das Tool braucht nur Summen- und Saldenliste, Buchungen und Belege): Cash-Bestand, Working Capital und Cashflow (Ein-/Auszahlungen) über 12 Monate, " +
      "Burn Rate und Cash Runway, offene Forderungen und Verbindlichkeiten mit den drei größten Kunden/Lieferanten, Anteil " +
      "zweifelhafter Forderungen (mindestens 90 Tage überfällig), Debitoren-/Kreditorenlaufzeit, Quick Ratio, Future Cash-Inflow, " +
      "dazu alle offenen Belege je Firma (parteien) und einzeln (belege) zum Anklicken. " +
      "Fragt der Nutzer nach Liquidität, Cash, Working Capital, Burn Rate oder offenen Posten, dieses Tool aufrufen und als " +
      "Artefakt darstellen (Skill dataviz laden). Es erzeugt je Monat eine Summen- und Saldenliste (bis 12, je einige Sekunden; " +
      "months senkt die Zahl) und ERSETZT damit die zuletzt in BHB erzeugte SuSa. Nur bestätigte Buchungen zählen. Cash-Bestand, " +
      "Working Capital, Forderungen, Verbindlichkeiten, Top-Kunden/-Lieferanten, Zweifelhaftes, Quick Ratio und Future Cash-Inflow " +
      "die Laufzeiten, Burn Rate und Runway sind gegen BHBs Dashboard belegt; Ein- und Auszahlungen einzelner Monate weichen um wenige Euro ab (siehe hinweise). " +
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

      // Nacheinander: BHB führt nur eine Summen- und Saldenliste gleichzeitig. Nach Leistungsdatum wie BHB: bei Bilanzierern
      // verschiebt ein abweichendes Leistungsdatum Kreditoren und Steuer in einen anderen Monat (am UG-Livekonto belegt).
      const balances: Balances[] = [];
      let integrity = false;
      for (const m of monthRanges) {
        const range: Range = { from: `${m.from.slice(0, 4)}-01-01`, to: m.to > asOf ? asOf : m.to };
        const report = await runReport<Sums>("sums", range, "date_delivery_else_date");
        integrity = integrity || report.integrityError === true;
        balances.push(balancesFromSums(report));
      }
      const last = balances[balances.length - 1];
      const fin = new Set(last.finanzkonten);
      const excluded = new Set(last.interimskonten);

      const since = minusYear(asOf);
      const [outbound, inbound, paidOut, paidIn, postings] = await Promise.all([
        readAll(client, "receiptsGet", { list_direction: "outbound", payment_status: "unpaid", deleted: false }, 500),
        readAll(client, "receiptsGet", { list_direction: "inbound", payment_status: "unpaid", deleted: false }, 500),
        readAll(client, "receiptsGet", { list_direction: "outbound", payment_status: "paid", deleted: false, date_from: since }, 500),
        readAll(client, "receiptsGet", { list_direction: "inbound", payment_status: "paid", deleted: false, date_from: since }, 500),
        readAll(client, "postingsGet", { date_from: monthRanges[0].from, date_to: asOf, posting_status: "all" }, 1000),
      ]);
      const forderungen = openReceiptKpis(outbound.rows, asOf);
      const verbindlichkeiten = openReceiptKpis(inbound.rows, asOf);
      // Mit Debitoren-/Kreditorenkonten (Bilanzierer) zählt BHB deren Salden, nicht die offenen Belege; die Top 3 sind der
      // Umsatz der Personenkonten über zwölf Monate (eine weitere SuSa, erster Tag des Monats elf Monate vor as_of bis as_of).
      if (last.hatPersonenkonten) {
        forderungen.summe = last.debitoren;
        verbindlichkeiten.summe = r2(-last.kreditoren);
        forderungen.zweifelhaft.anteil_pct = forderungen.summe === 0 ? null : r2((forderungen.zweifelhaft.betrag / forderungen.summe) * 100);
        verbindlichkeiten.zweifelhaft.anteil_pct = verbindlichkeiten.summe === 0 ? null : r2((verbindlichkeiten.zweifelhaft.betrag / verbindlichkeiten.summe) * 100);
        const jahr = await runReport<Sums>("sums", { from: seriesMonths(asOf, 12)[0].from, to: asOf }, "date_delivery_else_date");
        forderungen.top = topPersonenkonten(jahr, "Debitorenkonto");
        verbindlichkeiten.top = topPersonenkonten(jahr, "Kreditorenkonto");
      }
      const outRows = openReceiptRows(outbound.rows, asOf);
      const inRows = openReceiptRows(inbound.rows, asOf);
      const flow = cashflowByMonth(postings.rows, fin, excluded, keys);
      const ein = keys.map((k) => r2(flow.get(k)!.ein));
      const aus = keys.map((k) => r2(flow.get(k)!.aus));
      const cashflow = ein.map((e, i) => r2(e - aus[i]));
      // BHB: Burn Rate = Mittel von (Auszahlungen - Einzahlungen) über die Monate; Runway = Cash-Bestand durch Burn Rate.
      const burn = r2(aus.reduce((a, b) => a + b, 0) / count - ein.reduce((a, b) => a + b, 0) / count);
      const dso = averageDaysToPay(paidOut.rows);
      const dpo = averageDaysToPay(paidIn.rows);

      const warnings: string[] = [];
      if (integrity) warnings.push("BHB meldet einen Integritätsfehler in einer Summen- und Saldenliste; Zahlen nicht verwenden, bis er geklärt ist.");
      if (fin.size === 0) warnings.push("Kein Konto der Klasse Finanzkonto gefunden: Cash-Bestand und Working Capital sind 0.");
      for (const [label, r] of [["Belege (offene Ausgangsrechnungen)", outbound], ["Belege (offene Eingangsrechnungen)", inbound], ["Belege (bezahlte Ausgangsrechnungen)", paidOut], ["Belege (bezahlte Eingangsrechnungen)", paidIn], ["Buchungen", postings]] as const) {
        if (r.truncated) warnings.push(`${label}: Abfrage nach 20 Seiten abgebrochen, Summen unvollständig.`);
      }

      return finishWithExport(args.save_as, {
        as_of: asOf,
        cash: {
          bestand: last.cash,
          working_capital: last.workingCapital,
          burn_rate: burn,
          // BHB zeigt "unbegrenzt" (∞), wenn der Quotient negativ wird: das Geld reicht dann beim jetzigen Verlauf nie auf.
          cash_runway: burn === 0 || last.cash / burn < 0 ? null : r2(last.cash / burn),
          cash_runway_unbegrenzt: burn !== 0 && last.cash / burn < 0,
          komponenten_working_capital: {
            finanzkonten: last.cash,
            vorsteuer: last.vorsteuer,
            umsatzsteuer: last.umsatzsteuer,
            verbindlichkeiten_konten: last.verbindlichkeiten,
          },
        },
        forderungen: { ...forderungen, zweifelhaft_ampel: zweifelhaftAmpel(forderungen.zweifelhaft.anteil_pct), debitorenlaufzeit_tage: dso.tage, debitorenlaufzeit_belege: dso.anzahl, parteien: openByParty(outRows), belege: outRows },
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
        erklaerungen: ERKLAERUNGEN,
        hinweise: [
          "Cash-Bestand = Summe der Salden aller Konten der Klasse Finanzkonto in der Summen- und Saldenliste (gebuchte Buchungen), auch Darlehens- und Verrechnungskonten dieser Klasse. Ein Darlehenskonto im Minus drückt ihn tief ins Negative.",
          "Working Capital = Cash-Bestand - Saldo Vorsteuer - Saldo Umsatzsteuer + Saldo Verbindlichkeiten (Soll positiv): so rechnet BHB, die Vorzeichen sind ungewöhnlich. Auf den Cent belegt gegen BHB für drei Monate; ohne Debitoren/Kreditoren-Konten geprüft, deren Behandlung ist nicht belegt.",
          "Bilanzierer (Konten mit Debitoren-/Kreditorenkonten, an einem UG-Livekonto gegen BHB belegt): Forderungen und Verbindlichkeiten sind die Salden dieser Personenkonten (nicht die offenen Belege), die Top 3 sind je Personenkonto der Umsatz auf der Rechnungsseite der letzten zwölf Monate (Debitoren Soll, Kreditoren Haben; je Konto, nicht je Name; alle sechs Einträge auf den Cent). Das Working Capital enthält dort zusätzlich die Klassen Forderungen und Rückstellung und rechnet nach Leistungsdatum (Juni und September auf den Cent).",
          "Forderungen und Verbindlichkeiten (ohne Personenkonten, EÜR) = Summe der offenen Belege (Gutschriften mindern). Top-Kunden und -Lieferanten: offene Belege der letzten zwölf Monate je Gegenpartei. Zweifelhaft: Fälligkeit (ohne Fälligkeit Belegdatum) mindestens 90 Tage her.",
          "Cashflow aus den Buchungen auf Finanzkonten nach Buchungsdatum, Split für Split, ohne Interims-/Geldtransitkonten und ohne Anfangssalden (Saldenvortrag). Im Livekonto stimmt die Summe über zwölf Monate mit BHB auf den Cent, damit auch Burn Rate und Cash Runway. Einzelne Monate weichen um wenige Euro ab: BHB zählt dann einen kleinen Betrag zusätzlich auf beiden Seiten, netto gleich (Ursache nicht geklärt).",
          "Cash Runway = Cash-Bestand durch Burn Rate (BHB beschriftet das mit Tagen, rechnerisch sind es Monate). Wird der Quotient negativ, zeigt BHB unbegrenzt (∞): cash_runway ist dann null und cash_runway_unbegrenzt true. Sind Cash-Bestand und Burn Rate beide negativ, bleibt es eine Zahl, die kaum aussagekräftig ist.",
          "Debitoren-/Kreditorenlaufzeit = einfaches Mittel aus Zahlungsdatum minus Belegdatum über alle bezahlten Belege der letzten zwölf Monate (payment_date des Belegs); gegen BHBs Dashboard auf die zweite Nachkommastelle bestätigt.",
        ],
        warnings,
      });
    },
  });

  return [getLiquidity];
}
