import { describe, expect, it } from "vitest";
import { round2 } from "./travel-expense-calc.js";
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

describe("processExpenses - vat_rate 0 with a VAT amount", () => {
  it("rejects vat_amount > 0 with vat_rate 0", () => {
    expect(() => run([hotel({ vat_rate: 0, vat_amount: 7 })])).toThrow(/Hotel Musterstadt.*vat_rate/);
  });
  it("accepts vat_rate 0 with vat_amount 0, and discards VAT for foreign VAT or a missing receipt", () => {
    expect(() => run([hotel({ vat_rate: 0, vat_amount: 0 })])).not.toThrow();
    expect(() => run([hotel({ vat_rate: 0, vat_amount: 7, foreign_vat: true })])).not.toThrow();
    expect(() => run([hotel({ vat_rate: 0, vat_amount: 7, receipt_missing: true })])).not.toThrow();
  });
});

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
      { mode: "car", km: 100, date: "2026-03-09", ownership: "private" },
      { mode: "other_motor", km: 50, date: "2026-03-09", ownership: "private" },
    ]);
    expect(lines.map((l) => [l.rate, l.amount])).toEqual([[0.3, 30], [0.2, 10]]);
  });

  it("rejects the flat rate for business vehicles and non-positive distances", () => {
    expect(() => processKmTrips([{ mode: "car", km: 10, date: "2026-03-09", ownership: "business" }])).toThrow(/Betriebs/);
    expect(() => processKmTrips([{ mode: "car", km: 0, date: "2026-03-09", ownership: "private" }])).toThrow(/km/);
  });
});

describe("computeTotals", () => {
  it("sums all parts and subtracts the advance", () => {
    const { lines } = run([
      hotel(),
      { category: "fare", fare_kind: "train", description: "Bahn", date: "2026-03-09", amount: 50, vat_amount: 3.27, vat_rate: 7 },
      { category: "incidental", description: "Parken", date: "2026-03-09", amount: 8 },
    ]);
    const km = processKmTrips([{ mode: "car", km: 100, date: "2026-03-09", ownership: "private" }]).lines;
    const totals = computeTotals({ allowances: 56, lodgingFlat: 20, lines, kmLines: km, advance: 100 });
    expect(totals).toEqual({
      allowances: 56,
      lodgingFlat: 20,
      km: 30,
      fares: 50,
      lodging: 107,
      incidentals: 8,
      companyPaid: 0,
      total: 271,
      advance: 100,
      reimbursement: 171,
    });
  });
});

