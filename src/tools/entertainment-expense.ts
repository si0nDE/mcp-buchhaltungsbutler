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

// "gross_split" (default): both accounts in one call, ratio checked on the
// booked amounts. "net_reclass": 4650/6640 booked alone with the full amount
// and input VAT; the 30 % is reclassified afterwards (4654 an 4650, ohne USt)
// via add_free_postings - the connector only validates and hints, it never
// books the reclass itself.
export type EntertainmentSplitMode = "gross_split" | "net_reclass";

export interface EntertainmentFields {
  participants?: string;
  occasion?: string;
  host_confirmed?: boolean;
  entertainment_split_mode?: EntertainmentSplitMode;
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

  if (fields.entertainment_split_mode === "net_reclass") {
    const nonDeductible = matched.filter((s) => s.kind === "non_deductible");
    if (nonDeductible.length > 0) {
      throw new Error(
        `entertainment_split_mode "net_reclass" books only the deductible account (4650 / SKR04 6640) with the ` +
          `full amount; remove the non-deductible split (4654 / SKR04 6644) from this call - the 30% is ` +
          `reclassified afterwards via add_free_postings (see entertainment_reclass_hints). Use ` +
          `"gross_split" to book both accounts in one call.`
      );
    }
    return true;
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

const round2 = (value: number) => Math.round(value * 100) / 100;

// Only plain input-VAT/no-VAT codes map cleanly from a gross amount to a net
// amount; reverse-charge and similar codes do not.
const NET_FACTOR_BY_VAT_CODE: Record<string, number> = {
  "0_none": 1,
  "7_vat": 1.07,
  "19_vat": 1.19,
  "7_pre": 1.07,
  "19_pre": 1.19,
  "7_pre_app": 1.07,
  "19_pre_app": 1.19,
};

export interface EntertainmentReclassHint {
  net_total: string | null;
  postingaccount_debit: number;
  postingaccount_credit: number;
  amount: string | null;
  vat: "0_none";
  note: string;
}

// The 30 % non-deductible share of the NET amount (booked amounts are gross;
// net is derived from each split's VAT code). Hint only - nothing is booked.
export function computeEntertainmentReclass(
  splits: Array<{ postingaccount: number; amount: string; vat: string }>
): EntertainmentReclassHint | undefined {
  const deductible = splits.filter((s) => matchEntertainmentAccount(s.postingaccount) === "deductible");
  if (deductible.length === 0) return undefined;
  const skr04 = deductible.some((s) => s.postingaccount === 6640);
  const accounts = skr04 ? { debit: 6644, credit: 6640 } : { debit: 4654, credit: 4650 };

  let net: number | null = 0;
  for (const s of deductible) {
    const factor = NET_FACTOR_BY_VAT_CODE[s.vat];
    if (factor === undefined) {
      net = null;
      break;
    }
    net += Number(s.amount) / factor;
  }
  const netTotal = net === null ? null : round2(net);
  const amount = netTotal === null ? null : round2(netTotal - round2(netTotal * DEDUCTIBLE_SHARE));
  return {
    net_total: netTotal === null ? null : netTotal.toFixed(2),
    postingaccount_debit: accounts.debit,
    postingaccount_credit: accounts.credit,
    amount: amount === null ? null : amount.toFixed(2),
    vat: "0_none",
    note:
      "Nicht automatisch gebucht. Umbuchung der nicht abziehbaren 30 % vom Netto per add_free_postings " +
      `(Soll ${accounts.debit} an Haben ${accounts.credit}, vat 0_none)` +
      (amount === null ? "; Netto konnte aus den USt-Codes nicht ermittelt werden - Betrag manuell berechnen." : "."),
  };
}

// BuchhaltungsButler accepts comment_text of 2-210 characters and rejects
// anything else with HTTP 400 "invalid comment_text specified". Counted in
// UTF-8 bytes to stay safe for umlauts.
export const COMMENT_MAX_BYTES = 210;

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

export function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const ellipsis = "…";
  const budget = maxBytes - byteLength(ellipsis);
  let out = "";
  for (const char of text) {
    if (byteLength(out) + byteLength(char) > budget) break;
    out += char;
  }
  return out.trimEnd() + ellipsis;
}

// Shortens participants first (at most ~40 % of the room unless the occasion
// is short), keeping the concrete occasion as intact as possible. The full
// wording lives on the Bewirtungsangaben page itself; this comment is the
// audit-trail pointer.
export function formatEntertainmentExpenseNote(fields: { participants: string; occasion: string }): string {
  const prefix = "Bewirtung: Teilnehmer: ";
  const separator = ", Anlass: ";
  const budget = COMMENT_MAX_BYTES - byteLength(prefix) - byteLength(separator);
  if (byteLength(fields.participants) + byteLength(fields.occasion) <= budget) {
    return `${prefix}${fields.participants}${separator}${fields.occasion}`;
  }
  const participantsMax = Math.max(Math.floor(budget * 0.4), budget - byteLength(fields.occasion));
  const participants = truncateToBytes(fields.participants, participantsMax);
  const occasion = truncateToBytes(fields.occasion, budget - byteLength(participants));
  return `${prefix}${participants}${separator}${occasion}`;
}
