import { describe, expect, it } from "vitest";
import { computeMixedReceipt, type BusinessPosition, type ReceiptVatLine } from "./mixed-receipt-calc.js";

const vatLines: ReceiptVatLine[] = [
  { vat_rate: 7, net: 15.0, vat: 1.05 },
  { vat_rate: 19, net: 6.22, vat: 1.18 },
];
const positions: BusinessPosition[] = [
  { description: "Milch 1 l", quantity_text: "2 × 0,99 €", gross: 1.98, vat_rate: 7 },
  { description: "Mineralwasser 0,5 l", quantity_text: "6 × 0,49 €", gross: 2.94, vat_rate: 19 },
  { description: "Pfand", quantity_text: "6 × 0,25 €", gross: 1.5, vat_rate: 19 },
];

describe("computeMixedReceipt", () => {
  it("splits gross into net and tax per rate (§ 35 UStDV)", () => {
    const r = computeMixedReceipt(positions, 23.45, vatLines);
    expect(r.rates).toEqual([
      { vat_rate: 7, gross: 1.98, net: 1.85, vat: 0.13 },
      { vat_rate: 19, gross: 4.44, net: 3.73, vat: 0.71 },
    ]);
    expect([r.reimbursement, r.inputVatTotal, r.netTotal, r.privateGross]).toEqual([6.42, 0.84, 5.58, 17.03]);
    expect(r.warnings).toEqual([]);
  });

  it("lets a negative position (Pfandrückgabe) reduce its rate", () => {
    const r = computeMixedReceipt([...positions, { description: "Pfandrückgabe", gross: -0.75, vat_rate: 19 }], 23.45, vatLines);
    expect(r.rates[1]).toEqual({ vat_rate: 19, gross: 3.69, net: 3.1, vat: 0.59 });
    expect(r.reimbursement).toBe(5.67);
  });

  it("rejects VAT lines that do not add up to the receipt total", () => {
    expect(() => computeMixedReceipt(positions, 24.0, vatLines)).toThrow(/MwSt-Zeilen ergeben 23,45 €/);
  });

  it("rejects a position whose rate is not on the receipt", () => {
    expect(() => computeMixedReceipt([{ description: "Buch", gross: 5, vat_rate: 7 }], 7.4, [{ vat_rate: 19, net: 6.22, vat: 1.18 }])).toThrow(
      /Steuersatz 7 % steht nicht in den MwSt-Zeilen/
    );
  });

  it("rejects more business gross per rate than the receipt has", () => {
    expect(() => computeMixedReceipt([{ description: "Wasser", gross: 7.5, vat_rate: 19 }], 23.45, vatLines)).toThrow(/19 %: geschäftlich 7,50 € > Bon 7,40 €/);
  });

  it("rejects duplicate rates in the VAT lines and a reimbursement of zero or less", () => {
    expect(() => computeMixedReceipt(positions, 31.5, [...vatLines, { vat_rate: 7, net: 7.52, vat: 0.53 }])).toThrow(/doppelt/);
    expect(() => computeMixedReceipt([{ description: "Pfandrückgabe", gross: -1, vat_rate: 19 }], 23.45, vatLines)).toThrow(/Erstattung/);
  });

  it("warns above 250 € for the whole receipt", () => {
    const r = computeMixedReceipt([{ description: "Kaffee", gross: 9.99, vat_rate: 7 }], 260.0, [{ vat_rate: 7, net: 242.99, vat: 17.01 }]);
    expect(r.warnings.join(" ")).toMatch(/§ 33 UStDV/);
  });
});
