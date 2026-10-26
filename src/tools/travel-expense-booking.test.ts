import { describe, expect, it } from "vitest";
import { buildBookingHint } from "./travel-expense-booking.js";
import type { CostLine, KmLine } from "./travel-expense-costs.js";

const line = (overrides: Partial<CostLine>): CostLine => ({
  category: "lodging",
  description: "Hotel",
  date: "2026-03-09",
  currency: "EUR",
  fxRate: 1,
  grossEur: 107,
  vatEur: 7,
  netEur: 100,
  vatRate: 7,
  vorsteuer: true,
  recipient: "company",
  receiptMissing: false,
  foreignVat: false,
  breakfastDeductedEur: 0,
  ...overrides,
});
const km: KmLine = { mode: "car", km: 100, date: "2026-03-09", description: "Fahrt", rate: 0.3, amount: 30 };
const summary = (travellerType: "employee" | "self_employed", chart: "SKR03" | "unknown") =>
  buildBookingHint({
    travellerType,
    chart,
    allowances: 56,
    lodgingFlat: 20,
    kmLines: [km],
    lines: [
      line({}),
      line({ category: "fare", description: "Bahn", grossEur: 50, vatEur: 3.27, netEur: 46.73 }),
      line({ category: "fare", description: "Flug", grossEur: 250, vatEur: 0, netEur: 250, vatRate: 0, vorsteuer: false }),
      line({ category: "incidental", description: "Parken", grossEur: 8, vatEur: 0, netEur: 8, vatRate: 0, vorsteuer: false }),
    ],
  });

describe("buildBookingHint", () => {
  it("maps employees to 4660-4668 with tax codes per line", () => {
    const hint = summary("employee", "SKR03");
    expect(hint.splits.map((s) => [s.group, s.account, s.vat, s.amount])).toEqual([
      ["allowance", 4664, "0_none", 56],
      ["km", 4668, "0_none", 30],
      ["fare", 4663, "7_pre", 50],
      ["fare", 4663, "0_none", 250],
      ["lodging", 4666, "7_pre", 107],
      ["lodging", 4666, "0_none", 20],
      ["incidental", 4660, "0_none", 8],
    ]);
  });

  it("maps self-employed and managing directors to 4670-4678", () => {
    const hint = summary("self_employed", "SKR03");
    expect(hint.splits.find((s) => s.group === "allowance")?.account).toBe(4674);
    expect(hint.splits.find((s) => s.group === "incidental")?.account).toBe(4676);
    expect(hint.splits.find((s) => s.group === "km")?.account).toBe(4678);
  });

  it("names no account numbers when the chart is unknown", () => {
    const hint = summary("employee", "unknown");
    expect(hint.splits.every((s) => s.account === undefined)).toBe(true);
    expect(hint.chart).toBe("unknown");
  });

  it("sums splits with the same group and tax code", () => {
    const hint = buildBookingHint({
      travellerType: "employee",
      chart: "SKR03",
      allowances: 0,
      lodgingFlat: 0,
      kmLines: [],
      lines: [line({ grossEur: 107 }), line({ grossEur: 53.5, vatEur: 3.5, description: "Hotel 2" })],
    });
    expect(hint.splits).toHaveLength(1);
    expect(hint.splits[0].amount).toBe(160.5);
  });

  it("points to the Auslagen procedure and does not book itself", () => {
    const hint = summary("employee", "SKR03");
    expect(hint.settlement).toContain("auslagen");
    expect(hint.settlement).toContain("bucht nicht selbst");
  });
});
