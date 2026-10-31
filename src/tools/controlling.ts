import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { createReportRunner, type Range, type RunnerOptions } from "./report-runner.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";
import { finishWithExport } from "./export-file.js";

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
const ppDiff = (n1: number, d1: number, n2: number, d2: number): number | null =>
  d1 === 0 || d2 === 0 ? null : r2((n1 / d1 - n2 / d2) * 100);

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
  // Gesetzt, wenn die Zeile aus einem Sammelposten herausgelöst wurde (siehe promoteAccounts).
  aufgeteilt_aus?: string;
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
  ertragsarten: CostLine[];
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

  const lines = (groups: string[], sign: 1 | -1): CostLine[] => {
    const out: CostLine[] = [];
    for (const g of groups) {
      for (const [name, c] of Object.entries(bwa.groups?.[g]?.classes ?? {})) {
        const amount = sign * (c.amountsSum ?? 0);
        if (amount === 0) continue;
        const pa = c.postingaccounts;
        const konten = !pa || Array.isArray(pa)
          ? []
          : Object.entries(pa as Record<string, { amountsSum?: number; name?: string }>)
              .map(([nr, a]) => ({ nummer: Number(nr), name: a.name ?? "", amount: r2(sign * (a.amountsSum ?? 0)) }))
              .filter((a) => a.amount !== 0)
              .sort((a, b) => b.amount - a.amount);
        out.push({ name, amount: r2(amount), konten });
      }
    }
    return out;
  };
  const kostenarten = lines([GROUP.goods, GROUP.costs, GROUP.neutralCost], -1);
  const ertragsarten = lines([GROUP.output, GROUP.neutralIncome], 1);
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
    ertragsarten,
  };
}

// Sammelposten: "Sonstige Kosten" nimmt in der BWA alles auf, was keine eigene Klasse hat. Wenn ein einzelnes Konto darin
// einen großen Teil der Kosten ausmacht, ist "Sonstige" irreführend: das Konto wird
// dann eine eigene Kostenart, in beiden Zeiträumen gleich, und "Sonstige Kosten" steht am Ende der Liste.
export const CATCH_ALL = "Sonstige Kosten";

export function promotedAccounts(k: Kpis, thresholdPct: number): Set<number> {
  const out = new Set<number>();
  if (thresholdPct <= 0 || k.kosten === 0) return out;
  const line = k.kostenarten.find((l) => l.name === CATCH_ALL);
  for (const a of line?.konten ?? []) if ((a.amount / k.kosten) * 100 >= thresholdPct) out.add(a.nummer);
  return out;
}

export function promoteAccounts(k: Kpis, numbers: Set<number>): Kpis {
  if (numbers.size === 0) return k;
  const kostenarten: CostLine[] = [];
  for (const l of k.kostenarten) {
    if (l.name !== CATCH_ALL) {
      kostenarten.push(l);
      continue;
    }
    const moved = l.konten.filter((a) => numbers.has(a.nummer));
    const rest = l.konten.filter((a) => !numbers.has(a.nummer));
    for (const a of moved) kostenarten.push({ name: a.name, amount: a.amount, konten: [a], aufgeteilt_aus: CATCH_ALL });
    if (rest.length > 0) kostenarten.push({ name: l.name, amount: r2(rest.reduce((t, a) => t + a.amount, 0)), konten: rest });
  }
  return { ...k, kostenarten };
}

