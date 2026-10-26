import { round2, type TravellerType } from "./travel-expense-calc.js";

export type ExpenseCategory = "fare" | "lodging" | "incidental";
export type FareKind = "train" | "flight" | "taxi" | "bus" | "other";

export interface Expense {
  category: ExpenseCategory;
  description: string;
  /** Date of the receipt. For lodging: the day the night begins (the breakfast is the next morning). */
  date: string;
  /** Gross amount in the receipt currency. */
  amount: number;
  /** VAT amount as printed on the receipt, receipt currency. */
  vat_amount?: number;
  vat_rate?: 0 | 7 | 19;
  currency?: string;
  /** EUR per 1 unit of the receipt currency. */
  fx_rate?: number;
  fx_source?: string;
  invoice_recipient?: "company" | "traveller" | "unknown";
  foreign_vat?: boolean;
  receipt_missing?: boolean;
  breakfast_included?: boolean;
  /**
   * Breakfast amount if shown separately on the receipt (receipt currency). 0 means "no deduction"; only undefined falls
   * back to 20 % of the 24-hour rate. A line carries ONE vat_rate/vat_amount: a receipt with two VAT rates must be
   * entered as two expenses.
   */
  breakfast_amount?: number;
  fare_kind?: FareKind;
}

export interface CostLine {
  category: ExpenseCategory;
  description: string;
  date: string;
  fareKind?: FareKind;
  currency: string;
  fxRate: number;
  grossEur: number;
  vatEur: number;
  netEur: number;
  vatRate: 0 | 7 | 19;
  /** true if the VAT of this line may be booked as Vorsteuer. */
  vorsteuer: boolean;
  recipient: "company" | "traveller" | "unknown";
  receiptMissing: boolean;
  foreignVat: boolean;
  breakfastDeductedEur: number;
}

export interface KmTrip {
  mode: "car" | "other_motor";
  km: number;
  date: string;
  description?: string;
  ownership?: "private" | "business";
}

export interface KmLine {
  mode: KmTrip["mode"];
  km: number;
  date: string;
  description: string;
  rate: number;
  amount: number;
}

