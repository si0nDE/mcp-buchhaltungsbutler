// Reisekosten (travel expense) posting-account validation, generic across clients.
//
// A recurring booking mistake: an LLM books a travel receipt onto "Reisekosten
// Arbeitnehmer" (or vice versa) by inferring the traveler's role from the
// invoice address or payment method, instead of checking who actually
// traveled. Getting this wrong is a substantive vGA/tax-deduction risk for a
// Gesellschafter-Geschäftsführer without an employment contract, not just a
// cosmetic miscategorization — so accounts in these ranges require the
// traveler's role and the trip's business purpose to be supplied explicitly.
//
// Ranges cover SKR03 and SKR04 since a deployment of this connector could be
// either. SKR03 was verified against a live chart pulled in this codebase's
// own posting-accounts catalog; the SKR04 boundaries (6650-6668 / 6670-6680)
// come from secondary sources (buchungssatz.de, Haufe) rather than a live
// SKR04 chart — worth a sanity check against a real SKR04 deployment if one
// becomes available.
//
// Deliberately NOT included: which exact sibling account to book instead on a
// mismatch (e.g. 4663 -> 4673). SKR03 happens to offset Arbeitnehmer/
// Unternehmer sub-accounts by a consistent +10, but that pattern isn't
// confirmed for SKR04, so guessing a specific corrected account number here
// would risk stating a wrong number as fact. The error instead names the
// correct band and lets the caller pick the precise account.
const TRAVEL_EXPENSE_BANDS = [
  { role: "employee", label: "Arbeitnehmer", ranges: [[4660, 4668] as const, [6650, 6668] as const] },
  { role: "owner_manager", label: "Unternehmer", ranges: [[4670, 4678] as const, [6670, 6680] as const] },
] as const;

export type TravelerRole = "employee" | "owner_manager" | "unclear";

export interface TravelerFields {
  traveler_name?: string;
  traveler_role?: TravelerRole;
  business_purpose?: string;
}

export interface TravelExpenseMatch {
  role: "employee" | "owner_manager";
  label: string;
}

export function matchTravelExpenseAccount(account: number): TravelExpenseMatch | undefined {
  for (const band of TRAVEL_EXPENSE_BANDS) {
    if (band.ranges.some(([from, to]) => account >= from && account <= to)) {
      return { role: band.role, label: band.label };
    }
  }
  return undefined;
}

function bandByRole(role: "employee" | "owner_manager") {
  return TRAVEL_EXPENSE_BANDS.find((b) => b.role === role)!;
}

function formatRanges(ranges: readonly (readonly [number, number])[]): string {
  return ranges.map(([from, to]) => `${from}-${to}`).join(" / ");
}

// Throws if any account is a travel-expense account and the required fields
// are missing, "unclear", or inconsistent with the account's band. Returns
// the matched band (for building the audit-trail note) or undefined if none
// of the accounts are travel-expense accounts.
export function assertTravelExpenseFields(
  accounts: number[],
  fields: TravelerFields
): TravelExpenseMatch | undefined {
  const matches = accounts.map(matchTravelExpenseAccount).filter((m): m is TravelExpenseMatch => m !== undefined);
  if (matches.length === 0) return undefined;

  const band = matches[0];

  if (!fields.traveler_name) {
    throw new Error(
      `Posting account is a travel-expense account (${band.label}). "traveler_name" is required — ask the ` +
        `user who traveled before booking; don't infer it from the invoice address or payment method.`
    );
  }
  if (!fields.traveler_role || fields.traveler_role === "unclear") {
    throw new Error(
      `Posting account is a travel-expense account (${band.label}). "traveler_role" is required (employee or ` +
        `owner_manager) — ask the user whether the traveler is an employee or an owner/managing shareholder ` +
        `without their own employment contract; don't assume it from the invoice address or payment method.`
    );
  }
  if (!fields.business_purpose) {
    throw new Error(
      `Posting account is a travel-expense account (${band.label}). "business_purpose" is required — ask the ` +
        `user for the business reason for the trip before booking.`
    );
  }
  if (fields.traveler_role !== band.role) {
    const matchedBand = bandByRole(band.role);
    const otherRoleBand = bandByRole(fields.traveler_role);
    throw new Error(
      `Posting account is in the ${band.label} range (${formatRanges(matchedBand.ranges)}), but traveler_role ` +
        `is "${fields.traveler_role}". Use an account in the ${otherRoleBand.label} range ` +
        `(${formatRanges(otherRoleBand.ranges)}) instead, or correct traveler_role.`
    );
  }

  return band;
}

const ROLE_LABEL: Record<"employee" | "owner_manager", string> = {
  employee: "Arbeitnehmer",
  owner_manager: "Unternehmer/Gesellschafter-Geschäftsführer",
};

export function formatTravelExpenseNote(fields: {
  traveler_name: string;
  traveler_role: "employee" | "owner_manager";
  business_purpose: string;
}): string {
  return `Reisekosten: ${fields.traveler_name} (${ROLE_LABEL[fields.traveler_role]}), Anlass: ${fields.business_purpose}`;
}
