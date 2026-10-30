import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { createReportRunner, type RunnerOptions } from "./report-runner.js";
import { openReceiptRows, type OpenReceipt } from "./liquidity.js";
import { seriesMonths } from "./controlling.js";
import { buildPeriods, normalizeRechtsform, type MonthInput } from "./tax-estimate.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";
import { finishWithExport } from "./export-file.js";

// Steuerlage fürs Controlling aus der Summen- und Saldenliste des laufenden Jahres und den offenen Belegen von Steuerbehörden.
// Was sich sauber ablesen lässt, ist die Umsatzsteuer: Salden der Konten Umsatzsteuer, Vorsteuer und Vorauszahlungen. Alle anderen
// Steuern (Gewerbesteuer, Körperschaftsteuer, Solidaritätszuschlag, Kapitalertragsteuer, Lohnsteuer, ...) erscheinen nur so, wie sie
// gebucht sind (Aufwand, Rückstellung, Verbindlichkeit). Eine Schätzung der Ertragsteuern gibt es nicht: sie hängt vom steuerlichen
// Ergebnis, der Rechtsform und dem Hebesatz ab und gehört zum Steuerberater.

const r2 = (n: number) => Math.round(n * 100) / 100;

interface SumsEntry {
  postingaccount?: { class?: string; name?: string; postingaccount_number?: number };
  balanceAfterAbsolute?: number;
  balanceAfterSide?: string;
  sumPeriodDebit?: number | null;
  sumPeriodCredit?: number | null;
}
interface Sums {
  sums?: Record<string, SumsEntry>;
  integrityError?: boolean;
}
const signed = (e: SumsEntry) => (e.balanceAfterSide === "credit" ? -1 : 1) * (e.balanceAfterAbsolute ?? 0);

export type TaxArea = "umsatzsteuer" | "lohnsteuer" | "ertragsteuern" | "sonstige";

// Steuerkonten nach Name und Klasse. Konten der Klasse Umsatzsteuer/Vorsteuer sowie solche mit Umsatz-/Vorsteuer im Namen (z. B.
// "Umsatzsteuer frühere Jahre", das BHB unter Verbindlichkeiten führt) gehören zur Umsatzsteuer.
// Gewinn- und Verlustkonten (Erlöse, Aufwand, Abschreibungen) tragen "Umsatzsteuer" nur im Namen, ohne Steuerkonto zu sein.
const RESULT_CLASSES = new Set(["Einnahmen", "Betriebsausgabe", "Abschreibungen"]);

export function taxArea(cls: string | undefined, name: string): TaxArea | null {
  const isResult = cls !== undefined && RESULT_CLASSES.has(cls);
  if (cls === "Umsatzsteuer" || cls === "Vorsteuer") return "umsatzsteuer";
  if (/umsatzsteuer|vorsteuer|§ ?13b/i.test(name)) return isResult ? null : "umsatzsteuer";
  // "lohnsteuerfrei", "steuerfreie Einnahmen" und ähnliches sind keine Steuerkonten
  const n = name.replace(/steuerfrei\w*/gi, "");
  if (!/steuer|solidarit/i.test(n)) return null;
  if (/lohn|kirchensteuer/i.test(n)) return "lohnsteuer";
  if (/gewerbe|körperschaft|kapitalertrag|solidarit|einkommen|abgeltung/i.test(n)) return "ertragsteuern";
  return "sonstige";
}

export interface TaxLine {
  nummer: number;
  name: string;
  klasse: string;
  bereich: TaxArea;
  saldo: number;
}

// Saldo Soll positiv. Nur Steuerkonten mit Saldo oder Bewegung; Privat- und Anlagenkonten sind keine Steuerlage.
export function taxLines(report: Sums): TaxLine[] {
  const out: TaxLine[] = [];
  for (const [nr, e] of Object.entries(report.sums ?? {})) {
    const name = e.postingaccount?.name ?? "";
    const cls = e.postingaccount?.class;
    if (cls === "Privat" || cls === "Anlagevermögen") continue;
    const area = taxArea(cls, name);
    if (!area) continue;
    const saldo = r2(signed(e));
    if (saldo === 0 && !e.sumPeriodDebit && !e.sumPeriodCredit) continue;
    out.push({ nummer: Number(nr), name, klasse: cls ?? "", bereich: area, saldo });
  }
  return out.sort((a, b) => a.bereich.localeCompare(b.bereich) || a.nummer - b.nummer);
}

// Ergebniskonten: Erträge und Aufwand (BHB-Klassen). Gewinn = Haben minus Soll über diese Konten, Privatkonten zählen nicht.
const RESULT = new Set(["Einnahmen", "Betriebsausgabe", "Abschreibungen"]);
// Zahlungen ans Finanzamt und Altjahre sind keine Umsatzsteuer der Periode.
const NOT_PERIOD_UST = /vorauszahlung|erstattung|frühere jahre/i;