describe("processExpenses - Fix round 1 (input validation and edge cases)", () => {
  it("does not demand vat_rate when the VAT is discarded anyway", () => {
    for (const flag of [{ receipt_missing: true }, { foreign_vat: true }]) {
      const { lines } = run([hotel({ vat_rate: undefined, ...flag })]);
      expect(lines[0].vatEur).toBe(0);
      expect(lines[0].vorsteuer).toBe(false);
    }
  });

  it("treats exactly 250.00 EUR as Kleinbetrag and 250.01 EUR as above the limit", () => {
    const at = run([hotel({ amount: 250, vat_amount: 16.36, vat_rate: 19, invoice_recipient: "traveller" })]);
    expect(at.lines[0].vorsteuer).toBe(true);
    const above = run([hotel({ amount: 250.01, vat_amount: 16.36, vat_rate: 19, invoice_recipient: "traveller" })]);
    expect(above.lines[0].vorsteuer).toBe(false);
  });

  it("applies the 250 EUR limit to the converted amount", () => {
    const base = { vat_rate: 19 as const, currency: "USD", fx_rate: 0.9, fx_source: "EZB", invoice_recipient: "traveller" as const };
    expect(run([hotel({ ...base, amount: 270, vat_amount: 43.11 })]).lines[0].vorsteuer).toBe(true);
    expect(run([hotel({ ...base, amount: 280, vat_amount: 44.71 })]).lines[0].vorsteuer).toBe(false);
  });

  it("foreign VAT with a Kleinbetrag: no Vorsteuer and no recipient warning", () => {
    const { lines, warnings } = run([hotel({ foreign_vat: true, invoice_recipient: "traveller" })]);
    expect(lines[0].vorsteuer).toBe(false);
    expect(warnings.some((w) => w.includes("Namen des Reisenden") || w.includes("Rechnungsempfänger"))).toBe(false);
  });

  it("flight with printed VAT: no flight warning, follows the recipient rule", () => {
    const flight = (overrides: Partial<Expense>): Expense => ({
      category: "fare", fare_kind: "flight", description: "Flug Inland", date: "2026-03-09", amount: 107, vat_amount: 7, vat_rate: 7, ...overrides,
    });
    const company = run([flight({ invoice_recipient: "company" })]);
    expect(company.lines[0].vorsteuer).toBe(true);
    expect(company.warnings.some((w) => w.includes("§ 26 Abs. 3 UStG"))).toBe(false);
    const traveller = run([flight({ amount: 300, vat_amount: 19.63, invoice_recipient: "traveller" })]);
    expect(traveller.lines[0].vorsteuer).toBe(false);
  });

  it("flight with foreign VAT warns only about the refund procedure", () => {
    const { warnings } = run([
      { category: "fare", fare_kind: "flight", description: "Flug", date: "2026-03-09", amount: 100, vat_amount: 10, vat_rate: 7, foreign_vat: true },
    ]);
    expect(warnings.some((w) => w.includes("§ 26 Abs. 3 UStG"))).toBe(false);
  });

  it("rejects a breakfast amount larger than the receipt and negative amounts; 0 means no deduction", () => {
    expect(() => run([hotel({ breakfast_included: true, breakfast_amount: 200 })], "self_employed")).toThrow(/breakfast_amount/);
    expect(() => run([hotel({ breakfast_included: true, breakfast_amount: -1 })], "self_employed")).toThrow(/breakfast_amount/);
    const { lines } = run([hotel({ breakfast_included: true, breakfast_amount: 0 })], "self_employed");
    expect(lines[0].breakfastDeductedEur).toBe(0);
    expect(lines[0].grossEur).toBe(107);
  });

  it("keeps net = gross - VAT and VAT <= gross after breakfast deduction plus conversion", () => {
    const { lines } = run(
      [hotel({ amount: 99.99, vat_amount: 6.54, currency: "USD", fx_rate: 0.93, fx_source: "EZB", breakfast_included: true, breakfast_amount: 9.99 })],
      "self_employed"
    );
    expect(lines[0].netEur).toBe(round2(lines[0].grossEur - lines[0].vatEur));
    expect(lines[0].vatEur).toBeLessThanOrEqual(lines[0].grossEur);
  });

  it("validates vat_amount and non-finite numbers", () => {
    expect(() => run([hotel({ vat_amount: -1 })])).toThrow(/vat_amount/);
    expect(() => run([hotel({ vat_amount: 200 })])).toThrow(/vat_amount/);
    expect(() => run([hotel({ vat_amount: Number.NaN })])).toThrow(/vat_amount/);
    expect(() => run([hotel({ amount: Number.POSITIVE_INFINITY })])).toThrow(/amount/);
    expect(() => run([hotel({ currency: "USD", fx_rate: Number.POSITIVE_INFINITY, fx_source: "EZB" })])).toThrow(/fx_rate/);
  });

  it("rejects dates that do not exist in the calendar", () => {
    expect(() => run([hotel({ date: "2026-02-31" })])).toThrow(/Datum/);
    expect(() => processKmTrips([{ mode: "car", km: 10, date: "2026-02-31", ownership: "private" }])).toThrow(/Datum/);
  });

  it("totals reimburse the gross of lines with missing receipt or foreign VAT", () => {
    const { lines } = run([hotel({ receipt_missing: true }), hotel({ foreign_vat: true, description: "Hotel B" })]);
    const totals = computeTotals({ allowances: 0, lodgingFlat: 0, lines, kmLines: [], advance: 0 });
    expect(totals.lodging).toBe(214);
    expect(totals.total).toBe(214);
  });
});

