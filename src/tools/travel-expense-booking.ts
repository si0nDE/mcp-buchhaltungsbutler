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
  settlement: string;
  notes: string[];
}

const vatCode = (line: CostLine): VatCode =>
  line.vorsteuer ? (line.vatRate === 19 ? "19_pre" : line.vatRate === 7 ? "7_pre" : "0_none") : "0_none";

export function buildBookingHint(input: {
  travellerType: TravellerType;
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
        "Beleg dem Auslagenkonto zuweisen, Ausgleich über Geldtransit 1360 | 1460. Der Konnektor bucht nicht selbst; jede Buchung bestätigt der Nutzer."
      : "Selbst verauslagte Kosten: Einzelunternehmen über Privateinlagen (1890 | 2180), GmbH über Verbindlichkeiten gegenüber Gesellschaftern " +
        "(730 | 3510), siehe get_booking_guide Thema auslagen. Der Konnektor bucht nicht selbst; jede Buchung bestätigt der Nutzer.";

  const notes = [
    "Verpflegungspauschalen und Pauschalübernachtung ohne Vorsteuer (0_none); ausländische Umsatzsteuer ebenfalls 0_none.",
    "Bewirtung von Geschäftspartnern auf der Reise gehört nicht hierher, sondern auf einen eigenen Bewirtungsbeleg (generate_entertainment_receipt).",
  ];
  if (input.chart === "unknown") {
    notes.push("Kontenrahmen nicht ermittelt oder nicht SKR03: keine Kontonummern genannt; passende Reisekostenkonten per list_posting_accounts suchen.");
  }
  return { chart: input.chart, splits, settlement, notes };
}