export function monthInput(schluessel: string, report: Sums): MonthInput {
  let ust = 0;
  let vst = 0;
  let gewinn = 0;
  for (const e of Object.values(report.sums ?? {})) {
    const cls = e.postingaccount?.class;
    const name = e.postingaccount?.name ?? "";
    const soll = e.sumPeriodDebit ?? 0;
    const haben = e.sumPeriodCredit ?? 0;
    if (cls === "Umsatzsteuer" && !NOT_PERIOD_UST.test(name)) ust += haben - soll;
    else if (cls === "Vorsteuer") vst += soll - haben;
    else if (cls !== undefined && RESULT.has(cls)) gewinn += haben - soll;
  }
  return { schluessel, ust: r2(ust), vst: r2(vst), gewinn: r2(gewinn) };
}

const AUTHORITY = /finanzamt|finanzkasse|steuerverwaltung|hauptzollamt|gemeindekasse|stadtkasse|steueramt/i;

export function createTaxPositionTools(client: BBClient, opts: RunnerOptions = {}): [ToolDef] {
  const runReport = createReportRunner(client, { pollMs: 4000, ...opts });

  const getTaxPosition = defineTool({
    name: "get_tax_position",
    description:
      "Steuerlage fürs Controlling: Umsatzsteuer-Zahllast des laufenden Jahres bis zum Stichtag (Salden der Konten Umsatzsteuer, Vorsteuer, " +
      "Vorauszahlungen und 'Umsatzsteuer frühere Jahre'), alle weiteren Steuerkonten wie gebucht (Lohnsteuer, Gewerbesteuer, " +
      "Körperschaftsteuer, Solidaritätszuschlag, Kapitalertragsteuer: Aufwand, Rückstellung, Verbindlichkeit) und offene Belege von " +
      "Finanzamt und anderen Steuerbehörden. Dazu eine Auswertung je Monat, Quartal und Jahr (perioden): Umsatzsteuer, Vorsteuer, " +
      "Zahllast, Gewinn und, mit rechtsform und hebesatz_pct, eine überschlägige Schätzung (~) von Gewerbesteuer, Einkommensteuer " +
      "des Einzelunternehmers, Körperschaftsteuer, Soli und Kapitalertragsteuer. Die Schätzung nimmt den Gewinn laut Buchungen, " +
      "ohne Hinzurechnungen, Verlustvortrag, Vorauszahlungen und persönliche Verhältnisse, und ersetzt keine Steuererklärung. " +
      "Rechtsform und Ort stehen in BHB unter Unternehmensdaten (nicht über die API). Positiv bei zahllast heißt: so viel ist noch " +
      "zu zahlen, negativ: Guthaben. Es erzeugt je Monat des Jahres eine Summen- und Saldenliste (bis 12) und ERSETZT damit die zuletzt " +
      "in BHB erzeugte. as_of als YYYY-MM-DD, Standard heute.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: {
      as_of: z.string().optional().describe("YYYY-MM-DD, Stichtag. Standard: heute."),
      rechtsform: z.string().optional().describe("Unternehmensform wie in BHB unter Unternehmensdaten, z. B. Einzelunternehmen, GbR, GmbH, UG. Ohne Angabe keine Steuerschätzung."),
      hebesatz_pct: z.number().min(200).max(900).optional().describe("Gewerbesteuer-Hebesatz der Gemeinde in Prozent (gesetzlicher Mindestsatz 200). Ohne Angabe keine Steuerschätzung."),
      ausschuettung: z.number().min(0).optional().describe("Nur Kapitalgesellschaft: geplante Ausschüttung im Jahr, für die Kapitalertragsteuer."),
      save_as: z.string().optional().describe("Dateiname (ohne Pfad): das volle Ergebnis wird als JSON unter ~/.mcp-buchhaltungsbutler/exports/ gespeichert und nur eine Kurzfassung zurückgegeben. Für Artefakte und große Auswertungen."),
    },
    async handler(args) {
      const asOf = args.as_of ?? new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`as_of "${asOf}" ist nicht im Format YYYY-MM-DD.`);
      // Je Monat eine Summen- und Saldenliste (nacheinander): die Periodensummen geben Umsatzsteuer und Gewinn je Monat, der Saldo
      // des letzten Berichts ist der Stand zum Stichtag (BHB führt die Salden vom Jahresbeginn fort).
      const ranges = seriesMonths(asOf, Number(asOf.slice(5, 7)));
      const monthly: MonthInput[] = [];
      let report: Sums = {};
      for (const m of ranges) {
        report = await runReport<Sums>("sums", { from: m.from, to: m.to > asOf ? asOf : m.to });
        monthly.push(monthInput(m.from.slice(0, 7), report));
      }
      const lines = taxLines(report);
      const rechtsform = args.rechtsform !== undefined ? normalizeRechtsform(args.rechtsform) : null;
      const perioden = buildPeriods(monthly, { rechtsform, hebesatzPct: args.hebesatz_pct ?? null, ausschuettung: args.ausschuettung ?? 0 });

      const sumOf = (area: TaxArea) => r2(lines.filter((l) => l.bereich === area).reduce((t, l) => t + l.saldo, 0));
      // Soll-Salden vermindern die Zahllast, Haben-Salden erhöhen sie: Zahllast = -Summe der Salden.
      const ust = lines.filter((l) => l.bereich === "umsatzsteuer");
      const ustZahllast = r2(-ust.reduce((t, l) => t + l.saldo, 0));

      const offeneBelege: Array<OpenReceipt & { richtung: string }> = [];
      let truncated = false;
      for (const dir of ["inbound", "outbound"] as const) {
        const rows: Record<string, unknown>[] = [];
        for (let i = 0; i < 20; i++) {
          const res = await client.call<BBListResult>("receiptsGet", { list_direction: dir, payment_status: "unpaid", deleted: false, limit: 500, offset: i * 500 });
          const page = res.data ?? [];
          rows.push(...page.filter((r) => AUTHORITY.test(String(r.counterparty ?? ""))));
          if (page.length < 500) break;
          if (i === 19) truncated = true;
        }
        offeneBelege.push(...openReceiptRows(rows, asOf).map((r) => ({ ...r, richtung: dir === "inbound" ? "Eingangsrechnung" : "Ausgangsrechnung" })));
      }

      const warnings: string[] = [];
      if (report.integrityError) warnings.push("BHB meldet einen Integritätsfehler in der Summen- und Saldenliste; Zahlen nicht verwenden, bis er geklärt ist.");
      if (truncated) warnings.push("Offene Belege: Abfrage nach 20 Seiten abgebrochen, Steuerbehörden-Belege unvollständig.");
      if (args.rechtsform !== undefined && rechtsform === null) warnings.push(`Unternehmensform "${args.rechtsform}" nicht erkannt (Einzelunternehmen, Freiberufler, GbR, OHG, KG, GmbH, UG, AG): keine Steuerschätzung.`);
      if (rechtsform === null || args.hebesatz_pct === undefined) warnings.push("Keine Steuerschätzung: rechtsform und hebesatz_pct fehlen.");

      return finishWithExport(args.save_as, {
        as_of: asOf,
        jahr: asOf.slice(0, 4),
        umsatzsteuer: { zahllast: ustZahllast, konten: ust },
        weitere_steuern: {
          lohnsteuer: sumOf("lohnsteuer"),
          ertragsteuern_gebucht: sumOf("ertragsteuern"),
          sonstige: sumOf("sonstige"),
          konten: lines.filter((l) => l.bereich !== "umsatzsteuer"),
        },
        offene_belege_steuerbehoerden: offeneBelege,
        annahmen: {
          rechtsform,
          hebesatz_pct: args.hebesatz_pct ?? null,
          ausschuettung: args.ausschuettung ?? 0,
          gewinn: "Haben minus Soll der Konten der Klassen Einnahmen, Betriebsausgabe und Abschreibungen je Monat (Privatkonten zählen nicht)",
          schaetzung: "Veränderung der kumulierten Schätzung seit Jahresbeginn je Zeitraum: Quartal = Stand Quartalsende minus Stand Vorquartalsende",
        },
        perioden,
        hinweise: [
          "Umsatzsteuer-Zahllast = Summe der Haben-Salden der Konten Umsatzsteuer abzüglich der Soll-Salden von Vorsteuer, Vorauszahlungen/Erstattungen und 'Umsatzsteuer frühere Jahre'. Positiv: noch zu zahlen, negativ: Guthaben. Maßgeblich ist die Umsatzsteuer-Voranmeldung; die Zahl hier ist der gebuchte Stand und hängt davon ab, dass Zahlungen ans Finanzamt gebucht sind.",
          "Ist-/Soll-Versteuerung wird erst bei der Auswertung berechnet, nicht gebucht: der Stand gilt für die Besteuerungsart, die zum Stichtag eingestellt ist.",
          "Die weiteren Steuerkonten stehen so da, wie sie gebucht sind (Salden, Soll positiv). Daneben steht, wenn rechtsform und hebesatz_pct angegeben sind, in perioden eine überschlägige Schätzung (~): Gewinn laut Buchungen, ohne Hinzurechnungen und Kürzungen zur Gewerbesteuer, ohne Verlustvortrag, Vorauszahlungen und persönliche Verhältnisse. Einzelunternehmen: Gewerbesteuer (Freibetrag 24.500 €, Messzahl 3,5 %) und Einkommensteuer auf den Gewinn allein nach § 32a EStG 2026 abzüglich Anrechnung der Gewerbesteuer; Soli auf die Einkommensteuer und Kirchensteuer werden nicht berechnet. Kapitalgesellschaft: Gewerbesteuer ohne Freibetrag, Körperschaftsteuer 15 %, Soli 5,5 % darauf, Kapitalertragsteuer 25 % plus Soli auf eine angegebene Ausschüttung. Die Schätzung ersetzt keine Steuererklärung.",
          "Ein Verlustmonat senkt die kumulierte Schätzung, deshalb kann der Wert eines Monats oder Quartals negativ sein: er ist die Veränderung der Schätzung, keine Erstattung.",
          "Offene Belege von Finanzamt und anderen Steuerbehörden: nach dem Namen der Gegenpartei erkannt (Finanzamt, Finanzkasse, Hauptzollamt, Gemeinde-/Stadtkasse). Negative Beträge sind Erstattungen.",
        ],
        warnings,
      });
    },
  });

  return [getTaxPosition];
}