describe("processExpenses - receipt_id (one receipt, two VAT rates)", () => {
  const room = hotel({ description: "Hotel Musterstadt Zimmer", amount: 240, vat_amount: 15.7, vat_rate: 7, invoice_recipient: "traveller" });
  const drinks = hotel({ category: "incidental", description: "Hotel Musterstadt Getränke", amount: 30, vat_amount: 4.79, vat_rate: 19, invoice_recipient: "traveller" });

  it("checks the 250 EUR limit against the sum of all lines of the receipt", () => {
    const { lines, warnings } = run([{ ...room, receipt_id: "R-1" }, { ...drinks, receipt_id: "R-1" }]);
    expect(lines.map((l) => l.vorsteuer)).toEqual([false, false]);
    expect(lines.map((l) => l.receiptId)).toEqual(["R-1", "R-1"]);
    expect(warnings.filter((w) => w.includes("Namen des Reisenden"))).toHaveLength(1);
    expect(warnings.some((w) => w.includes("R-1") && w.includes("270"))).toBe(true);
  });

  it("without receipt_id each line stands on its own", () => {
    expect(run([room, drinks]).lines.map((l) => l.vorsteuer)).toEqual([true, true]);
  });

  it("uses the gross before the breakfast deduction for the limit", () => {
    const { lines } = run(
      [{ ...room, amount: 245, breakfast_included: true, receipt_id: "R-2" }, { ...drinks, amount: 10, vat_amount: 1.6, receipt_id: "R-2" }],
      "self_employed"
    );
    expect(lines.map((l) => l.vorsteuer)).toEqual([false, false]);
  });

  it("rejects mixed currencies and different invoice recipients within one receipt_id", () => {
    const chf = { currency: "CHF", fx_rate: 1.05, fx_source: "BMF Monatskurs 03/2026" };
    expect(() => run([{ ...room, receipt_id: "R-3" }, { ...drinks, ...chf, receipt_id: "R-3" }])).toThrow(/receipt_id "R-3".*Währung/);
    expect(() => run([{ ...room, receipt_id: "R-4" }, { ...drinks, invoice_recipient: "company", receipt_id: "R-4" }])).toThrow(
      /receipt_id "R-4".*invoice_recipient/
    );
    expect(() => run([{ ...room, receipt_id: "R-5" }, { ...drinks, paid_by: "company", receipt_id: "R-5" }])).toThrow(/receipt_id "R-5".*paid_by/);
    expect(() => run([{ ...room, paid_by: "company", receipt_id: "R-6" }, { ...drinks, paid_by: "company", receipt_id: "R-6" }])).not.toThrow();
  });
});

describe("processExpenses - ausländische Umsatzsteuer", () => {
  const withCountry = (expenses: Expense[], country: string) =>
    processExpenses(expenses, { travellerType: "employee", breakfastRate: () => 28, countryOfDate: () => country });

  it("the vat_rate error points to foreign_vat", () => {
    expect(() => run([hotel({ vat_rate: undefined })])).toThrow(/foreign_vat: true setzen/);
  });

  it("warns about VAT on a foreign day (French TVA) but still allows it", () => {
    const { lines, warnings } = withCountry([hotel({ description: "Hôtel Exemple Paris", vat_amount: 10, vat_rate: 7 })], "Frankreich");
    expect(lines[0].vorsteuer).toBe(true);
    expect(
      warnings.some((w) => w.includes('Beleg "Hôtel Exemple Paris"') && w.includes("Auslandstag (Frankreich)") && w.includes("foreign_vat: true setzen"))
    ).toBe(true);
  });

  it("warns about VAT in a foreign currency on a domestic day", () => {
    const { warnings } = withCountry([hotel({ currency: "CHF", fx_rate: 1.05, fx_source: "BMF Monatskurs 03/2026" })], "Deutschland");
    expect(warnings.some((w) => w.includes("Fremdwährung (CHF)") && w.includes("foreign_vat: true setzen"))).toBe(true);
  });

  it("does not warn for a domestic EUR receipt, a flagged foreign VAT or a missing receipt", () => {
    const hint = (r: { warnings: string[] }) => r.warnings.some((w) => w.includes("foreign_vat: true setzen"));
    expect(hint(withCountry([hotel()], "Deutschland"))).toBe(false);
    expect(hint(withCountry([hotel({ foreign_vat: true })], "Frankreich"))).toBe(false);
    expect(hint(withCountry([hotel({ receipt_missing: true })], "Frankreich"))).toBe(false);
  });
});

