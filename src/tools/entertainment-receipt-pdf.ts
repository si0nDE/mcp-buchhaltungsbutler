import { DEDUCTIBLE_SHARE } from "./entertainment-expense.js";

// Rejected by real, live-verified BFH rulings as too vague to show the
// business connection required by § 4 Abs. 5 Satz 1 Nr. 2 EStG - used
// verbatim from those decisions, not invented, so the error can point to
// real case law instead of an arbitrary house rule:
//   BFH v. 15.01.1998, IV R 81/96, BStBl II 1998, 263
//   BFH v. 26.02.2004, IV R 50/01, BStBl II 2004, 502
const OCCASION_DENYLIST = new Set([
  "geschäftsessen",
  "geschäftsbesprechung",
  "kontaktpflege",
  "kundenpflege",
  "akquisitionsbesprechung",
  "mandatsbesprechung",
  "arbeitsgespräch",
  "infogespräch",
  "hintergrundgespräch",
  "meeting",
  "besprechung",
]);

const MIN_OCCASION_LENGTH = 15;

// Throws if the occasion is one of the exact phrases German courts have
// already rejected as too vague, or if it's shorter than a reasonable
// minimum regardless of content. Matches on the trimmed, lowercased whole
// string (not a substring) so a genuinely detailed occasion that happens to
// mention "Geschäftsessen" in passing isn't falsely rejected.
export function assertOccasionIsConcrete(occasion: string): void {
  const trimmed = occasion.trim();
  const normalized = trimmed.toLowerCase();
  if (OCCASION_DENYLIST.has(normalized) || trimmed.length < MIN_OCCASION_LENGTH) {
    throw new Error(
      `"${occasion}" ist als Anlass zu unkonkret - der BFH hat genau solche Pauschalformulierungen ` +
        `wiederholt nicht anerkannt (BFH v. 15.01.1998, IV R 81/96, BStBl II 1998, 263; BFH v. 26.02.2004, ` +
        `IV R 50/01, BStBl II 2004, 502). Der Anlass muss so konkret sein, dass ein Außenstehender den ` +
        `geschäftlichen Zusammenhang sofort erkennt - frag nach, worüber inhaltlich gesprochen oder entschieden wurde.`
    );
  }
}

export interface EntertainmentReceiptAmounts {
  foodNet: number;
  foodVat: number;
  drinksNet: number;
  drinksVat: number;
  tip: number;
  kleinunternehmer: boolean;
}

export interface ComputedAmounts {
  grossTotal: number;
  vatTotal: number;
  deductibleBase: number;
  deductible: number;
  nonDeductible: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Only addition happens here - VAT amounts and the two split halves are
// never computed by multiplying a net figure by a rate (see the module doc
// comment on entertainment-receipt.ts for why). Regelbesteuerung splits the
// 70/30 on the net base (food + drinks net, plus tip since it carries no
// VAT); Kleinunternehmer (no separate Vorsteuerabzug at all, so no net/gross
// distinction in their own bookkeeping) splits on the gross base instead.
export function computeAmounts(input: EntertainmentReceiptAmounts): ComputedAmounts {
  const vatTotal = round2(input.foodVat + input.drinksVat);
  const grossTotal = round2(input.foodNet + input.foodVat + input.drinksNet + input.drinksVat + input.tip);
  const netBase = round2(input.foodNet + input.drinksNet + input.tip);
  const deductibleBase = input.kleinunternehmer ? grossTotal : netBase;
  const deductible = round2(deductibleBase * DEDUCTIBLE_SHARE);
  const nonDeductible = round2(deductibleBase - deductible);
  return { grossTotal, vatTotal, deductibleBase, deductible, nonDeductible };
}
