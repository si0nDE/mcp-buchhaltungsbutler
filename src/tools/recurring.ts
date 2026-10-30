import { z } from "zod";

// BuchhaltungsButler kennt für Wiederholungsrechnungen weder Stopp noch Liste (spec/buchhaltungsbutler-v1.json, API 1.9.1).
// Ein Enddatum steht nicht in der Spec, die Oberfläche hat es aber ("Letzte Rechnung"), und die API nimmt es als
// `recurring_date_end` an: belegt am 29.10.2026 mit einem Testplan im Konto Fieber IT (der Plan zeigte "Letzte Rechnung").
// Ein ungültiges Datum ergab dort HTTP 500 NACH dem Anlegen der Rechnung (ohne Plan); deshalb wird alles vorab geprüft.
export const recurringGuardShape = {
  confirm_creates_first_invoice: z
    .boolean()
    .optional()
    .describe(
      "Pflicht bei recurring_interval. Bestätigt, dass die erste Rechnung sofort und endgültig entsteht (Nummer aus dem Nummernkreis)."
    ),
  allow_open_ended: z
    .boolean()
    .optional()
    .describe(
      "Nur nötig bei recurring_interval ohne recurring_date_end: der Plan läuft dann, bis er in der Oberfläche unter " +
        "\"Wiederkehrende Rechnungen\" gestoppt wird; per Konnektor ist das nicht möglich."
    ),
};

export const recurringEndShape = {
  recurring_date_end: z
    .string()
    .optional()
    .describe(
      "YYYY-MM-DD, \"Letzte Rechnung\" des Plans. Nicht in der API-Spezifikation, aber mit dem Konto belegt (29.10.2026). " +
        "Ohne dieses Feld bricht der Konnektor ab, außer allow_open_ended: true."
    ),
};

export const INTERVAL_VALUES = ["weekly", "monthly", "quarterly", "yearly"] as const;
type Interval = (typeof INTERVAL_VALUES)[number];

// Beschreibung für die Tool-Doku, an beiden Create-Tools gleich.
export const RECURRING_DESCRIPTION =
  "recurring_interval (weekly, monthly, quarterly, yearly) legt einen Wiederholungsplan an: die erste Rechnung entsteht sofort und endgültig, " +
  "die nächste zum recurring_date_next. Per API gibt es keinen Stopp und keine Liste der Pläne. create_invoice kennt recurring_date_end " +
  "(\"Letzte Rechnung\", nicht in der Spec, aber belegt); ohne Enddatum läuft der Plan weiter, bis der Nutzer ihn in der BHB-Oberfläche stoppt. " +
  "Der Konnektor verlangt confirm_creates_first_invoice: true und ein Enddatum oder allow_open_ended: true; sonst bricht er ab. " +
  "Je Lauf neu gesetzt werden Rechnungsdatum und Fälligkeit; date_of_supply und alle Texte bleiben wie bei der ersten Rechnung " +
  "(Platzhalter für Monat oder Leistungszeitraum sind nicht belegt): bei wechselndem Leistungszeitraum kein Plan, sondern einzelne Rechnungen.";

// Steht in der Antwort eines echten Aufrufs, damit das Modell die Grenze genau dann liest, wenn es sonst nach dem Stopp fragt.
export function recurringCreatedWarning(endDate?: string): string {
  const stop =
    "Stoppen und Auflisten gibt es per API nicht (die ID des Plans wird nicht geliefert): den Nutzer bitten, in der BHB-Oberfläche unter " +
    "\"Wiederkehrende Rechnungen\" zu prüfen oder zu stoppen; nicht selbst per Browser danach suchen. Eine Korrektur storniert nur die erzeugte Rechnung, nicht den Plan. " +
    "Jeder Lauf trägt dasselbe date_of_supply und dieselben Texte wie die erste Rechnung; versendet wird nichts.";
  return endDate === undefined
    ? `Wiederholungsplan angelegt: die erste Rechnung ist endgültig, der Plan läuft ohne Enddatum weiter. ${stop}`
    : `Wiederholungsplan angelegt, Letzte Rechnung ${endDate} (recurring_date_end). Ob BHB den Plan so übernommen hat, lässt sich per API nicht prüfen: den Nutzer bitten, "Nächste Rechnung" und "Letzte Rechnung" in der Oberfläche zu kontrollieren. ${stop}`;
}

export function assertRecurring(args: {
  recurring_interval?: string;
  recurring_date_next?: string;
  recurring_date_end?: string;
  confirm_creates_first_invoice?: boolean;
  allow_open_ended?: boolean;
  draft?: boolean;
}): void {
  if (args.recurring_interval === undefined) {
    if (args.recurring_date_end !== undefined) throw new Error("recurring_date_end braucht recurring_interval.");
    return;
  }
  if (!(INTERVAL_VALUES as readonly string[]).includes(args.recurring_interval)) {
    throw new Error(`recurring_interval muss weekly, monthly, quarterly oder yearly sein, bekommen: "${args.recurring_interval}".`);
  }
  if (args.recurring_date_next === undefined) {
    throw new Error("recurring_date_next ist Pflicht, sobald recurring_interval gesetzt ist.");
  }
  const next = parseDate(args.recurring_date_next, "recurring_date_next");
  if (args.recurring_date_end !== undefined) {
    if (args.draft) throw new Error("recurring_date_end ist für Entwürfe (draft) nicht geprüft; nur bei einer echten Rechnung verwenden.");
    const end = parseDate(args.recurring_date_end, "recurring_date_end");
    if (end < next) throw new Error(`recurring_date_end (${args.recurring_date_end}) liegt vor recurring_date_next (${args.recurring_date_next}).`);
  }
  const missing: string[] = [];
  if (args.confirm_creates_first_invoice !== true) {
    missing.push(
      "confirm_creates_first_invoice: true (die erste Rechnung entsteht sofort und endgültig, mit Nummer aus dem Nummernkreis; eine Korrektur verbraucht eine weitere Nummer)"
    );
  }
  if (args.recurring_date_end === undefined && args.allow_open_ended !== true) {
    missing.push(
      "ein Enddatum (recurring_date_end, bei create_invoice) oder allow_open_ended: true (ohne Enddatum läuft der Plan weiter, bis er in der BHB-Oberfläche unter \"Wiederkehrende Rechnungen\" gestoppt wird)"
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `Wiederholungsrechnung nicht angelegt, es fehlt: ${missing.join("; ")}. Mit dry_run: true (nur create_invoice) lässt sich der Plan vorher ansehen, ohne etwas anzulegen.`
    );
  }
}

