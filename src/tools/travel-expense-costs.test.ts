import { describe, expect, it } from "vitest";
import { computeTotals, processExpenses, processKmTrips, type Expense } from "./travel-expense-costs.js";

const hotel = (overrides: Partial<Expense> = {}): Expense => ({
  category: "lodging",
  description: "Hotel Musterstadt",
  date: "2026-03-09",
  amount: 107,
  vat_amount: 7,
  vat_rate: 7,
  invoice_recipient: "company",
  ...overrides,
});
const run = (expenses: Expense[], travellerType: "employee" | "self_employed" = "employee") =>
  processExpenses(expenses, { travellerType, breakfastRate: () => 28 });

describe("processExpenses - amounts and Vorsteuer", () => {
  it("takes net and VAT as printed and allows Vorsteuer for an invoice to the company", () => {
    const { lines } = run([hotel()]);
    expect(lines[0]).toMatchObject({ grossEur: 107, vatEur: 7, netEur: 100, vatRate: 7, vorsteuer: true });
  });

  it("converts foreign currency with the given rate and requires rate and source", () => {
    const { lines } = run([
      hotel({ amount: 100, vat_amount: 0, vat_rate: 0, currency: "USD", fx_rate: 0.9, fx_source: "BMF Monatskurs 03/2026" }),
    ]);
    expect(lines[0].grossEur).toBe(90);
    expect(() => run([hotel({ currency: "USD" })])).toThrow(/Hotel Musterstadt.*fx_rate/);
    expect(() => run([hotel({ currency: "USD", fx_rate: 0.9 })])).toThrow(/fx_source/);
  });

  it("rejects VAT without a rate", () => {
    expect(() => run([hotel({ vat_rate: undefined })])).toThrow(/vat_rate/);
  });

  it("denies Vorsteuer for invoices to the traveller above 250 EUR but allows a Kleinbetrag", () => {
    const big = run([hotel({ amount: 300, vat_amount: 19.63, invoice_recipient: "traveller" })]);
    expect(big.lines[0].vorsteuer).toBe(false);
    expect(big.warnings.some((w) => w.includes("Namen des Reisenden"))).toBe(true);
    const small = run([hotel({ amount: 107, vat_amount: 7, invoice_recipient: "traveller" })]);
    expect(small.lines[0].vorsteuer).toBe(true);
  });

  it("warns when the recipient is unknown above 250 EUR", () => {
    const { warnings } = run([hotel({ amount: 300, vat_amount: 19.63, invoice_recipient: "unknown" })]);
    expect(warnings.some((w) => w.includes("Rechnungsempfänger"))).toBe(true);
  });

  it("foreign VAT: no German Vorsteuer, hint to the refund procedure", () => {
    const { lines, warnings } = run([hotel({ foreign_vat: true })]);
    expect(lines[0]).toMatchObject({ vorsteuer: false, vatEur: 0, netEur: 107 });
    expect(warnings.some((w) => w.includes("30.09."))).toBe(true);
  });

  it("missing receipt: no Vorsteuer, point to Glaubhaftmachung and § 162 AO", () => {
    const { lines, warnings } = run([hotel({ receipt_missing: true })]);
    expect(lines[0].vorsteuer).toBe(false);
    expect(warnings.some((w) => w.includes("§ 162 AO"))).toBe(true);
  });

  it("flight ticket without VAT shown: warning and no Vorsteuer", () => {
    const { lines, warnings } = run([
      { category: "fare", fare_kind: "flight", description: "Flug nach Wien", date: "2026-03-09", amount: 250, vat_amount: 0, vat_rate: 0 },
    ]);
    expect(lines[0].vorsteuer).toBe(false);
    expect(warnings.some((w) => w.includes("§ 26 Abs. 3 UStG"))).toBe(true);
  });

  it("warns once about foreign currency for income tax", () => {
    const { warnings } = run([
      hotel({ currency: "CHF", fx_rate: 1.05, fx_source: "EZB", vat_amount: 0, vat_rate: 0 }),
      hotel({ currency: "CHF", fx_rate: 1.05, fx_source: "EZB", vat_amount: 0, vat_rate: 0, description: "Hotel B" }),
    ]);
    expect(warnings.filter((w) => w.includes("Einkommensteuer")).length).toBe(1);
  });
});

describe("processExpenses - Frühstück im Hotelpreis", () => {
  it("self-employed: deducts the separately shown breakfast including its VAT share", () => {
    const { lines, warnings } = run([hotel({ breakfast_included: true, breakfast_amount: 10.7 })], "self_employed");
    expect(lines[0].grossEur).toBe(96.3);
    expect(lines[0].vatEur).toBe(6.3);
    expect(lines[0].breakfastDeductedEur).toBe(10.7);
    expect(warnings.some((w) => w.includes("Auslegung"))).toBe(true);
  });

  it("self-employed without a separate amount: 20 % of the 24-hour rate", () => {
    const { lines } = run([hotel({ breakfast_included: true })], "self_employed");
    expect(lines[0].breakfastDeductedEur).toBe(5.6);
  });

  it("employee: lodging stays unchanged (the breakfast reduces the allowance instead)", () => {
    const { lines } = run([hotel({ breakfast_included: true })], "employee");
    expect(lines[0].grossEur).toBe(107);
    expect(lines[0].breakfastDeductedEur).toBe(0);
  });

  it("warns that the VAT rate of the breakfast in a lump-sum price is not clear-cut", () => {
    const { warnings } = run([hotel({ breakfast_included: true })], "employee");
    expect(warnings.some((w) => w.includes("Sammelposten") && w.includes("UStAE 12.16"))).toBe(true);
  });
});

describe("processKmTrips", () => {
  it("uses 0.30 EUR for cars and 0.20 EUR for other motor vehicles", () => {
    const { lines } = processKmTrips([
      { mode: "car", km: 100, date: "2026-03-09" },
      { mode: "other_motor", km: 50, date: "2026-03-09" },
    ]);
    expect(lines.map((l) => [l.rate, l.amount])).toEqual([[0.3, 30], [0.2, 10]]);
  });

  it("rejects the flat rate for business vehicles and non-positive distances", () => {
    expect(() => processKmTrips([{ mode: "car", km: 10, date: "2026-03-09", ownership: "business" }])).toThrow(/Betriebs/);
    expect(() => processKmTrips([{ mode: "car", km: 0, date: "2026-03-09" }])).toThrow(/km/);
  });
});

describe("computeTotals", () => {
  it("sums all parts and subtracts the advance", () => {
    const { lines } = run([
      hotel(),
      { category: "fare", fare_kind: "train", description: "Bahn", date: "2026-03-09", amount: 50, vat_amount: 3.27, vat_rate: 7 },
      { category: "incidental", description: "Parken", date: "2026-03-09", amount: 8 },
    ]);
    const km = processKmTrips([{ mode: "car", km: 100, date: "2026-03-09" }]).lines;
    const totals = computeTotals({ allowances: 56, lodgingFlat: 20, lines, kmLines: km, advance: 100 });
    expect(totals).toEqual({
      allowances: 56,
      lodgingFlat: 20,
      km: 30,
      fares: 50,
      lodging: 107,
      incidentals: 8,
      total: 271,
      advance: 100,
      reimbursement: 171,
    });
  });
});
