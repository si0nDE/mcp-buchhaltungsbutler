import { formatEuro } from "./entertainment-receipt-pdf.js";

export type VatRate = 0 | 7 | 19;
export const VAT_RATES: readonly VatRate[] = [0, 7, 19];

export interface BusinessPosition {
  description: string;
  quantity_text?: string;
  gross: number; // negative for Pfandrückgabe/Rabatt
  vat_rate: VatRate;
}

export interface ReceiptVatLine {
  vat_rate: VatRate;
  net: number;
  vat: number;
}

export interface RateTotal {
  vat_rate: VatRate;
  gross: number;
  net: number;
  vat: number;
}

export interface MixedReceiptAmounts {
  rates: RateTotal[];
  reimbursement: number;
  netTotal: number;
  inputVatTotal: number;
  receiptTotal: number;
  privateGross: number;
  warnings: string[];
}

export const KLEINBETRAG_LIMIT = 250;
const TOLERANCE = 0.01;

// Kaufmännisch, ,5 vom Nullpunkt weg; the epsilon cuts float residue like 0.1295 stored as 0.12949999.
function round2(value: number): number {
  return (Math.sign(value) * Math.round(Math.abs(value) * 100 + 1e-9)) / 100;
}

export function computeMixedReceipt(positions: BusinessPosition[], receiptTotal: number, vatLines: ReceiptVatLine[]): MixedReceiptAmounts {
  const seen = new Set<VatRate>();
  for (const line of vatLines) {
    if (seen.has(line.vat_rate)) throw new Error(`receipt_vat_lines: Steuersatz ${line.vat_rate} % steht doppelt in den MwSt-Zeilen.`);
    seen.add(line.vat_rate);
  }
  const linesTotal = round2(vatLines.reduce((s, l) => s + l.net + l.vat, 0));
  if (Math.abs(linesTotal - receiptTotal) > TOLERANCE + 1e-9) {
    throw new Error(
      `Die MwSt-Zeilen ergeben ${formatEuro(linesTotal)}, die Bonsumme ist ${formatEuro(receiptTotal)}. ` +
        "Netto und Steuer je Satz und die Summe noch einmal vom Bon ablesen. Es wurde nichts erzeugt."
    );
  }
  const rates: RateTotal[] = [];
  for (const rate of VAT_RATES) {
    const items = positions.filter((p) => p.vat_rate === rate);
    if (items.length === 0) continue;
    const line = vatLines.find((l) => l.vat_rate === rate);
    if (!line) throw new Error(`Steuersatz ${rate} % steht nicht in den MwSt-Zeilen des Bons. Steuersatz der Position prüfen. Es wurde nichts erzeugt.`);
    const gross = round2(items.reduce((s, p) => s + p.gross, 0));
    const bonGross = round2(line.net + line.vat);
    if (gross > bonGross + TOLERANCE + 1e-9) {
      throw new Error(`${rate} %: geschäftlich ${formatEuro(gross)} > Bon ${formatEuro(bonGross)}. Positionen oder MwSt-Zeilen prüfen. Es wurde nichts erzeugt.`);
    }
    const vat = rate === 0 ? 0 : round2((gross * rate) / (100 + rate));
    rates.push({ vat_rate: rate, gross, net: round2(gross - vat), vat });
  }
  const reimbursement = round2(rates.reduce((s, r) => s + r.gross, 0));
  if (reimbursement <= 0) throw new Error(`Die Erstattung wäre ${formatEuro(reimbursement)}: Ohne positiven geschäftlichen Anteil gibt es keinen Auslagenbeleg.`);
  const warnings: string[] = [];
  if (receiptTotal > KLEINBETRAG_LIMIT) {
    warnings.push(
      `Der ganze Bon ist ${formatEuro(receiptTotal)} > ${KLEINBETRAG_LIMIT} €: keine Kleinbetragsrechnung (§ 33 UStDV). ` +
        "Für den Vorsteuerabzug braucht es eine Rechnung mit der Gesellschaft als Empfänger; mit dem Steuerberater klären."
    );
  }
  return {
    rates,
    reimbursement,
    netTotal: round2(rates.reduce((s, r) => s + r.net, 0)),
    inputVatTotal: round2(rates.reduce((s, r) => s + r.vat, 0)),
    receiptTotal,
    privateGross: round2(receiptTotal - reimbursement),
    warnings,
  };
}