// Beide Zeiträume zu einer Liste zusammenführen (Betrag, Anteil, Vergleich, Veränderung, Konten); größte zuerst, der Sammelposten zuletzt.
export function mergeArten(cur: CostLine[], prev: CostLine[], total: number) {
  const curBy = new Map(cur.map((c) => [c.name, c]));
  const prevBy = new Map(prev.map((c) => [c.name, c]));
  const names = new Set([...curBy.keys(), ...prevBy.keys()]);
  return [...names]
    .map((name) => {
      const amount = curBy.get(name)?.amount ?? 0;
      const before = prevBy.get(name)?.amount ?? 0;
      // Konten beider Zeiträume, damit auch ein Konto sichtbar ist, das nur im Vergleich Umsatz hatte.
      const nrs = new Set([...(curBy.get(name)?.konten ?? []), ...(prevBy.get(name)?.konten ?? [])].map((a) => a.nummer));
      const konten = [...nrs]
        .map((nummer) => {
          const c = curBy.get(name)?.konten.find((a) => a.nummer === nummer);
          const v = prevBy.get(name)?.konten.find((a) => a.nummer === nummer);
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
      const aufgeteilt_aus = curBy.get(name)?.aufgeteilt_aus ?? prevBy.get(name)?.aufgeteilt_aus;
      return { name, amount, anteil_pct: pct(amount, total), vergleich: before, veraenderung_pct: change(amount, before), konten, ...(aufgeteilt_aus ? { aufgeteilt_aus } : {}) };
    })
    .sort((a, b) => Number(a.name === CATCH_ALL) - Number(b.name === CATCH_ALL) || b.amount - a.amount);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const utc = (s: string) => {
  const m = DATE.exec(s);
  if (!m) throw new Error(`Datum "${s}" ist nicht im Format YYYY-MM-DD.`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== s) throw new Error(`Datum "${s}" gibt es nicht.`);
  return d;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (y: number, m0: number) => iso(new Date(Date.UTC(y, m0, 1)));
const monthEnd = (y: number, m0: number) => iso(new Date(Date.UTC(y, m0 + 1, 0)));
const minusOneYear = (s: string) => `${Number(s.slice(0, 4)) - 1}${s.slice(4)}`;
export const dayBefore = (s: string) => iso(new Date(utc(s).getTime() - 86400000));

export type { Range };

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
export const monthLabel = (r: Range) => `${MONTHS[Number(r.from.slice(5, 7)) - 1]} ${r.from.slice(0, 4)}`;

export interface Buchung {
  konto: number;
  id: number;
  datum: string;
  text: string;
  betrag: number;
  gegenkonto: number | null;
  beleg: boolean;
}

// Normale Seite jedes Kontos der BWA: Erträge im Haben, alles andere im Soll.
export function accountSides(bwa: Bwa): Map<number, "debit" | "credit"> {
  const out = new Map<number, "debit" | "credit">();
  for (const [g, group] of Object.entries(bwa.groups ?? {})) {
    const side = g === GROUP.output || g === GROUP.neutralIncome ? "credit" : "debit";
    for (const c of Object.values(group.classes ?? {})) {
      const pa = c.postingaccounts;
      if (!pa || Array.isArray(pa)) continue;
      for (const nr of Object.keys(pa)) out.set(Number(nr), side);
    }
  }
  return out;
}

type LedgerRow = Record<string, unknown>;

// base "date_delivery_else_date": nach Leistungsdatum wie die BWA (bei Bilanzierern verschiebt das Buchungen in einen anderen
// Monat); ohne Angabe nach Buchungsdatum.
export async function fetchLedger(client: BBClient, konto: number, side: "debit" | "credit", range: Range, base?: "date_delivery_else_date"): Promise<Buchung[]> {
  const res = await client.call<{ report_sums_postingaccount_ledger?: { postingaccountLedger?: LedgerRow[] } }>("reportsGetSumsLedger", {
    postingaccount_number: konto,
    date_from: range.from,
    date_to: range.to,
    ...(base ? { base } : {}),
  });
  const rows = res.report_sums_postingaccount_ledger?.postingaccountLedger ?? [];
  return rows.map((r) => {
    const amount = Number(r.record_amount);
    const counter = Number(r.counterRecordPostingaccountNumber);
    return {
      konto,
      id: Number(r.id_by_customer),
      datum: String(r.date ?? "").slice(0, 10),
      text: String(r.postingTextFull ?? ""),
      betrag: r2((r.record_side === side ? 1 : -1) * (Number.isFinite(amount) ? amount : 0)),
      gegenkonto: Number.isFinite(counter) && counter !== 0 ? counter : null,
      beleg: Boolean(r.receipts_id_by_customer) || Boolean(r.receiptsAssignedFilenamesServerPlain),
    };
  });
}

// Kapitalrentabilität wie im Dashboard (Kachel "Kapitalrentabilität"), Stand 30.10.2026 gegen ein Livekonto (EÜR, SKR03)
// für Q2 und Q3 auf den Cent nachgerechnet. Eigen- und Fremdkapital kommen aus der Summen- und Saldenliste vom 1.1. des
// Jahres bis zum Stichtag (Stichtage siehe capitalAt), der Durchschnitt ist das Mittel aus Anfang und Ende.
//   Eigenkapital = Ergebnis seit Jahresbeginn (Klassen Einnahmen, Betriebsausgabe, Abschreibungen) - Saldo Privat (Soll positiv)
//   Fremdkapital = Saldo von Umsatzsteuer, Vorsteuer und Verbindlichkeiten, Haben positiv. Darlehen der Klasse Finanzkonto
//                  zählen nicht (die stecken im Cash-Bestand).
//   Eigenkapitalrentabilität = Ergebnis / Ø Eigenkapital, Fremdkapitalrentabilität = Zinsaufwand / Ø Fremdkapital,
//   Gesamtkapitalrentabilität = (Ergebnis + Zinsaufwand) / (Ø Eigenkapital + Ø Fremdkapital), je in Prozent.
// Bei negativem Eigenkapital kehrt sich das Vorzeichen um (Gewinn auf negatives Kapital ergibt eine negative Rendite).
interface SumsEntry {
  postingaccount?: { class?: string };
  balanceAfterAbsolute?: number;
  balanceAfterSide?: string;
}
export interface Sums {
  sums?: Record<string, SumsEntry>;
  integrityError?: boolean;
}
// Bilanzierer (Klasse Kapital, Rückstellungen, Debitoren/Kreditoren) am 30.10.2026 gegen ein zweites Livekonto (UG, SKR03)
// für Q3 gegen Q2 nachgerechnet: die Klasse Kapital zählt wie Privat gegen das Eigenkapital, Rückstellungen zählen zum
// Fremdkapital, und BHB nimmt die SuSa nach Leistungsdatum (base date_delivery_else_date). Bei EÜR ohne Personenkonten
// ändert beides nichts.
const RESULT_CLASSES = new Set(["Einnahmen", "Betriebsausgabe", "Abschreibungen"]);
const EQUITY_CLASSES = new Set(["Privat", "Kapital"]);
const DEBT_CLASSES = new Set(["Umsatzsteuer", "Vorsteuer", "Verbindlichkeiten", "Rückstellung"]);
const signedBalance = (e: SumsEntry) => (e.balanceAfterSide === "credit" ? -1 : 1) * (e.balanceAfterAbsolute ?? 0);

export interface KapitalTeile {
  ergebnis: number;
  privat: number;
  fremdkapital: number;
}

export function capitalFromSums(report: Sums): KapitalTeile {
  let ergebnis = 0;
  let privat = 0;
  let fremd = 0;
  for (const e of Object.values(report.sums ?? {})) {
    const cls = e.postingaccount?.class ?? "";
    if (RESULT_CLASSES.has(cls)) ergebnis -= signedBalance(e);
    else if (EQUITY_CLASSES.has(cls)) privat += signedBalance(e);
    else if (DEBT_CLASSES.has(cls)) fremd -= signedBalance(e);
  }
  return { ergebnis: r2(ergebnis), privat: r2(privat), fremdkapital: r2(fremd) };
}

// Stichtage wie BHB (am Livekonto für den 1.4. und den 1.7. nachgerechnet): Am Ende zählt alles bis einschließlich des
// letzten Tags. Am Anfang nimmt BHB das Ergebnis bis einschließlich des ersten Tags, Privat und Fremdkapital aber nur bis
// zum Vortag. `vortag` ist null, wenn der erste Tag der 1.1. ist: dann sind Privat und Fremdkapital 0 (für Januar und Q1
// gegen BHB nachgerechnet).
export function capitalAt(anfang: { tag: KapitalTeile; vortag: KapitalTeile | null }, ende: KapitalTeile): { ek: Kapital; fk: Kapital } {
  const v = anfang.vortag ?? { ergebnis: 0, privat: 0, fremdkapital: 0 };
  return {
    ek: kapital(r2(anfang.tag.ergebnis - v.privat), r2(ende.ergebnis - ende.privat)),
    fk: kapital(v.fremdkapital, ende.fremdkapital),
  };
}

export interface Kapital {
  anfang: number;
  ende: number;
  durchschnitt: number;
}
const kapital = (anfang: number, ende: number): Kapital => ({ anfang, ende, durchschnitt: r2((anfang + ende) / 2) });
// Ungerundet, damit die Differenz in Prozentpunkten wie im Dashboard aus den genauen Werten entsteht.
const ratio = (num: number, den: number): number | null => (den === 0 ? null : (num / den) * 100);
const roundOrNull = (n: number | null) => (n === null ? null : r2(n));
const diffOrNull = (a: number | null, b: number | null) => (a === null || b === null ? null : r2(a - b));

export function kapitalSkala(groesster: number): { min: number; max: number } {
  const max = groesster <= 100 ? 100 : r2(1.5 * groesster);
  return { min: -max, max };
}

export function returnOnCapital(ergebnis: number, zins: number, ek: Kapital, fk: Kapital) {
  // Mit dem ungerundeten Mittel wie BHB; der gerundete Durchschnitt ist nur für die Anzeige.
  const ekMittel = (ek.anfang + ek.ende) / 2;
  const fkMittel = (fk.anfang + fk.ende) / 2;
  return {
    eigenkapital: ratio(ergebnis, ekMittel),
    fremdkapital: ratio(zins, fkMittel),
    gesamtkapital: ratio(ergebnis + zins, ekMittel + fkMittel),
  };
}

// Kurze Erklärungen je Kennzahl in eigenen Worten (für Fragen des Nutzers und die Info-Symbole im Artefakt). Sie
// beschreiben, was hier tatsächlich gerechnet wird, auch wo BHBs eigener Infotext davon abweicht.
const ERKLAERUNGEN = {
  ertraege: "Alles, was im Zeitraum hereinkam: die Gesamtleistung (Umsatz und sonstige betriebliche Erträge) plus neutrale Erträge wie Zinserträge. Neutral heißt: nicht aus dem laufenden Geschäft.",
  kosten: "Alle Aufwände des Zeitraums: die Gesamtkosten der BWA (Betriebswirtschaftliche Auswertung), der Wareneinsatz und neutraler Aufwand wie Zinsen.",
  gesamtergebnis: "Erträge minus Kosten, also der Gewinn oder Verlust des Zeitraums laut Buchhaltung, vor Steuern vom Einkommen.",
  ebit: "EBIT steht für Earnings Before Interest and Taxes, auf Deutsch das Betriebsergebnis vor Zinsen und Steuern vom Einkommen. Es zeigt, ob das Kerngeschäft Geld verdient. Die EBIT-Marge ist das EBIT geteilt durch die Gesamtleistung.",
  ebitda: "EBITDA steht für Earnings Before Interest, Taxes, Depreciation and Amortisation, also das Ergebnis vor Zinsen, Steuern und Abschreibungen: EBIT plus Abschreibungen. Es zeigt die operative Leistung ohne die Wertminderung von Anlagen. Die EBITDA-Marge ist das EBITDA geteilt durch die Gesamtleistung.",
  umsatzrentabilitaet: "EBIT geteilt durch die Umsatzerlöse: wie viel Cent von jedem Euro Umsatz als Betriebsergebnis übrig bleiben.",
  rule_of_bhb: "Eine Faustzahl von BuchhaltungsButler: das Umsatzwachstum gegenüber dem Vergleichszeitraum in Prozent plus die Umsatzrentabilität. Sie zeigt Wachstum und Ertragskraft in einer Zahl, höher ist besser. BuchhaltungsButlers eigener Text nennt die EBIT-Marge, gerechnet wird aber mit der Umsatzrentabilität.",
  kostenarten: "Die Kosten nach Kostenart der BWA mit ihrem Anteil an allen Kosten und der Veränderung gegenüber dem Vergleichszeitraum. 'Sonstige Kosten' sammelt, was keiner eigenen Kostenart zugeordnet ist.",
  cogs: "COGS steht für Cost of Goods Sold, auf Deutsch Wareneinsatz: die direkt produktbezogenen Kosten, ohne Personal. Im Konnektor sind das der Wareneinsatz und die Kosten der Warenabgabe. Die COGS-Marge ist COGS geteilt durch die Gesamtleistung.",
  personalkosten: "Alle Aufwendungen für die Entlohnung der Mitarbeiter: Löhne, Gehälter, Sozialabgaben und Nebenkosten. Die Personalaufwandsquote ist Personalkosten geteilt durch die Gesamtleistung, ein Maß für den Personaleinsatz im Verhältnis zur Leistung.",
  eigenkapitalrentabilitaet: "Ergebnis des Zeitraums geteilt durch das durchschnittliche Eigenkapital (Ergebnis seit Jahresbeginn minus Privatentnahmen plus Privateinlagen, bei Kapitalgesellschaften zuzüglich gezeichnetem Kapital und Gewinn- oder Verlustvortrag). Bei negativem Eigenkapital kehrt sich das Vorzeichen um und der Wert ist kaum lesbar.",
  fremdkapitalrentabilitaet: "Zinsaufwand geteilt durch das durchschnittliche Fremdkapital (Steuerschulden, Verbindlichkeiten und Rückstellungen): was das geliehene Geld kostet. Darlehen, die als Finanzkonto geführt werden, zählen hier nicht mit.",
  gesamtkapitalrentabilitaet: "Ergebnis plus Zinsaufwand geteilt durch Eigen- plus Fremdkapital: die Verzinsung des gesamten eingesetzten Kapitals, egal ob eigenes oder geliehenes.",
  kapitalrentabilitaet: "Wie gut sich das eingesetzte Kapital verzinst. Es gibt drei Kennzahlen: Eigenkapital-, Fremdkapital- und Gesamtkapitalrentabilität. Der Strich im Balken zeigt den Wert des Zeitraums, links rot, rechts grün. Die Balken reichen symmetrisch um null, mindestens bis ±100 %.",
  uebersicht: "Erträge, Kosten und Gesamtergebnis je Monat über sechs Monate bis zum Ende des Zeitraums. Neutrale Erträge und Aufwände wie Zinsen sind eingerechnet.",
  umsatzkennzahlen: "Die Umsatzerlöse sind alle Einnahmen aus dem Verkauf von Waren oder Leistungen des Kerngeschäfts. Die Umsatzrentabilität setzt das Betriebsergebnis ins Verhältnis dazu.",
  kosten_fokus: "Zwei Kostenblöcke im Detail: COGS (Wareneinsatz) und Personalkosten, je Monat des Jahres gegen dieselben Monate des Vorjahres.",
};

export type ControllingOptions = RunnerOptions;

export function createControllingTools(client: BBClient, opts: ControllingOptions = {}): [ToolDef] {
  const runReport = createReportRunner(client, opts);
  const fetchBwa = (range: Range) => runReport<Bwa>("bwa", range);

  const getControlling = defineTool({
    name: "get_controlling",
    description:
      "Controlling-Auswertung wie das Dashboard 'Controlling > Profitabilität' von BuchhaltungsButler (Beta, in der Oberfläche nur bis 20.11.2026; " +
      "die API hat dafür keinen Endpunkt, das Tool braucht nur BWA und Summen- und Saldenliste), gerechnet aus der BWA: Erträge, Kosten, Gesamtergebnis, EBIT und EBITDA mit Marge, " +
      "Umsatzrentabilität, Kosten nach Kostenart mit Anteil und Veränderung, COGS, Personalaufwandsquote, 'Rule of BHB' und eine " +
      "Zeitreihe über sechs Monate - Zeitraum gegen Vergleichszeitraum. Fragt der Nutzer nach Controlling, Kennzahlen, EBITDA, " +
      "Profitabilität oder Kostenstruktur, dieses Tool aufrufen und das Ergebnis als Artefakt darstellen (Skill dataviz laden): " +
      "Kennzahlen-Kacheln mit Differenz zum Vergleich, Linien für Erträge/Kosten/Ergebnis, Balken für Kostenarten. " +
      "Es erzeugt nacheinander BWA-Reports (2, mit series bis 8; je einige Sekunden) und ERSETZT damit die zuletzt in BHB " +
      "erzeugte BWA. Dazu die Kapitalrentabilität (Eigen-, Fremd-, Gesamtkapital, wie BHB aus bis zu sechs Summen- und Saldenlisten; " +
      "ersetzt die zuletzt in BHB erzeugte SuSa; capital: false spart sie) und mit year_comparison COGS und Personalkosten gegen " +
      "das Vorjahr. erklaerungen enthält je Kennzahl eine kurze Erklärung für Rückfragen und Info-Symbole. Nur bestätigte Buchungen " +
      "zählen; die Antwort warnt bei unbestätigten. Für ein Controlling-Artefakt gilt ein Standardumfang mit allen Reitern " +
      "(get_booking_guide controlling_artefakt). period_*/comparison_* als YYYY-MM-DD.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      period_from: z.string().describe("YYYY-MM-DD, erster Tag des Zeitraums."),
      period_to: z.string().describe("YYYY-MM-DD, letzter Tag des Zeitraums."),
      comparison_from: z.string().optional().describe("YYYY-MM-DD. Ohne Angabe: der Zeitraum direkt davor, gleich lang."),
      comparison_to: z.string().optional().describe("YYYY-MM-DD, nur zusammen mit comparison_from."),
      series: z.boolean().optional().describe("Zeitreihe über sechs Monate bis zum Ende des Zeitraums (Standard true). false spart sechs Reports."),
      with_postings: z.boolean().optional().describe("Je Konto die Buchungen des Zeitraums (Kontenblatt) mitliefern, Standard true. false spart einen Aufruf je Konto."),
      split_threshold_pct: z.number().min(0).max(100).optional().describe("Konten in 'Sonstige Kosten' ab diesem Anteil an den Kosten werden eine eigene Kostenart. Standard 0 = aus: die Kostenarten bleiben die der BWA, 'Sonstige Kosten' steht am Ende."),
      capital: z.boolean().optional().describe("Kapitalrentabilität (Eigen-, Fremd-, Gesamtkapital) mitrechnen, Standard true. Braucht bis zu sechs Summen- und Saldenlisten (Anfang, Vortag und Ende von Zeitraum und Vergleich); false spart sie."),
      year_comparison: z.boolean().optional().describe("COGS und Personalkosten der sechs Monate der Zeitreihe gegen dieselben Monate des Vorjahres (Dashboard: 'Jahresvergleich'), Standard false. Holt sechs weitere BWAs; nur zusammen mit series."),
      save_as: z.string().optional().describe("Dateiname (ohne Pfad): das volle Ergebnis wird als JSON unter ~/.mcp-buchhaltungsbutler/exports/ gespeichert und nur eine Kurzfassung zurückgegeben. Für Artefakte und große Auswertungen."),
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

      const vorjahr: Kpis[] = [];
      if (args.year_comparison === true) {
        for (const m of months) vorjahr.push(kpisFromBwa(await get({ from: minusOneYear(m.from), to: monthEnd(Number(m.from.slice(0, 4)) - 1, Number(m.from.slice(5, 7)) - 1) })));
      }

      const k = kpisFromBwa(cur);
      const p = kpisFromBwa(prev);

      // Kapital zu den Stichtagen: je eine SuSa vom 1.1. des Jahres bis einschließlich Stichtag, nacheinander.
      let kapitalrentabilitaet: Record<string, unknown> | null = null;
      if (args.capital !== false) {
        const susa = new Map<string, KapitalTeile>();
        const at = async (date: string) => {
          if (!susa.has(date)) susa.set(date, capitalFromSums(await runReport<Sums>("sums", { from: `${date.slice(0, 4)}-01-01`, to: date }, "date_delivery_else_date")));
          return susa.get(date)!;
        };
        const sides = async (r: Range) => {
          const tag = await at(r.from);
          const vortag = r.from.slice(5) === "01-01" ? null : await at(dayBefore(r.from));
          return capitalAt({ tag, vortag }, await at(r.to));
        };
        const kz = await sides(period);
        const kv = await sides(comparison);
        const rz = returnOnCapital(k.gesamtergebnis, k.zinsaufwand, kz.ek, kz.fk);
        const rv = returnOnCapital(p.gesamtergebnis, p.zinsaufwand, kv.ek, kv.fk);
        const groesster = Math.max(...[rz.eigenkapital, rz.fremdkapital, rz.gesamtkapital].map((x) => Math.abs(x ?? 0)));
        kapitalrentabilitaet = {
          zeitraum: { eigenkapital: kz.ek, fremdkapital: kz.fk },
          vergleichszeitraum: { eigenkapital: kv.ek, fremdkapital: kv.fk },
          eigenkapitalrentabilitaet_pct: roundOrNull(rz.eigenkapital),
          fremdkapitalrentabilitaet_pct: roundOrNull(rz.fremdkapital),
          gesamtkapitalrentabilitaet_pct: roundOrNull(rz.gesamtkapital),
          vergleich: {
            eigenkapitalrentabilitaet_pct: roundOrNull(rv.eigenkapital),
            fremdkapitalrentabilitaet_pct: roundOrNull(rv.fremdkapital),
            gesamtkapitalrentabilitaet_pct: roundOrNull(rv.gesamtkapital),
          },
          differenz_pp: {
            eigenkapitalrentabilitaet: diffOrNull(rz.eigenkapital, rv.eigenkapital),
            fremdkapitalrentabilitaet: diffOrNull(rz.fremdkapital, rv.fremdkapital),
            gesamtkapitalrentabilitaet: diffOrNull(rz.gesamtkapital, rv.gesamtkapital),
          },
          // Skala der Balken-Tachos im Dashboard: symmetrisch um 0; bis 100 % fest ±100, darüber das 1,5-fache des größten
          // Betrags im Zeitraum (gegen BHB in elf Zeiträumen geprüft).
          skala: kapitalSkala(groesster),
        };
      }

      const promote = promotedAccounts(k, args.split_threshold_pct ?? 0);
      const kostenarten = mergeArten(promoteAccounts(k, promote).kostenarten, promoteAccounts(p, promote).kostenarten, k.kosten);
      const ertragsarten = mergeArten(k.ertragsarten, p.ertragsarten, k.ertraege);

      // Kontenblatt je Konto: die Summe der Zeilen eines Kontos ist genau der Betrag der BWA (Livekonto geprüft), bei
      // Bilanzierern nur nach Leistungsdatum wie die BWA (am UG-Livekonto belegt: nach Buchungsdatum fehlten bei zwei Konten Beträge).
      // Beträge zur normalen Seite des Kontos: Aufwand im Soll, Ertrag im Haben, die Gegenbuchung (Storno) ist negativ.
      const buchungen: Buchung[] = [];
      if (args.with_postings !== false) {
        const sides = accountSides(cur);
        const todo = [...sides.entries()].filter(([nr]) => [...k.kostenarten, ...k.ertragsarten].some((l) => l.konten.some((a) => a.nummer === nr)));
        let next = 0;
        const worker = async () => {
          while (next < todo.length) {
            const [nr, side] = todo[next++];
            buchungen.push(...(await fetchLedger(client, nr, side, period, "date_delivery_else_date")));
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
        buchungen.sort((a, b) => a.konto - b.konto || a.datum.localeCompare(b.datum) || a.id - b.id);
      }

      const umsatzwachstum = change(k.umsatzerloese, p.umsatzerloese);
      const warnings: string[] = [];
      for (const [label, bwa] of [["Zeitraum", cur], ["Vergleichszeitraum", prev]] as const) {
        if (bwa.integrityError) warnings.push(`BHB meldet für den ${label} einen Integritätsfehler in der BWA; Zahlen nicht verwenden, bis er geklärt ist.`);
        if ((bwa.uncompletedPostingsCount ?? 0) > 0) {
          warnings.push(`${label}: ${bwa.uncompletedPostingsCount} unvollständige Buchungen (uncompletedPostingsCount) sind in der BWA nicht enthalten.`);
        }
      }
      if (k.gesamtleistung === 0) warnings.push("Gesamtleistung im Zeitraum ist 0: Margen und Quoten sind nicht berechenbar (null).");

      return finishWithExport(args.save_as, {
        period,
        comparison,
        kpis: {
          zeitraum: k,
          vergleichszeitraum: p,
          differenz: {
            ebit: r2(k.ebit - p.ebit),
            ebitda: r2(k.ebitda - p.ebitda),
            // Aus den ungerundeten Verhältnissen: die Differenz der gerundeten Prozentwerte weicht sonst um 0,01 vom Dashboard ab.
            ebit_marge_pp: ppDiff(k.ebit, k.gesamtleistung, p.ebit, p.gesamtleistung),
            ebitda_marge_pp: ppDiff(k.ebitda, k.gesamtleistung, p.ebitda, p.gesamtleistung),
            umsatzrentabilitaet_pp: ppDiff(k.ebit, k.umsatzerloese, p.ebit, p.umsatzerloese),
            cogs_marge_pp: ppDiff(k.cogs, k.gesamtleistung, p.cogs, p.gesamtleistung),
            personalaufwandsquote_pp: ppDiff(k.personalkosten, k.gesamtleistung, p.personalkosten, p.gesamtleistung),
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
        ertragsarten,
        buchungen,
        zeitreihe: {
          monate: months.map(monthLabel),
          ertraege: monthly.map((m) => m.ertraege),
          kosten: monthly.map((m) => m.kosten),
          gesamtergebnis: monthly.map((m) => m.gesamtergebnis),
          umsatzerloese: monthly.map((m) => m.umsatzerloese),
          cogs: monthly.map((m) => m.cogs),
          personalkosten: monthly.map((m) => m.personalkosten),
          cogs_vorjahr: vorjahr.map((m) => m.cogs),
          personalkosten_vorjahr: vorjahr.map((m) => m.personalkosten),
        },
        kapitalrentabilitaet,
        erklaerungen: ERKLAERUNGEN,
        hinweise: [
          "Quelle ist die BWA (nur bestätigte Buchungen). EBIT = Betriebsergebnis, EBITDA = EBIT + Abschreibungen, Margen auf die Gesamtleistung, Umsatzrentabilität auf die Umsatzerlöse.",
          "Kosten (Gesamtkosten im Dashboard) = Gesamtkosten + Wareneinsatz + neutraler Aufwand (z. B. Zinsaufwand); Erträge = Gesamtleistung + neutraler Ertrag. Gegen ein Livekonto ohne Wareneinsatz und ohne sonstigen neutralen Aufwand nachgerechnet; mit Wareneinsatz nicht belegt.",
          "COGS = Kosten Warenabgabe + Wareneinsatz (BHB: produktbezogene Kosten ohne Personal); rule_of_bhb ist eine Ableitung, keine dokumentierte Formel.",
          "Kapitalrentabilität: Eigenkapital = Ergebnis seit Jahresbeginn - Saldo Privat, Fremdkapital = Umsatzsteuer - Vorsteuer + Verbindlichkeiten (Haben positiv). Ende des Zeitraums: alles bis einschließlich letztem Tag. Anfang: Ergebnis bis einschließlich erstem Tag, Privat und Fremdkapital bis zum Vortag (so rechnet BHB). Durchschnitt aus Anfang und Ende. Gegen BHB auf den Cent belegt (EÜR-Konto, Q2 gegen Q3, Q1 gegen Q3 und alle Monate Januar bis Oktober gegen den Vormonat). Bei Bilanzierern zählt die Klasse Kapital wie Privat gegen das Eigenkapital und Rückstellungen zählen zum Fremdkapital; die SuSa läuft nach Leistungsdatum (UG-Konto, Ende Q2 und Q3 belegt). Darlehen der Klasse Finanzkonto zählen nicht zum Fremdkapital.",
          "Rule of BHB = Umsatzwachstum in Prozent + Umsatzrentabilität (EBIT / Umsatzerlöse). BHBs Infotext nennt die EBIT-Marge, gerechnet wird aber mit der Umsatzrentabilität (nur so ergibt sich der angezeigte Wert).",
        ],
        warnings,
      });
    },
  });

  return [getControlling];
}
