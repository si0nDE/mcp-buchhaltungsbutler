import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { createReportRunner, type Range, type RunnerOptions } from "./report-runner.js";
import { dayBefore, monthLabel, previousRange, seriesMonths, utc } from "./controlling.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, type ToolDef } from "./types.js";
import { finishWithExport } from "./export-file.js";

// Nachbau des Dashboards "Controlling (Beta) > Stabilität" der BHB-Oberfläche. Stand 31.10.2026 gegen ein Livekonto
// (UG, SKR03, Bilanzierer mit Debitoren/Kreditoren) für Q3, Q2, September, Juni und das Jahr auf den Cent nachgerechnet.
// Alle Zahlen kommen aus der Summen- und Saldenliste nach Leistungsdatum (base date_delivery_else_date) vom 1.1. bis zum
// Stichtag; Bestände sind Salden je Konto (Soll positiv):
//   Kassenbestand/Bank       = Soll-Salden der Klasse Finanzkonto
//   Forderungen aus L+L      = Saldo der Debitorenkonten (die Personenkonten; das Sammelkonto steckt in der Klasse Forderungen)
//   Sonstige Vermögensgeg.   = Soll-Salden der Klassen Forderungen (ohne die Forderungen aus L+L), Vorsteuer,
//                              Verbindlichkeiten, Interimskonto und Umsatzsteuer
//   Rückstellungen           = Haben-Salden der Klasse Rückstellung
//   Verbindlichkeiten        = Haben-Salden der Klassen Finanzkonto (z. B. Gesellschafterkonten), Interimskonto,
//                              Verbindlichkeiten (Sammelkonto der Kreditoren) und Umsatzsteuer
//   Eigenkapital             = -(Saldo Kapital + Saldo Privat) + Ergebnis des gewählten Zeitraums (nicht seit Jahresbeginn)
//                              Negativ steht es als "nicht gedeckter Fehlbetrag" auf der Aktivseite, die Bilanz geht dann
//                              nicht auf (so zeigt es BHB).
//   Effektivverschuldung     = Fremdkapital - Saldo Finanzkonto - Saldo Forderungen + Saldo Vorsteuer + Saldo Umsatzsteuer
//                              (Klassensalden netto; BHB: Verbindlichkeiten nach Abzug des kurzfristigen Umlaufvermögens)
// Das Periodenergebnis ist die Differenz der Ergebnisse seit Jahresbeginn: die Periodensummen einer SuSa ab Periodenbeginn
// passen nicht dazu (am Livekonto geprüft).

interface SumsEntry {
  postingaccount?: { class?: string };
  balanceAfterAbsolute?: number;
  balanceAfterSide?: string;
}
interface Sums {
  sums?: Record<string, SumsEntry>;
  integrityError?: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const signed = (e: SumsEntry) => (e.balanceAfterSide === "credit" ? -1 : 1) * (e.balanceAfterAbsolute ?? 0);
const RESULT_CLASSES = new Set(["Einnahmen", "Betriebsausgabe", "Abschreibungen"]);
const SONSTIGE_SOLL = ["Forderungen", "Vorsteuer", "Verbindlichkeiten", "Interimskonto", "Umsatzsteuer"];
const VERB_HABEN = ["Finanzkonto", "Interimskonto", "Verbindlichkeiten", "Umsatzsteuer"];

export interface BilanzTeile {
  kasse_bank: number;
  forderungen_lul: number;
  sonstige_vermoegensgegenstaende: number;
  anlagevermoegen: number;
  rueckstellungen: number;
  verbindlichkeiten: number;
  fremdkapital: number;
  // Saldo der Klassen Kapital und Privat (Soll positiv): gezeichnetes Kapital, Vorträge, Entnahmen und Einlagen.
  kapital_saldo: number;
  ergebnis_seit_jahresbeginn: number;
  abschreibungen_seit_jahresbeginn: number;
  effektivverschuldung: number;
  // Gibt es Konten der Klasse Kapital oder Personenkonten? Ohne beides ist es eine EÜR, und eine Bilanz ergibt keinen Sinn.
  bilanzierer: boolean;
}

const BILANZ_KLASSEN = new Set(["Kapital", "Debitorenkonto", "Kreditorenkonto"]);

export function bilanzFromSums(report: Sums): BilanzTeile {
  const netto = new Map<string, number>();
  const soll = new Map<string, number>();
  const haben = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const e of Object.values(report.sums ?? {})) {
    const cls = e.postingaccount?.class ?? "";
    const v = signed(e);
    add(netto, cls, v);
    if (v > 0) add(soll, cls, v);
    else add(haben, cls, -v);
  }
  const n = (c: string) => netto.get(c) ?? 0;
  const s = (c: string) => soll.get(c) ?? 0;
  const h = (c: string) => haben.get(c) ?? 0;
  const forderungenLul = Math.max(0, n("Debitorenkonto"));
  const rueckstellungen = h("Rückstellung");
  const verbindlichkeiten = VERB_HABEN.reduce((sum, c) => sum + h(c), 0);
  const fremdkapital = verbindlichkeiten + rueckstellungen;
  return {
    kasse_bank: r2(s("Finanzkonto")),
    forderungen_lul: r2(forderungenLul),
    sonstige_vermoegensgegenstaende: r2(SONSTIGE_SOLL.reduce((sum, c) => sum + s(c), 0) - forderungenLul),
    anlagevermoegen: r2(n("Anlagevermögen")),
    rueckstellungen: r2(rueckstellungen),
    verbindlichkeiten: r2(verbindlichkeiten),
    fremdkapital: r2(fremdkapital),
    kapital_saldo: r2(n("Kapital") + n("Privat")),
    ergebnis_seit_jahresbeginn: r2(-[...RESULT_CLASSES].reduce((sum, c) => sum + n(c), 0)),
    abschreibungen_seit_jahresbeginn: r2(n("Abschreibungen")),
    effektivverschuldung: r2(fremdkapital - n("Finanzkonto") - n("Forderungen") + n("Vorsteuer") + n("Umsatzsteuer")),
    bilanzierer: [...netto.keys()].some((c) => BILANZ_KLASSEN.has(c)),
  };
}