describe("processExpenses - vom Unternehmen gezahlt (paid_by)", () => {
  it("keeps the line but leaves it out of the reimbursement and the category sums", () => {
    const { lines } = run([hotel({ paid_by: "company" }), hotel({ description: "Hotel B" })]);
    expect(lines.map((l) => l.paidBy)).toEqual(["company", "traveller"]);
    const totals = computeTotals({ allowances: 14, lodgingFlat: 0, lines, kmLines: [], advance: 0 });
    expect(totals).toMatchObject({ lodging: 107, companyPaid: 107, total: 121, reimbursement: 121 });
  });

  it("rejects an unknown paid_by", () => {
    expect(() => run([hotel({ paid_by: "boss" as never })])).toThrow(/paid_by/);
  });
});

describe("processExpenses - Frühstück und Hinweise je Reisendem", () => {
  it("self-employed: breakfast part from the 24-hour rate of the night's day, not the next day", () => {
    const { lines } = processExpenses([hotel({ breakfast_included: true })], {
      travellerType: "self_employed",
      breakfastRate: (date) => (date === "2026-03-09" ? 58 : 99),
    });
    expect(lines[0].breakfastDeductedEur).toBe(11.6);
  });

  it("self-employed: warns when the domestic 28 EUR is used because no trip day matches", () => {
    const { lines, warnings } = processExpenses([hotel({ breakfast_included: true })], { travellerType: "self_employed", breakfastRate: () => undefined });
    expect(lines[0].breakfastDeductedEur).toBe(5.6);
    expect(warnings.some((w) => w.includes("Frühstücksanteil mit Inlandssatz 28 € geschätzt"))).toBe(true);
  });

  it("the breakfast VAT warning matches the traveller type", () => {
    const employee = run([hotel({ breakfast_included: true })], "employee").warnings.find((w) => w.includes("Sammelposten"));
    expect(employee).toContain("Hotelpreis bleibt bei Angestellten ungekürzt");
    expect(employee).not.toContain("abgezogener Frühstücksanteil");
    const self = run([hotel({ breakfast_included: true })], "self_employed").warnings.find((w) => w.includes("Sammelposten"));
    expect(self).toContain("abgezogener Frühstücksanteil mindert die USt anteilig");
  });
});

describe("dates outside the trip and km ownership", () => {
  const tripRange = { from: "2026-03-09", to: "2026-03-11" };

  it("warns per receipt dated before or after the trip, not for receipts within", () => {
    const { warnings } = processExpenses(
      [hotel({ date: "2026-03-01", description: "Bahn Vorverkauf" }), hotel({ date: "2026-03-12", description: "Taxi" }), hotel()],
      { travellerType: "employee", breakfastRate: () => 28, tripRange }
    );
    const outside = warnings.filter((w) => w.includes("außerhalb der Reise"));
    expect(outside).toHaveLength(2);
    expect(outside[0]).toContain("Bahn Vorverkauf");
  });

  it("warns per km trip outside the trip", () => {
    const { warnings } = processKmTrips(
      [
        { mode: "car", km: 10, date: "2026-03-13", ownership: "private" },
        { mode: "car", km: 10, date: "2026-03-10", ownership: "private" },
      ],
      { tripRange }
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("2026-03-13");
  });

  it("requires ownership for km trips", () => {
    expect(() => processKmTrips([{ mode: "car", km: 10, date: "2026-03-09" } as never])).toThrow(
      "ownership (private oder business) beim Nutzer erfragen: die Kilometerpauschale gilt nur für private Fahrzeuge."
    );
  });
});
