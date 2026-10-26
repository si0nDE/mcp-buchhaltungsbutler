import { round2, type TravellerType } from "./travel-expense-calc.js";
import { isDomesticCountry } from "./travel-rates.js";

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
   * entered as two expenses with the same receipt_id.
   */
  breakfast_amount?: number;
  fare_kind?: FareKind;
  /** Lines with the same receipt_id are one receipt (250 EUR Kleinbetrag limit and invoice recipient). */
  receipt_id?: string;
  /** "company": paid by the company itself, booked through its own receipt; shown but not reimbursed. */
  paid_by?: "traveller" | "company";
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
  receiptId?: string;
  paidBy: "traveller" | "company";
}

export interface KmTrip {
  mode: "car" | "other_motor";
  km: number;
  date: string;
  description?: string;
  ownership: "private" | "business";
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
  /** Informational: gross of the lines paid by the company, not part of total. */
  companyPaid: number;
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

export interface TripRange {
  /** Departure date "YYYY-MM-DD". */
  from: string;
  /** Return date "YYYY-MM-DD". */
  to: string;
}

const outsideTrip = (date: string, range?: TripRange): boolean => range !== undefined && (date < range.from || date > range.to);
const outsideTripText = (date: string, range: TripRange): string =>
  `Datum ${date} liegt außerhalb der Reise (${range.from} bis ${range.to}); Zuordnung zu dieser Reise prüfen.`;

// Lines with the same receipt_id form one receipt: one currency, one invoice recipient, one payer, one gross for the
// 250 EUR limit.
function receiptGroups(expenses: Expense[]): Map<string, { gross: number; label: string }> {
  const groups = new Map<string, { gross: number; currency: string; recipient: string; paidBy: string; label: string }>();
  for (const expense of expenses) {
    const id = expense.receipt_id?.trim();
    if (!id) continue;
    const currency = (expense.currency ?? "EUR").toUpperCase();
    const recipient = expense.invoice_recipient ?? "unknown";
    const paidBy = expense.paid_by ?? "traveller";
    const factor = currency === "EUR" ? 1 : (expense.fx_rate ?? Number.NaN);
    const group = groups.get(id);
    if (!group) {
      groups.set(id, { gross: round2(expense.amount * factor), currency, recipient, paidBy, label: id });
      continue;
    }
    if (group.currency !== currency) {
      throw new Error(`receipt_id "${id}": alle Positionen eines Belegs brauchen dieselbe Währung (${group.currency}, ${currency}).`);
    }
    if (group.recipient !== recipient) {
      throw new Error(`receipt_id "${id}": alle Positionen eines Belegs brauchen denselben invoice_recipient (${group.recipient}, ${recipient}).`);
    }
    if (group.paidBy !== paidBy) {
      throw new Error(`receipt_id "${id}": alle Positionen eines Belegs brauchen denselben paid_by (${group.paidBy}, ${paidBy}).`);
    }
    group.gross = round2(group.gross + round2(expense.amount * factor));
  }
  return groups;
}

export function processExpenses(
  expenses: Expense[],
  context: {
    travellerType: TravellerType;
    /** 24-hour rate of the trip day (place reached that day); undefined if the date is no trip day. */
    breakfastRate: (date: string) => number | undefined;
    /** Country of the trip day; undefined if the date is no trip day. */
    countryOfDate?: (date: string) => string | undefined;
    tripRange?: TripRange;
  }
): { lines: CostLine[]; warnings: string[] } {
  const warnings = new Set<string>();
  const lines: CostLine[] = [];
  const groups = receiptGroups(expenses);

  for (const expense of expenses) {
    const label = `Beleg "${expense.description}"`;
    if (!isRealDate(expense.date)) throw new Error(`${label}: Datum im Format YYYY-MM-DD und als echtes Kalenderdatum angeben.`);
    if (expense.paid_by !== undefined && expense.paid_by !== "traveller" && expense.paid_by !== "company") {
      throw new Error(`${label}: paid_by ist "traveller" oder "company".`);
    }
    if (outsideTrip(expense.date, context.tripRange)) warnings.add(`${label}: ${outsideTripText(expense.date, context.tripRange as TripRange)}`);
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
        "Fremdwährungsbeleg: Kurs und Quelle stehen im Beleg. Der BMF-Monatsdurchschnittskurs (§ 16 Abs. 6 UStG, Umsatzsteuer) wird hier als " +
          "Ansatz verwendet; für die Einkommensteuer ist der Umrechnungskurs bei Reisekosten nicht ausdrücklich geregelt."
      );
    }
    if ((expense.vat_amount ?? 0) > 0 && expense.vat_rate !== 7 && expense.vat_rate !== 19 && !foreignVat && !receiptMissing) {
      throw new Error(
        `${label}: Bei vat_amount größer 0 ist vat_rate 7 oder 19 anzugeben (vat_rate 0 würde die Vorsteuer stillschweigend verwerfen); ` +
          "bei ausländischer Umsatzsteuer foreign_vat: true setzen."
      );
    }
    // Foreign VAT must not end up as German Vorsteuer: hint when the receipt is from a foreign day or in a foreign currency.
    const country = context.countryOfDate?.(expense.date);
    const foreignDay = country !== undefined && !isDomesticCountry(country);
    if ((expense.vat_amount ?? 0) > 0 && !foreignVat && !receiptMissing && (foreignDay || currency !== "EUR")) {
      const where = [foreignDay ? `an einem Auslandstag (${country})` : "", currency !== "EUR" ? `in Fremdwährung (${currency})` : ""]
        .filter(Boolean)
        .join(" und ");
      warnings.add(
        `${label}: Beleg mit Umsatzsteuer ${where}: ausländische Umsatzsteuer? Dann foreign_vat: true setzen, sonst wird deutsche Vorsteuer angesetzt.`
      );
    }