export interface Stabilitaet {
  stichtag: string;
  ergebnis_zeitraum: number;
  aktiva: { anlagevermoegen: number; umlaufvermoegen: number; nicht_gedeckter_fehlbetrag: number; summe: number };
  passiva: { eigenkapital: number; rueckstellungen: number; verbindlichkeiten: number; summe: number };
  positionen: { kasse_bank: number; forderungen_lul: number; sonstige_vermoegensgegenstaende: number };
  // Ungekürzt, auch negativ; das Dashboard zeigt höchstens 0 (dann steht der Rest als Fehlbetrag in den Aktiva).
  eigenkapital_rechnerisch: number;
  fremdkapital: number;
  effektivverschuldung: number;
  verschuldungsgrad_pct: number;
  abschreibungsaufwand: number;
  goldene_bilanzregel: boolean;
  silberne_bilanzregel: boolean;
}

export function stabilityFrom(stichtag: string, b: BilanzTeile, ergebnisZeitraum: number, abschreibungenZeitraum: number): Stabilitaet {
  const ek = r2(-b.kapital_saldo + ergebnisZeitraum);
  const fehlbetrag = Math.max(0, -ek);
  const ekAnzeige = Math.max(0, ek);
  const umlauf = r2(b.kasse_bank + b.forderungen_lul + b.sonstige_vermoegensgegenstaende);
  return {
    stichtag,
    ergebnis_zeitraum: r2(ergebnisZeitraum),
    aktiva: { anlagevermoegen: b.anlagevermoegen, umlaufvermoegen: umlauf, nicht_gedeckter_fehlbetrag: fehlbetrag, summe: r2(b.anlagevermoegen + umlauf + fehlbetrag) },
    passiva: { eigenkapital: ekAnzeige, rueckstellungen: b.rueckstellungen, verbindlichkeiten: b.verbindlichkeiten, summe: r2(ekAnzeige + b.fremdkapital) },
    positionen: { kasse_bank: b.kasse_bank, forderungen_lul: b.forderungen_lul, sonstige_vermoegensgegenstaende: b.sonstige_vermoegensgegenstaende },
    eigenkapital_rechnerisch: ek,
    fremdkapital: b.fremdkapital,
    effektivverschuldung: b.effektivverschuldung,
    // Ohne positives Eigenkapital zeigt BHB 0 %.
    verschuldungsgrad_pct: ek > 0 ? r2((b.fremdkapital / ek) * 100) : 0,
    abschreibungsaufwand: r2(abschreibungenZeitraum),
    // Nicht belegt: am Livekonto (kein Anlagevermögen, negatives Eigenkapital) waren beide Regeln nicht erfüllt. Langfristiges
    // Fremdkapital lässt sich aus den Klassen nicht abgrenzen; die silberne Regel nimmt hier nur das Eigenkapital.
    goldene_bilanzregel: ek > 0 && ek >= b.anlagevermoegen,
    silberne_bilanzregel: ek > 0 && ek >= b.anlagevermoegen,
  };
}

