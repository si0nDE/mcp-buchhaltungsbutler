import { round2, type TravellerType } from "./travel-expense-calc.js";
import type { CostLine, KmLine } from "./travel-expense-costs.js";

export type BookingGroup = "allowance" | "km" | "fare" | "lodging" | "incidental";
export type Chart = "SKR03" | "unknown";
export type VatCode = "19_pre" | "7_pre" | "0_none";

// SKR03 accounts confirmed in the BuchhaltungsButler catalog (list_posting_accounts, "Reisekosten").
export const SKR03_ACCOUNTS: Record<TravellerType, Record<BookingGroup, number>> = {
  employee: { allowance: 4664, km: 4668, fare: 4663, lodging: 4666, incidental: 4660 },
  self_employed: { allowance: 4674, km: 4678, fare: 4673, lodging: 4676, incidental: 4676 },
};

const GROUP_ORDER: BookingGroup[] = ["allowance", "km", "fare", "lodging", "incidental"];
const GROUP_TEXT: Record<BookingGroup, string> = {
  allowance: "Verpflegungsmehraufwand",
  km: "Kilometergeld",
  fare: "Fahrtkosten",
  lodging: "Übernachtung",
  incidental: "Reisenebenkosten",
};

export interface BookingSplit {
  group: BookingGroup;
  account?: number;
  vat: VatCode;
  /** Gross amount; the tax code determines the Vorsteuer part. */
  amount: number;
  text: string;
}

export interface BookingHint {
  chart: Chart;
  splits: BookingSplit[];
  /** Fields the posting tools require on the travel-expense accounts 4660-4678 (see travel-expense.ts). */
  posting_fields: { traveler_name: string; traveler_role: "employee" | "owner_manager"; business_purpose: string };
  settlement: string;
  notes: string[];
}

const vatCode = (line: CostLine): VatCode =>
  line.vorsteuer ? (line.vatRate === 19 ? "19_pre" : line.vatRate === 7 ? "7_pre" : "0_none") : "0_none";

export function buildBookingHint(input: {
  travellerType: TravellerType;
  travellerName: string;
  purpose: string;
  chart: Chart;
  allowances: number;
  lodgingFlat: number;
  kmLines: KmLine[];
  lines: CostLine[];
}): BookingHint {
  const sums = new Map<string, { group: BookingGroup; vat: VatCode; amount: number }>();
  const add = (group: BookingGroup, vat: VatCode, amount: number) => {
    if (amount <= 0) return;
    const key = `${group}|${vat}`;
    const current = sums.get(key) ?? { group, vat, amount: 0 };
    current.amount = round2(current.amount + amount);
    sums.set(key, current);
  };

  add("allowance", "0_none", input.allowances);
  add("km", "0_none", round2(input.kmLines.reduce((s, l) => s + l.amount, 0)));
  for (const line of input.lines) add(line.category, vatCode(line), line.grossEur);
  add("lodging", "0_none", input.lodgingFlat);

  const splits = [...sums.values()]
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
    .map<BookingSplit>((s) => ({
      group: s.group,
      ...(input.chart === "SKR03" ? { account: SKR03_ACCOUNTS[input.travellerType][s.group] } : {}),
      vat: s.vat,
      amount: s.amount,
      text: `Reisekosten: ${GROUP_TEXT[s.group]}`,
    }));

  const settlement =
    input.travellerType === "employee"
      ? "Erstattung an die mitarbeitende Person über das Auslagen-Verfahren von BuchhaltungsButler (get_booking_guide Thema auslagen): " +
        "bei regelmäßigen Auslagen ein Sonstiges Basiskonto als Auslagenkonto anlegen (create_account, type other, receipt_creates_transaction true); " +
        "der dem Konto zugewiesene Beleg erzeugt die Zahlung. Erstattung: Bankabgang gegen Geldtransit 1360 (SKR03) | 1460 (SKR04) und eine " +
        "manuelle Zahlung in gleicher Höhe als Zahlungseingang auf dem Auslagenkonto, ebenfalls gegen Geldtransit. " +
        "Der Konnektor bucht nicht selbst; jede Buchung bestätigt der Nutzer."
      : "Selbst verauslagte Kosten (get_booking_guide Thema auslagen): mit Sonstigem Basiskonto als Auslagenkonto (create_account, type other, " +
        "receipt_creates_transaction true) wie bei Angestellten; Erstattung über Geldtransit 1360 (SKR03) | 1460 (SKR04). Ohne Basiskonto: " +
        "Einzelunternehmen Aufwand an Privateinlagen 1890 (SKR03) | 2180 (SKR04) (laut Guide zusätzlich 2190 prüfen), GmbH Aufwand an " +
        "Verbindlichkeiten gegenüber Gesellschaftern 730 (SKR03) | 3510 (SKR04). " +
        "Der Konnektor bucht nicht selbst; jede Buchung bestätigt der Nutzer.";

  const notes = [
    "Verpflegungspauschalen und Pauschalübernachtung ohne Vorsteuer (0_none); ausländische Umsatzsteuer ebenfalls 0_none.",
    "Bewirtung von Geschäftspartnern auf der Reise gehört nicht hierher, sondern auf einen eigenen Bewirtungsbeleg (generate_entertainment_receipt).",
  ];
  notes.push(
    "add_receipt_postings/add_transaction_postings verlangen auf diesen Konten traveler_name, traveler_role und business_purpose (siehe posting_fields)."
  );
  if (input.chart === "unknown") {
    notes.push("Kontenrahmen nicht ermittelt oder nicht SKR03: keine Kontonummern genannt; passende Reisekostenkonten per list_posting_accounts suchen.");
  }
  const posting_fields = {
    traveler_name: input.travellerName,
    traveler_role: input.travellerType === "employee" ? ("employee" as const) : ("owner_manager" as const),
    business_purpose: input.purpose,
  };
  return { chart: input.chart, splits, posting_fields, settlement, notes };
}