function parseDate(value: string, label: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : undefined;
  if (!m || !d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new Error(`${label} muss ein gültiges Datum im Format YYYY-MM-DD sein, bekommen: "${value}".`);
  }
  return d;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Termin n (0 = Start) im Abstand des Intervalls. Monatsintervalle behalten den Starttag und
// werden auf den letzten Tag des Monats begrenzt (31.01. -> 28.02.); ob BHB das ebenso tut, ist nicht belegt.
function addInterval(start: Date, interval: Interval, n: number): Date {
  if (interval === "weekly") return new Date(start.getTime() + n * 7 * 86_400_000);
  const months = n * (interval === "monthly" ? 1 : interval === "quarterly" ? 3 : 12);
  const total = start.getUTCFullYear() * 12 + start.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay)));
}

function num(value: string, label: string): number {
  const n = Number(value.replace(",", "."));
  if (!Number.isFinite(n)) throw new Error(`${label} ist keine Zahl: "${value}".`);
  return n;
}

const cents = (n: number) => Math.round(n * 100) / 100;

interface PreviewArgs {
  date: string;
  show_prices_type: "net" | "gross";
  items: Array<{ amount: string; vat: string; single_price: string }>;
  recurring_interval?: string;
  recurring_date_next?: string;
  recurring_date_end?: string;
  draft?: boolean;
}

const MAX_SHOWN = 120;

// Vorschau ohne Aufruf an BHB. Mit Enddatum alle Termine bis dahin (höchstens MAX_SHOWN), sonst nur die nächsten `runs`.
export function recurringDryRun(args: PreviewArgs, runs = 12): Record<string, unknown> {
  parseDate(args.date, "date");
  let net = 0;
  let gross = 0;
  for (const [i, item] of args.items.entries()) {
    const line = num(item.amount, `items[${i}].amount`) * num(item.single_price, `items[${i}].single_price`);
    const rate = num(item.vat, `items[${i}].vat`) / 100;
    if (args.show_prices_type === "net") {
      net += line;
      gross += line * (1 + rate);
    } else {
      gross += line;
      net += line / (1 + rate);
    }
  }
  const result: Record<string, unknown> = {
    dry_run: true,
    created: false,
    totals_per_invoice: { net: cents(net), gross: cents(gross) },
    totals_note:
      "Summe aus den Positionen, auf Cent gerundet; BHB rundet unter Umständen je Position, der Betrag kann um Cent abweichen.",
    invoice_numbers:
      "nicht ermittelbar: die API nennt die nächste Nummer nicht. Sie kommt aus dem Nummernkreis des Kontos und zählt fortlaufend weiter.",
  };
  if (args.recurring_interval === undefined) {
    assertRecurring(args);
    return { ...result, invoices: [{ date: args.date, note: "einzelne Rechnung" }] };
  }
  // Nur die Eingaben prüfen; die Bestätigungen gehören zum echten Aufruf.
  assertRecurring({ ...args, confirm_creates_first_invoice: true, allow_open_ended: true });
  const interval = args.recurring_interval as Interval;
  const next = parseDate(args.recurring_date_next!, "recurring_date_next");
  const end = args.recurring_date_end === undefined ? undefined : parseDate(args.recurring_date_end, "recurring_date_end");
  const dates: string[] = [];
  const warnings: string[] = [];
  if (end === undefined) {
    for (let n = 0; n < runs; n++) dates.push(iso(addInterval(next, interval, n)));
    warnings.push("Kein Enddatum: nach den gezeigten Terminen läuft der Plan weiter, bis er in der Oberfläche gestoppt wird.");
  } else {
    for (let n = 0; n < MAX_SHOWN; n++) {
      const d = addInterval(next, interval, n);
      if (d > end) break;
      dates.push(iso(d));
    }
    if (dates.length === MAX_SHOWN && addInterval(next, interval, MAX_SHOWN) <= end) {
      warnings.push(`Mehr als ${MAX_SHOWN} Termine bis zum Enddatum; gezeigt sind die ersten ${MAX_SHOWN}.`);
    }
    warnings.push(
      "Annahme: eine Rechnung, die genau auf das Enddatum fällt, entsteht noch (Feld \"Letzte Rechnung\"); ob BHB den Endtag einschließt, ist nicht belegt."
    );
  }
  if (interval !== "weekly" && next.getUTCDate() > 28) {
    warnings.push(
      `Starttag ${next.getUTCDate()}: in kürzeren Monaten rechnet die Vorschau auf den letzten Tag des Monats; ob BHB das ebenso tut, ist nicht belegt.`
    );
  }
  return {
    ...result,
    invoices: [
      { date: args.date, note: "entsteht sofort und endgültig beim echten Aufruf" },
      ...dates.map((d) => ({ date: d, note: "Wiederholung" })),
    ],
    shown_repeats: dates.length,
    warnings,
  };
}
