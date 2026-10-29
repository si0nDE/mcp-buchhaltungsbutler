import { z } from "zod";

// BuchhaltungsButler kennt für Wiederholungsrechnungen weder Enddatum noch Stopp noch Liste
// (spec/buchhaltungsbutler-v1.json, API 1.9.1). Ein Plan läuft also offen weiter und lässt sich
// nur in der Oberfläche stoppen. Die Felder hier schützen davor, das versehentlich auszulösen.
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
      "Pflicht bei recurring_interval. BuchhaltungsButler kennt kein Enddatum: der Plan läuft, bis er in der Oberfläche " +
        "unter \"Wiederkehrende Rechnungen\" gestoppt wird; per Konnektor ist das nicht möglich."
    ),
};

export const INTERVAL_VALUES = ["weekly", "monthly", "quarterly", "yearly"] as const;
type Interval = (typeof INTERVAL_VALUES)[number];

// Beschreibung für die Tool-Doku, an beiden Create-Tools gleich.
export const RECURRING_DESCRIPTION =
  "recurring_interval (weekly, monthly, quarterly, yearly) legt einen Wiederholungsplan an: die erste Rechnung entsteht sofort und endgültig, " +
  "die nächste zum recurring_date_next. Es gibt kein Enddatum und keinen Stopp per API; ein Plan läuft weiter, bis er in der BHB-Oberfläche " +
  "gestoppt wird. Deshalb verlangt der Konnektor confirm_creates_first_invoice: true und allow_open_ended: true; ohne beide bricht er ab.";

// Steht in der Antwort eines echten Aufrufs, damit das Modell die Grenze genau dann liest, wenn es sonst nach dem Stopp fragt.
export const RECURRING_CREATED_WARNING =
  "Wiederholungsplan angelegt: die erste Rechnung ist endgültig, der Plan läuft offen weiter. BuchhaltungsButler hat kein Enddatum, " +
  "und per API lässt sich der Plan weder auflisten noch stoppen (seine ID wird nicht geliefert). Den Nutzer bitten, ihn rechtzeitig in der " +
  "BHB-Oberfläche unter \"Wiederkehrende Rechnungen\" zu stoppen; nicht selbst per Browser danach suchen. Eine Korrektur storniert nur die erzeugte Rechnung, nicht den Plan.";

export function assertRecurringConfirmed(args: {
  recurring_interval?: string;
  recurring_date_next?: string;
  confirm_creates_first_invoice?: boolean;
  allow_open_ended?: boolean;
}): void {
  if (args.recurring_interval === undefined) return;
  const missing: string[] = [];
  if (args.confirm_creates_first_invoice !== true) {
    missing.push(
      "confirm_creates_first_invoice: true (die erste Rechnung entsteht sofort und endgültig, mit Nummer aus dem Nummernkreis; eine Korrektur verbraucht eine weitere Nummer)"
    );
  }
  if (args.allow_open_ended !== true) {
    missing.push(
      "allow_open_ended: true (BuchhaltungsButler kennt kein Enddatum: der Plan läuft weiter, bis er in der BHB-Oberfläche unter \"Wiederkehrende Rechnungen\" gestoppt wird)"
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
}

// Vorschau ohne Aufruf an BHB. Weil es kein Enddatum gibt, werden nur die nächsten `runs` Termine gezeigt.
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
    return { ...result, invoices: [{ date: args.date, note: "einzelne Rechnung" }] };
  }
  if (!(INTERVAL_VALUES as readonly string[]).includes(args.recurring_interval)) {
    throw new Error(`recurring_interval muss weekly, monthly, quarterly oder yearly sein, bekommen: "${args.recurring_interval}".`);
  }
  if (args.recurring_date_next === undefined) {
    throw new Error("recurring_date_next ist Pflicht, sobald recurring_interval gesetzt ist.");
  }
  const interval = args.recurring_interval as Interval;
  const next = parseDate(args.recurring_date_next, "recurring_date_next");
  const dates = Array.from({ length: runs }, (_, n) => iso(addInterval(next, interval, n)));
  const warnings = [
    "BuchhaltungsButler kennt kein Enddatum: nach den gezeigten Terminen läuft der Plan weiter, bis er in der Oberfläche gestoppt wird.",
  ];
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
    shown_repeats: runs,
    warnings,
  };
}