// Veränderung in Prozent wie im Dashboard: 0 gegen 0 ist 0 %, sonst ohne Vergleichswert keine Zahl.
const change = (cur: number, prev: number): number | null => (prev === 0 ? (cur === 0 ? 0 : null) : r2(((cur - prev) / Math.abs(prev)) * 100));

export function topPositionen(s: Stabilitaet, anzahl = 5): { name: string; betrag: number }[] {
  return [
    { name: "Nicht gedeckter Fehlbetrag", betrag: s.aktiva.nicht_gedeckter_fehlbetrag },
    { name: "Anlagevermögen", betrag: s.aktiva.anlagevermoegen },
    { name: "Sonstige Vermögensgegenstände", betrag: s.positionen.sonstige_vermoegensgegenstaende },
    { name: "Kassenbestand, Guthaben bei Kreditinstituten", betrag: s.positionen.kasse_bank },
    { name: "Forderungen aus Lieferungen und Leistungen", betrag: s.positionen.forderungen_lul },
  ]
    .filter((p) => p.betrag > 0)
    .sort((a, b) => b.betrag - a.betrag)
    .slice(0, anzahl);
}

// Kurze Erklärungen in eigenen Worten (für Rückfragen und die Info-Symbole im Artefakt).
const ERKLAERUNGEN = {
  bilanzstruktur: "Aktiva (womit das Unternehmen arbeitet: Anlagen, Bankguthaben, Forderungen) und Passiva (woher das Geld stammt: Eigenkapital, Rückstellungen, Verbindlichkeiten) zum Ende des Zeitraums. Ist das Eigenkapital aufgebraucht, steht der fehlende Betrag als 'nicht gedeckter Fehlbetrag' auf der Aktivseite.",
  nicht_gedeckter_fehlbetrag: "Der Betrag, um den Verluste und Entnahmen das eingezahlte Kapital übersteigen. Er ist kein Vermögen, sondern zeigt eine Überschuldung in der Buchhaltung. BuchhaltungsButler rechnet ihn mit dem Ergebnis des gewählten Zeitraums, nicht seit Jahresbeginn; deshalb ändert er sich mit dem Zeitraum.",
  vermoegensanalyse: "Die fünf größten Posten der Aktivseite und die Entwicklung von Anlage- und Umlaufvermögen gegenüber dem Vergleichszeitraum. Anlagevermögen bleibt langfristig im Betrieb (Fahrzeuge, Software, Ausstattung), Umlaufvermögen wechselt schnell (Bank, Forderungen, Steuerguthaben).",
  anlagenkennzahlen: "Anzahl der aktiven Anlagen, Abschreibungsaufwand des Zeitraums und Anlagenabnutzungsgrad: zu wie viel Prozent die Anlagen schon abgeschrieben sind. Anzahl und Abnutzungsgrad kommen aus der Anlagenverwaltung, für die BuchhaltungsButler keine Schnittstelle hat; der Konnektor liefert nur den Abschreibungsaufwand.",
  kapitalstruktur: "Eigen- und Fremdkapital zum Ende jedes der letzten zwölf Monate. Viel Fremdkapital heißt: das Unternehmen arbeitet mit geliehenem Geld und ist von Gläubigern abhängiger.",
  effektivverschuldung: "Die Schulden nach Abzug dessen, was kurzfristig zu Geld wird (Bank, Forderungen, Steuersaldo). Sie zeigt, wie viel Schuld übrig bliebe, wenn man alles Verfügbare zur Tilgung nähme. Konten, die in BuchhaltungsButler als Finanzkonto geführt werden, aber Schulden sind (z. B. Gesellschafterdarlehen), erhöhen sie.",
  verschuldungsgrad: "Fremdkapital geteilt durch Eigenkapital in Prozent. 100 % heißt: gleich viel geliehenes wie eigenes Geld. Ohne positives Eigenkapital zeigt BuchhaltungsButler 0 %. Was als gesund gilt, hängt von der Branche ab.",
  bilanzregeln: "Faustregeln zur Finanzierung: Die goldene Bilanzregel ist erfüllt, wenn das Anlagevermögen ganz durch Eigenkapital gedeckt ist, die silberne, wenn Eigenkapital und langfristige Schulden zusammen reichen. Langfristig gebundenes Vermögen soll nicht mit kurzfristigem Geld bezahlt werden.",
};

export type StabilityOptions = RunnerOptions;

