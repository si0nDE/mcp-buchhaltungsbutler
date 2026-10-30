// Überschlägige Steuerschätzung ("~") aus dem Gewinn einer Auswertung. Reine Rechenlogik, ohne BHB-Aufrufe.
//
// Sie ersetzt keine Steuererklärung: Grundlage ist der Gewinn laut Buchungen (Erträge minus Aufwand der Ergebniskonten). Es
// gibt keine Hinzurechnungen und Kürzungen zur Gewerbesteuer, keinen Verlustvortrag, keine Vorauszahlungen, keine persönlichen
// Verhältnisse. Wo etwas von der Person abhängt (Einkommensteuer des Einzelunternehmers, Soli darauf, Kirchensteuer), steht
// eine Orientierung oder nichts. Gesetzesstand 2026: Einkommensteuertarif nach § 32a Abs. 1 EStG (Wortlaut geprüft), Gewerbesteuer
// Messzahl 3,5 % und Freibetrag 24.500 € für Personenunternehmen, Körperschaftsteuer 15 %, Soli 5,5 %, Kapitalertragsteuer 25 %.

export type Rechtsform = "einzelunternehmen" | "personengesellschaft" | "kapitalgesellschaft";

export function normalizeRechtsform(text: string): Rechtsform | null {
  const t = text.toLowerCase();
  if (/(gmbh|\bug\b|haftungsbeschränkt|\bag\b|aktiengesellschaft|kapitalgesellschaft|\bse\b)/.test(t)) return "kapitalgesellschaft";
  if (/(einzel|freiberuf|gewerbetreibend|selbständig|selbststaendig|kleingewerbe|freelancer)/.test(t)) return "einzelunternehmen";
  if (/(\bgbr\b|\bohg\b|\bkg\b|partner|personengesellschaft|gesellschaft bürgerlichen)/.test(t)) return "personengesellschaft";
  return null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// § 32a Abs. 1 EStG ab Veranlagungszeitraum 2026, Grundtarif. Zu versteuerndes Einkommen auf volle Euro abgerundet, Steuer auf
// volle Euro abgerundet.
export function incomeTax2026(zve: number): number {
  const x = Math.floor(Math.max(0, zve));
  let tax: number;
  if (x <= 12348) tax = 0;
  else if (x <= 17799) {
    const y = (x - 12348) / 10000;
    tax = (914.51 * y + 1400) * y;
  } else if (x <= 69878) {
    const z = (x - 17799) / 10000;
    tax = (173.1 * z + 2397) * z + 1034.87;
  } else if (x <= 277825) tax = 0.42 * x - 11135.63;
  else tax = 0.45 * x - 19470.38;
  return Math.floor(tax);
}

const GEWST_FREIBETRAG = 24500;
const GEWST_MESSZAHL = 0.035;

export interface Gewerbesteuer {
  gewerbeertrag: number;
  freibetrag: number;
  messbetrag: number;
  steuer: number;
}

// Gewerbeertrag = Gewinn auf volle 100 € abgerundet; Freibetrag nur für Personenunternehmen; Messbetrag auf volle Euro abgerundet.
export function gewerbesteuer(gewinn: number, rechtsform: Rechtsform, hebesatzPct: number): Gewerbesteuer {
  const ertrag = Math.max(0, Math.floor(gewinn / 100) * 100);
  const freibetrag = rechtsform === "kapitalgesellschaft" ? 0 : GEWST_FREIBETRAG;
  const messbetrag = Math.floor(Math.max(0, ertrag - freibetrag) * GEWST_MESSZAHL);
  return { gewerbeertrag: ertrag, freibetrag, messbetrag, steuer: r2((messbetrag * hebesatzPct) / 100) };
}

export interface Estimate {
  gewerbesteuer: number;
  // Einzelunternehmen: Einkommensteuer auf den Gewinn allein nach Anrechnung der Gewerbesteuer (§ 35 EStG), sonst null.
  einkommensteuer: number | null;
  koerperschaftsteuer: number | null;
  // Solidaritätszuschlag auf die Körperschaftsteuer. Auf die Einkommensteuer wird er nicht berechnet (Freigrenze, persönlich).
  soli: number | null;
  // Kapitalertragsteuer inklusive Soli auf eine Ausschüttung, nur Kapitalgesellschaft und nur mit Ausschüttung.
  kapitalertragsteuer: number | null;
}

export const ESTIMATE_KEYS = ["gewerbesteuer", "einkommensteuer", "koerperschaftsteuer", "soli", "kapitalertragsteuer"] as const;

export function estimateTaxes(gewinn: number, rechtsform: Rechtsform, hebesatzPct: number, ausschuettung = 0): Estimate {
  const g = gewerbesteuer(gewinn, rechtsform, hebesatzPct);
  if (rechtsform === "kapitalgesellschaft") {
    const kst = r2(Math.max(0, gewinn) * 0.15);
    return {
      gewerbesteuer: g.steuer,
      einkommensteuer: null,
      koerperschaftsteuer: kst,
      soli: r2(kst * 0.055),
      kapitalertragsteuer: ausschuettung > 0 ? r2(ausschuettung * 0.25 * 1.055) : null,
    };
  }
  // Personenunternehmen: Gewerbesteuer wird bis zum 4,0-fachen des Messbetrags auf die Einkommensteuer angerechnet.
  const anrechnung = Math.min(g.steuer, g.messbetrag * 4);
  const est = rechtsform === "einzelunternehmen" ? Math.max(0, incomeTax2026(gewinn) - anrechnung) : null;
  return { gewerbesteuer: g.steuer, einkommensteuer: est, koerperschaftsteuer: null, soli: null, kapitalertragsteuer: null };
}

export interface MonthInput {
  schluessel: string; // YYYY-MM
  ust: number; // Umsatzsteuer der Periode (Haben minus Soll)
  vst: number; // Vorsteuer der Periode (Soll minus Haben)
  gewinn: number; // Ergebnis der Periode
}

export interface PeriodRow {
  typ: "monat" | "quartal" | "jahr";
  schluessel: string;
  label: string;
  teilweise: boolean;
  umsatzsteuer: number;
  vorsteuer: number;
  zahllast: number;
  gewinn: number;
  gewinn_kum: number;
  gewerbesteuer: number | null;
  einkommensteuer: number | null;
  koerperschaftsteuer: number | null;
  soli: number | null;
  kapitalertragsteuer: number | null;
}

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

export interface TaxAssumptions {
  rechtsform: Rechtsform | null;
  hebesatzPct: number | null;
  ausschuettung: number;
}

// Monate (eines Jahres, lückenlos ab Januar) zu Monats-, Quartals- und Jahreszeilen. Die Schätzung wird je Zeitraum als Zuwachs
// der kumulierten Schätzung seit Jahresbeginn gerechnet, weil Freibetrag und Tarif nicht linear sind: Quartal = Schätzung zum
// Quartalsende minus Schätzung zum Vorquartalsende.
export function buildPeriods(months: MonthInput[], a: TaxAssumptions, fullMonthsInYear = 12): PeriodRow[] {
  const canEstimate = a.rechtsform !== null && a.hebesatzPct !== null;
  const cum: number[] = [];
  months.reduce((t, m, i) => (cum[i] = t + m.gewinn), 0);
  const est = (i: number, withDividend: boolean): Estimate | null =>
    !canEstimate || i < 0 ? null : estimateTaxes(cum[i], a.rechtsform as Rechtsform, a.hebesatzPct as number, withDividend ? a.ausschuettung : 0);
  const zero: Estimate = { gewerbesteuer: 0, einkommensteuer: 0, koerperschaftsteuer: 0, soli: 0, kapitalertragsteuer: 0 };
  const delta = (to: number, from: number, withDividend: boolean): Partial<Record<(typeof ESTIMATE_KEYS)[number], number | null>> => {
    const b = est(to, withDividend);
    if (!b) return Object.fromEntries(ESTIMATE_KEYS.map((k) => [k, null]));
    const a0 = from < 0 ? zero : (est(from, false) as Estimate);
    return Object.fromEntries(ESTIMATE_KEYS.map((k) => [k, b[k] === null ? null : r2((b[k] as number) - ((a0[k] as number | null) ?? 0))]));
  };
  const row = (typ: PeriodRow["typ"], schluessel: string, label: string, teilweise: boolean, from: number, to: number, withDividend = false): PeriodRow => {
    const slice = months.slice(from + 1 < 0 ? 0 : from + 1, to + 1);
    const ust = r2(slice.reduce((t, m) => t + m.ust, 0));
    const vst = r2(slice.reduce((t, m) => t + m.vst, 0));
    const d = delta(to, from, withDividend);
    return {
      typ,
      schluessel,
      label,
      teilweise,
      umsatzsteuer: ust,
      vorsteuer: vst,
      zahllast: r2(ust - vst),
      gewinn: r2(slice.reduce((t, m) => t + m.gewinn, 0)),
      gewinn_kum: r2(cum[to]),
      gewerbesteuer: d.gewerbesteuer ?? null,
      einkommensteuer: d.einkommensteuer ?? null,
      koerperschaftsteuer: d.koerperschaftsteuer ?? null,
      soli: d.soli ?? null,
      kapitalertragsteuer: d.kapitalertragsteuer ?? null,
    };
  };
  const out: PeriodRow[] = [];
  months.forEach((m, i) => {
    const mon = Number(m.schluessel.slice(5, 7));
    out.push(row("monat", m.schluessel, `${MONTHS[mon - 1]} ${m.schluessel.slice(0, 4)}`, false, i - 1, i));
  });
  const year = months[0]?.schluessel.slice(0, 4) ?? "";
  for (let q = 0; q < 4; q++) {
    const first = q * 3;
    if (first >= months.length) break;
    const last = Math.min(first + 2, months.length - 1);
    out.push(row("quartal", `${year}-Q${q + 1}`, `${q + 1}. Quartal ${year}`, last < first + 2, first - 1, last));
  }
  if (months.length > 0) out.push(row("jahr", year, `Jahr ${year}`, months.length < fullMonthsInYear, -1, months.length - 1, true));
  return out;
}
