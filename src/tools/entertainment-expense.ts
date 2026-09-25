// Bewirtungskosten (business entertainment expense) posting validation.
//
// Same root risk as travel-expense.ts: an LLM inferring correct bookkeeping
// from formal receipt features instead of checking the facts that actually
// govern it. Here the facts are (a) whether a proper signed Bewirtungsbeleg
// documenting participants and occasion exists (§ 4 Abs. 5 Nr. 2 EStG), and
// (b) whether the mandatory 70/30 deductible/non-deductible split was
// applied — not a judgment call, it applies to every entertainment posting.
//
// Deliberately validates rather than computes: the caller still supplies
// both split amounts (as with every other posting through this connector),
// and this only checks that a paired split exists and that its ratio is
// approximately 70/30. Computing the split here (from a single net amount)
// would mean doing tax-relevant rounding/gross-vs-net math inside the
// connector, which risks a silent miscalculation that's harder to spot than
// a caller-side one — the calling LLM has the fuller context (gross vs. net,
// how VAT was derived) to get that math right in the first place.
//
// Ranges: SKR03 confirmed via the connector's own live posting-accounts
// catalog conventions used elsewhere in this codebase; SKR04 (6640/6644)
// from secondary sources (belege.ai, buchungssatz.de), same caveat as the
// SKR04 travel-expense ranges — worth a sanity check against a real SKR04
// deployment if one becomes available.
const ENTERTAINMENT_ACCOUNTS: Record<number, "deductible" | "non_deductible"> = {
  4650: "deductible",
  6640: "deductible",
  4654: "non_deductible",
  6644: "non_deductible",
};

// Absolute tolerance, not a percentage: a percentage tolerance is too loose
// on small receipts and too tight on large ones for the same rounding cause.
const RATIO_TOLERANCE_EUR = 0.02;
export const DEDUCTIBLE_SHARE = 0.7;

export type EntertainmentKind = "deductible" | "non_deductible";

export interface EntertainmentSplit {
  postingaccount: number;
  amount: string;
}

export interface EntertainmentFields {
  participants?: string;
  occasion?: string;
  host_confirmed?: boolean;
}

export function matchEntertainmentAccount(account: number): EntertainmentKind | undefined {
  return ENTERTAINMENT_ACCOUNTS[account];
}

// Throws if any split is an entertainment-expense account and the required
// documentation fields are missing/false, the deductible/non-deductible
// split isn't paired, or the paired amounts aren't approximately 70/30.
// Returns true if entertainment accounts were involved (for building the
// audit-trail note), or undefined if none of the splits are.
export function assertEntertainmentExpenseFields(
  splits: EntertainmentSplit[],
  fields: EntertainmentFields
): true | undefined {
  const matched = splits
    .map((s) => ({ ...s, kind: matchEntertainmentAccount(s.postingaccount) }))
    .filter((s): s is EntertainmentSplit & { kind: EntertainmentKind } => s.kind !== undefined);
  if (matched.length === 0) return undefined;

  if (!fields.participants) {
    throw new Error(
      `Posting account is a Bewirtungskosten (entertainment-expense) account. "participants" is required — ` +
        `ask the user who was entertained before booking; don't infer it from the invoice address or payment method.`
    );
  }
  if (!fields.occasion) {
    throw new Error(
      `Posting account is a Bewirtungskosten account. "occasion" is required — ask the user for the ` +
        `business occasion before booking.`
    );
  }
  if (fields.host_confirmed !== true) {
    throw new Error(
      `Posting account is a Bewirtungskosten account. "host_confirmed" must be true, confirming a proper ` +
        `signed Bewirtungsbeleg exists (§ 4 Abs. 5 Nr. 2 EStG) — if none exists, ask the user how to proceed ` +
        `instead of booking the standard 70/30 split; don't assume it's fine.`
    );
  }

  const deductibleTotal = matched.filter((s) => s.kind === "deductible").reduce((sum, s) => sum + Number(s.amount), 0);
  const nonDeductibleTotal = matched
    .filter((s) => s.kind === "non_deductible")
    .reduce((sum, s) => sum + Number(s.amount), 0);

  if (deductibleTotal === 0) {
    throw new Error(
      `A non-deductible Bewirtungskosten split (account 4654 / SKR04 6644) was booked without a paired ` +
        `deductible split (account 4650 / SKR04 6640). Add the deductible 70% split before booking.`
    );
  }
  if (nonDeductibleTotal === 0) {
    throw new Error(
      `A deductible Bewirtungskosten split (account 4650 / SKR04 6640) was booked without a paired ` +
        `non-deductible split (account 4654 / SKR04 6644) for the 30% that isn't deductible. Add it before booking.`
    );
  }

  const total = deductibleTotal + nonDeductibleTotal;
  const expectedDeductible = total * DEDUCTIBLE_SHARE;
  if (Math.abs(deductibleTotal - expectedDeductible) > RATIO_TOLERANCE_EUR) {
    throw new Error(
      `Bewirtungskosten split is not the required 70/30 deductible/non-deductible ratio: got ` +
        `${deductibleTotal.toFixed(2)}/${nonDeductibleTotal.toFixed(2)}, expected approximately ` +
        `${expectedDeductible.toFixed(2)}/${(total - expectedDeductible).toFixed(2)} (±${RATIO_TOLERANCE_EUR} EUR).`
    );
  }

  return true;
}

export function formatEntertainmentExpenseNote(fields: { participants: string; occasion: string }): string {
  return `Bewirtung: Teilnehmer: ${fields.participants}, Anlass: ${fields.occasion}`;
}