export interface Totals {
  allowances: number;
  lodgingFlat: number;
  km: number;
  fares: number;
  lodging: number;
  incidentals: number;
  total: number;
  advance: number;
  reimbursement: number;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const KLEINBETRAG_LIMIT = 250; // § 33 UStDV, gross
const KM_RATES: Record<KmTrip["mode"], number> = { car: 0.3, other_motor: 0.2 };

// Real calendar date (2026-02-31 fails): round-trip through Date.
function isRealDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

export function nextDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

export function processExpenses(
  expenses: Expense[],
  context: { travellerType: TravellerType; breakfastRate: (date: string) => number }
): { lines: CostLine[]; warnings: string[] } {
  const warnings = new Set<string>();
  const lines: CostLine[] = [];

  for (const expense of expenses) {
    const label = `Beleg "${expense.description}"`;
    if (!isRealDate(expense.date)) throw new Error(`${label}: Datum im Format YYYY-MM-DD und als echtes Kalenderdatum angeben.`);
    if (!Number.isFinite(expense.amount) || !(expense.amount > 0)) throw new Error(`${label}: amount muss eine Zahl größer 0 sein.`);
    if (expense.vat_amount !== undefined && !(Number.isFinite(expense.vat_amount) && expense.vat_amount >= 0 && expense.vat_amount <= expense.amount)) {
      throw new Error(`${label}: vat_amount muss eine Zahl zwischen 0 und amount sein.`);
    }
    if (expense.breakfast_amount !== undefined && !(Number.isFinite(expense.breakfast_amount) && expense.breakfast_amount >= 0)) {
      throw new Error(`${label}: breakfast_amount muss eine Zahl größer oder gleich 0 sein.`);
    }
    // Flags first: the VAT of such lines is discarded, so a missing vat_rate is irrelevant for them.
    const foreignVat = expense.foreign_vat === true;
    const receiptMissing = expense.receipt_missing === true;
    const currency = (expense.currency ?? "EUR").toUpperCase();
    let factor = 1;
    if (currency !== "EUR") {
      if (!(expense.fx_rate && Number.isFinite(expense.fx_rate) && expense.fx_rate > 0)) {
        throw new Error(`${label}: Fremdwährung ${currency} braucht fx_rate (EUR je 1 ${currency}).`);
      }
      if (!expense.fx_source) {
        throw new Error(`${label}: Fremdwährung ${currency} braucht fx_source (z. B. "BMF Monatskurs 03/2026").`);
      }
      factor = expense.fx_rate;
      warnings.add(
        "Fremdwährungsbeleg: Kurs und Quelle stehen im Beleg. Für die Einkommensteuer ist der Umrechnungskurs bei Reisekosten nicht " +
          "ausdrücklich geregelt; der BMF-Monatsdurchschnittskurs ist eine vertretbare Schätzung (§ 16 Abs. 6 UStG gilt für die Umsatzsteuer)."
      );
    }
    if ((expense.vat_amount ?? 0) > 0 && expense.vat_rate !== 7 && expense.vat_rate !== 19 && !foreignVat && !receiptMissing) {
      throw new Error(`${label}: Bei vat_amount größer 0 ist vat_rate 7 oder 19 anzugeben (vat_rate 0 würde die Vorsteuer stillschweigend verwerfen).`);
    }

    const recipient = expense.invoice_recipient ?? "unknown";
    const originalGross = round2(expense.amount * factor);
    let gross = originalGross;
    let vat = round2((expense.vat_amount ?? 0) * factor);
    let breakfastDeducted = 0;

    if (expense.category === "lodging" && expense.breakfast_included && context.travellerType === "self_employed") {
      const part =
        expense.breakfast_amount !== undefined
          ? round2(expense.breakfast_amount * factor)
          : round2(0.2 * context.breakfastRate(nextDateKey(expense.date)));
      if (part > gross) {
        throw new Error(`${label}: Der Frühstücksbetrag (${part} €) ist größer als der Belegbetrag (${gross} €); breakfast_amount und amount prüfen.`);
      }
      breakfastDeducted = part;
      const share = gross > 0 ? (gross - breakfastDeducted) / gross : 1;
      vat = round2(vat * share);
      gross = round2(gross - breakfastDeducted);
      warnings.add(
        `${label}: Frühstück im Hotelpreis wird als Verpflegung herausgerechnet (Rz. 118 BMF 25.11.2020, 20 % der 24-Stunden-Pauschale ` +
          "oder ausgewiesener Betrag). Auslegung für Selbstständige und Geschäftsführer, vom Steuerberater prüfen lassen."
      );
    }

    if (foreignVat) {
      vat = 0;
      warnings.add(
        `${label}: Ausländische Umsatzsteuer, kein deutscher Vorsteuerabzug. Erstattung nur im EU-Erstattungsverfahren ` +
          "(BZSt-Portal, Antrag bis 30.09. des Folgejahres, Mindestbetrag 400 € bei Quartals- bzw. 50 € bei Jahresantrag, § 18g UStG)."
      );
    }
    if (receiptMissing) {
      vat = 0;
      warnings.add(
        `${label}: Beleg fehlt. Ein Eigenbeleg ist kein anerkanntes Nachweismittel; Aufwand glaubhaft machen (R 9.4 Abs. 1 Satz 5 LStR), ` +
          "sonst schätzt das Finanzamt nach § 162 AO. Kein Vorsteuerabzug ohne Rechnung."
      );
    }
    if (expense.category === "fare" && expense.fare_kind === "flight" && vat === 0 && !receiptMissing && !foreignVat) {
      warnings.add(
        `${label}: Flugticket ohne ausgewiesene Umsatzsteuer: kein Vorsteuerabzug (§ 35 Abs. 2 UStDV; bei grenzüberschreitenden ` +
          "Flügen ggf. Erlass nach § 26 Abs. 3 UStG, nur der Inlandsanteil ist steuerbar)."
      );
    }

    const kleinbetrag = originalGross <= KLEINBETRAG_LIMIT;
    const vorsteuer = vat > 0 && !foreignVat && !receiptMissing && (recipient === "company" || kleinbetrag);
    if (vat > 0 && !foreignVat && !receiptMissing && !vorsteuer) {
      warnings.add(
        recipient === "traveller"
          ? `${label}: Rechnung auf den Namen des Reisenden und über 250 €: kein Vorsteuerabzug für die Firma (UStAE 15.2a Abs. 3).`
          : `${label}: Rechnungsempfänger prüfen: bei Rechnungen über 250 € setzt der Vorsteuerabzug eine Rechnung auf die Firma voraus.`
      );
    }
    if (expense.category === "lodging" && expense.breakfast_included) {
      warnings.add(
        `${label}: Frühstück im Hotelpreis. Der Steuersatz im Sammelposten ist nicht eindeutig (Speisen 7 % seit 1.1.2026, UStAE 12.16 Abs. 8 und 12 ` +
          "noch uneinheitlich). Eine Zeile hat genau einen Steuersatz und Steuerbetrag; ein abgezogener Frühstücksanteil mindert die USt anteilig. " +
          "Belege mit zwei Steuersätzen als zwei Belege erfassen."
      );
    }

    lines.push({
      category: expense.category,
      description: expense.description,
      date: expense.date,
      fareKind: expense.fare_kind,
      currency,
      fxRate: factor,
      grossEur: gross,
      vatEur: vat,
      netEur: round2(gross - vat),
      vatRate: expense.vat_rate ?? 0,
      vorsteuer,
      recipient,
      receiptMissing,
      foreignVat,
      breakfastDeductedEur: breakfastDeducted,
    });
  }
  return { lines, warnings: [...warnings] };
}

export function processKmTrips(trips: KmTrip[]): { lines: KmLine[]; warnings: string[] } {
  const lines: KmLine[] = [];
  for (const trip of trips) {
    if (trip.ownership === "business") {
      throw new Error(
        "Die Kilometerpauschale gilt nur für private Fahrzeuge (R 4.12 Abs. 2 EStR). Beim Betriebs-Pkw die tatsächlichen Kosten " +
          "als Beleg (category fare) erfassen."
      );
    }
    if (!isRealDate(trip.date)) throw new Error("Datum der Fahrt im Format YYYY-MM-DD und als echtes Kalenderdatum angeben.");
    if (!Number.isFinite(trip.km) || !(trip.km > 0)) throw new Error("km muss eine Zahl größer 0 sein.");
    const rate = KM_RATES[trip.mode];
    lines.push({
      mode: trip.mode,
      km: trip.km,
      date: trip.date,
      description: trip.description ?? (trip.mode === "car" ? "Fahrt mit privatem Pkw" : "Fahrt mit privatem Fahrzeug"),
      rate,
      amount: round2(trip.km * rate),
    });
  }
  return { lines, warnings: [] };
}

export function computeTotals(input: {
  allowances: number;
  lodgingFlat: number;
  lines: CostLine[];
  kmLines: KmLine[];
  advance: number;
}): Totals {
  const sum = (category: ExpenseCategory) =>
    round2(input.lines.filter((l) => l.category === category).reduce((s, l) => s + l.grossEur, 0));
  const km = round2(input.kmLines.reduce((s, l) => s + l.amount, 0));
  const fares = sum("fare");
  const lodging = sum("lodging");
  const incidentals = sum("incidental");
  const total = round2(input.allowances + input.lodgingFlat + km + fares + lodging + incidentals);
  return {
    allowances: input.allowances,
    lodgingFlat: input.lodgingFlat,
    km,
    fares,
    lodging,
    incidentals,
    total,
    advance: input.advance,
    reimbursement: round2(total - input.advance),
  };
}