export function createStabilityTools(client: BBClient, opts: StabilityOptions = {}): [ToolDef] {
  const runReport = createReportRunner(client, opts);

  const getStability = defineTool({
    name: "get_stability",
    description:
      "Stabilitäts-Auswertung wie das Dashboard 'Controlling > Stabilität' von BuchhaltungsButler (Beta, in der Oberfläche nur bis 20.11.2026; " +
      "die API hat dafür keinen Endpunkt): Bilanzstruktur (Aktiva/Passiva mit nicht gedecktem Fehlbetrag), Vermögensanalyse (Top-5-Posten, " +
      "Anlage- und Umlaufvermögen mit Veränderung), Abschreibungsaufwand, Kapitalstruktur (Eigen- und Fremdkapital über zwölf Monate), " +
      "Effektivverschuldung, Verschuldungsgrad und Bilanzregeln - Zeitraum gegen Vergleichszeitraum. Nur für Bilanzierer (GmbH, UG, bilanzierende Kaufleute); bei EÜR bricht es mit Hinweis ab. " +
      "Fragt der Nutzer nach Stabilität, Bilanz, Verschuldung, Eigenkapital oder Kapitalstruktur, dieses Tool aufrufen und das Ergebnis " +
      "als Artefakt darstellen (Skill dataviz laden). Es erzeugt nacheinander Summen- und Saldenlisten nach Leistungsdatum (bis zu vier, " +
      "mit history bis zu 16; je einige Sekunden) und ERSETZT damit die zuletzt in BHB erzeugte SuSa. erklaerungen enthält je Kennzahl " +
      "eine kurze Erklärung. Nur bestätigte Buchungen zählen. Teil des Standard-Controlling-Artefakts (get_booking_guide controlling_artefakt). period_*/comparison_* als YYYY-MM-DD.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      period_from: z.string().describe("YYYY-MM-DD, erster Tag des Zeitraums."),
      period_to: z.string().describe("YYYY-MM-DD, letzter Tag des Zeitraums (Stichtag der Bilanz)."),
      comparison_from: z.string().optional().describe("YYYY-MM-DD. Ohne Angabe: der Zeitraum direkt davor, gleich lang."),
      comparison_to: z.string().optional().describe("YYYY-MM-DD, nur zusammen mit comparison_from."),
      history: z.boolean().optional().describe("Eigen- und Fremdkapital zum Ende der letzten zwölf Monate (Kapitalstrukturanalyse), Standard true. false spart bis zu zwölf SuSas."),
      save_as: z.string().optional().describe("Dateiname (ohne Pfad): das volle Ergebnis wird als JSON unter ~/.mcp-buchhaltungsbutler/exports/ gespeichert und nur eine Kurzfassung zurückgegeben."),
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

      // Je Stichtag eine SuSa vom 1.1. bis einschließlich Stichtag, nacheinander (BHB rechnet nur eine gleichzeitig).
      const warnings: string[] = [];
      const susa = new Map<string, BilanzTeile>();
      const at = async (date: string) => {
        if (!susa.has(date)) {
          const report = await runReport<Sums>("sums", { from: `${date.slice(0, 4)}-01-01`, to: date }, "date_delivery_else_date");
          if (report.integrityError) warnings.push(`BHB meldet für die SuSa bis ${date} einen Integritätsfehler; Zahlen nicht verwenden, bis er geklärt ist.`);
          susa.set(date, bilanzFromSums(report));
        }
        return susa.get(date)!;
      };
      // Zuerst der Stichtag: ohne Kapital- und Personenkonten (EÜR) gibt es keine Bilanz, also auch kein Dashboard Stabilität.
      if (!(await at(period.to)).bilanzierer) {
        throw new Error(
          "get_stability braucht eine Bilanz: dieses Konto hat weder Kapitalkonten noch Debitoren-/Kreditorenkonten, rechnet also " +
            "eine Einnahmen-Überschuss-Rechnung (EÜR). Für EÜR gibt es keine Bilanzstruktur, kein Eigenkapital und keinen Fehlbetrag; " +
            "für Liquidität und Profitabilität get_liquidity und get_controlling nutzen."
        );
      }
      // Ergebnis und Abschreibungen eines Zeitraums, auch über den Jahreswechsel: je Kalenderjahr Stand am Ende minus Stand am Vortag.
      const zeitraum = async (r: Range) => {
        let ergebnis = 0;
        let abschreibungen = 0;
        for (let y = Number(r.from.slice(0, 4)); y <= Number(r.to.slice(0, 4)); y++) {
          const start = y === Number(r.from.slice(0, 4)) ? r.from : `${y}-01-01`;
          const ende = await at(y === Number(r.to.slice(0, 4)) ? r.to : `${y}-12-31`);
          const vor = start.slice(5) === "01-01" ? null : await at(dayBefore(start));
          ergebnis += ende.ergebnis_seit_jahresbeginn - (vor?.ergebnis_seit_jahresbeginn ?? 0);
          abschreibungen += ende.abschreibungen_seit_jahresbeginn - (vor?.abschreibungen_seit_jahresbeginn ?? 0);
        }
        return { ergebnis, abschreibungen };
      };
      const auswerten = async (r: Range) => {
        const z = await zeitraum(r);
        return stabilityFrom(r.to, await at(r.to), z.ergebnis, z.abschreibungen);
      };
      const cur = await auswerten(period);
      const prev = await auswerten(comparison);

      const months = args.history === false ? [] : seriesMonths(period.to, 12);
      const verlauf: { ek: number; fk: number }[] = [];
      for (const m of months) {
        const b = await at(m.to);
        // Nicht belegt (am Livekonto war das Eigenkapital in allen Monaten 0): Eigenkapital mit dem Ergebnis seit Jahresbeginn.
        verlauf.push({ ek: Math.max(0, r2(-b.kapital_saldo + b.ergebnis_seit_jahresbeginn)), fk: b.fremdkapital });
      }

      return finishWithExport(args.save_as, {
        period,
        comparison,
        bilanzstruktur: { aktiva: cur.aktiva, passiva: cur.passiva },
        vermoegensanalyse: {
          top_positionen: topPositionen(cur),
          anlagevermoegen: { betrag: cur.aktiva.anlagevermoegen, veraenderung_pct: change(cur.aktiva.anlagevermoegen, prev.aktiva.anlagevermoegen) },
          umlaufvermoegen: { betrag: cur.aktiva.umlaufvermoegen, veraenderung_pct: change(cur.aktiva.umlaufvermoegen, prev.aktiva.umlaufvermoegen) },
        },
        anlagenkennzahlen: { abschreibungsaufwand: cur.abschreibungsaufwand, aktive_anlagegueter: null, anlagenabnutzungsgrad_pct: null },
        kapitalstruktur: {
          eigenkapital: cur.passiva.eigenkapital,
          fremdkapital: cur.fremdkapital,
          monate: months.map(monthLabel),
          eigenkapital_verlauf: verlauf.map((v) => v.ek),
          fremdkapital_verlauf: verlauf.map((v) => v.fk),
        },
        verschuldung: {
          effektivverschuldung: cur.effektivverschuldung,
          effektivverschuldung_veraenderung_pct: change(cur.effektivverschuldung, prev.effektivverschuldung),
          verschuldungsgrad_pct: cur.verschuldungsgrad_pct,
          verschuldungsgrad_differenz_pp: r2(cur.verschuldungsgrad_pct - prev.verschuldungsgrad_pct),
        },
        bilanzregeln: { goldene: cur.goldene_bilanzregel, silberne: cur.silberne_bilanzregel },
        zeitraum: cur,
        vergleichszeitraum: prev,
        erklaerungen: ERKLAERUNGEN,
        hinweise: [
          "Quelle: Summen- und Saldenlisten nach Leistungsdatum vom 1.1. bis zum Stichtag (nur bestätigte Buchungen). Gegen BHB auf den Cent belegt für eine UG mit Debitoren/Kreditoren (Q3, Q2, September, Juni, Gesamtjahr).",
          "Eigenkapital = -(Saldo Kapital + Privat) + Ergebnis des gewählten Zeitraums. BHB nimmt das Periodenergebnis, nicht das seit Jahresbeginn; der Fehlbetrag hängt daher vom Zeitraum ab. Ist das Eigenkapital negativ, zeigt BHB 0 und den Rest als nicht gedeckten Fehlbetrag; die Bilanz geht dann nicht auf.",
          "Effektivverschuldung = Fremdkapital - Saldo Finanzkonto - Saldo Forderungen + Saldo Vorsteuer + Saldo Umsatzsteuer (Klassensalden). Sie hängt nur vom Stichtag ab.",
          "Nicht belegt: Privatkonten (nur Klasse Kapital geprüft), Anlagevermögen (am Livekonto 0), Soll-Salden auf Umsatzsteuerkonten, Bilanzregeln (langfristiges Fremdkapital ist aus den Klassen nicht abgrenzbar) und das Eigenkapital im Zwölfmonatsverlauf.",
          "Aktive Anlagegüter und Anlagenabnutzungsgrad stammen aus der Anlagenverwaltung (ohne API) und fehlen (null).",
        ],
        warnings,
      });
    },
  });

  return [getStability];
}