    const recipient = expense.invoice_recipient ?? "unknown";
    const originalGross = round2(expense.amount * factor);
    let gross = originalGross;
    let vat = round2((expense.vat_amount ?? 0) * factor);
    let breakfastDeducted = 0;

    if (expense.category === "lodging" && expense.breakfast_included && context.travellerType === "self_employed") {
      // Rz. 118 BMF 2020: 20 % of the 24-hour rate at the place of the accommodation, i.e. the day the night begins.
      let part: number;
      if (expense.breakfast_amount !== undefined) {
        part = round2(expense.breakfast_amount * factor);
      } else {
        let rate = context.breakfastRate(expense.date);
        if (rate === undefined) {
          rate = 28;
          warnings.add(
            `${label}: Frühstücksanteil mit Inlandssatz 28 € geschätzt (das Belegdatum ${expense.date} ist kein Reisetag); Datum prüfen oder breakfast_amount angeben.`
          );
        }
        part = round2(0.2 * rate);
      }
      if (part > gross) {
        throw new Error(`${label}: Der Frühstücksbetrag (${part} €) ist größer als der Belegbetrag (${gross} €); breakfast_amount und amount prüfen.`);
      }
      breakfastDeducted = part;
      const share = gross > 0 ? (gross - breakfastDeducted) / gross : 1;
      vat = round2(vat * share);
      gross = round2(gross - breakfastDeducted);
      warnings.add(
        `${label}: Frühstück im Hotelpreis wird als Verpflegung herausgerechnet (Rz. 118 BMF 25.11.2020, 20 % der 24-Stunden-Pauschale ` +
          "oder ausgewiesener Betrag). Auslegung für Selbstständige und Gesellschafter-Geschäftsführer ohne Anstellungsvertrag, vom Steuerberater prüfen lassen."
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

    // § 33 UStDV: the limit applies to the whole receipt (all lines with the same receipt_id), gross before the breakfast deduction.
    const receiptId = expense.receipt_id?.trim() || undefined;
    const group = receiptId ? groups.get(receiptId) : undefined;
    const receiptGross = group ? group.gross : originalGross;
    const vatLabel = group ? `Beleg receipt_id "${group.label}" (zusammen ${receiptGross.toFixed(2).replace(".", ",")} €)` : label;
    const kleinbetrag = receiptGross <= KLEINBETRAG_LIMIT;
    const vorsteuer = vat > 0 && !foreignVat && !receiptMissing && (recipient === "company" || kleinbetrag);
    if (vat > 0 && !foreignVat && !receiptMissing && !vorsteuer) {
      warnings.add(
        recipient === "traveller"
          ? `${vatLabel}: Rechnung auf den Namen des Reisenden und über 250 €: kein Vorsteuerabzug für die Firma (UStAE 15.2a Abs. 3).`
          : `${vatLabel}: Rechnungsempfänger prüfen: bei Rechnungen über 250 € setzt der Vorsteuerabzug eine Rechnung auf die Firma voraus.`
      );
    }
    if (expense.category === "lodging" && expense.breakfast_included) {
      warnings.add(
        `${label}: Frühstück im Hotelpreis. Der Steuersatz im Sammelposten ist nicht eindeutig (Speisen 7 % seit 1.1.2026, UStAE 12.16 Abs. 8 und 12 ` +
          "noch uneinheitlich). Eine Zeile hat genau einen Steuersatz und Steuerbetrag; " +
          (context.travellerType === "employee"
            ? "der Hotelpreis bleibt bei Angestellten ungekürzt (das Frühstück kürzt stattdessen die Verpflegungspauschale am Folgetag). "
            : "ein abgezogener Frühstücksanteil mindert die USt anteilig. ") +
          "Belege mit zwei Steuersätzen als zwei Positionen mit derselben receipt_id erfassen."
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
      ...(receiptId ? { receiptId } : {}),
      paidBy: expense.paid_by ?? "traveller",
    });
  }
  return { lines, warnings: [...warnings] };
}

export function processKmTrips(trips: KmTrip[], context: { tripRange?: TripRange } = {}): { lines: KmLine[]; warnings: string[] } {
  const lines: KmLine[] = [];
  const warnings: string[] = [];
  for (const trip of trips) {
    if (trip.ownership !== "private" && trip.ownership !== "business") {
      throw new Error("ownership (private oder business) beim Nutzer erfragen: die Kilometerpauschale gilt nur für private Fahrzeuge.");
    }
    if (trip.ownership === "business") {
      throw new Error(
        "Die Kilometerpauschale gilt nur für private Fahrzeuge (R 4.12 Abs. 2 EStR). Beim Betriebs-Pkw die tatsächlichen Kosten " +
          "als Beleg (category fare) erfassen."
      );
    }
    if (!isRealDate(trip.date)) throw new Error("Datum der Fahrt im Format YYYY-MM-DD und als echtes Kalenderdatum angeben.");
    if (!Number.isFinite(trip.km) || !(trip.km > 0)) throw new Error("km muss eine Zahl größer 0 sein.");
    const rate = KM_RATES[trip.mode];
    if (outsideTrip(trip.date, context.tripRange)) {
      warnings.push(`Fahrt ${trip.km} km am ${trip.date}: ${outsideTripText(trip.date, context.tripRange as TripRange)}`);
    }
    lines.push({
      mode: trip.mode,
      km: trip.km,
      date: trip.date,
      description: trip.description ?? (trip.mode === "car" ? "Fahrt mit privatem Pkw" : "Fahrt mit privatem Fahrzeug"),
      rate,
      amount: round2(trip.km * rate),
    });
  }
  return { lines, warnings };
}

export function computeTotals(input: {
  allowances: number;
  lodgingFlat: number;
  lines: CostLine[];
  kmLines: KmLine[];
  advance: number;
}): Totals {
  // Lines paid by the company are booked through their own receipt: shown, but not reimbursed.
  const reimbursed = input.lines.filter((l) => l.paidBy !== "company");
  const sum = (category: ExpenseCategory) =>
    round2(reimbursed.filter((l) => l.category === category).reduce((s, l) => s + l.grossEur, 0));
  const companyPaid = round2(input.lines.filter((l) => l.paidBy === "company").reduce((s, l) => s + l.grossEur, 0));
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
    companyPaid,
    total,
    advance: input.advance,
    reimbursement: round2(total - input.advance),
  };
}
