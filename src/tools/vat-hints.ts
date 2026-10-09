// BHB's account catalog carries no tax information per account, so this is DERIVED from the SKR03 number ranges
// (not confirmed by BHB). It only covers the clear classes; everything else gets no hint rather than a guess.
// The Automatikkonto case (rate in the name) is stronger: such an account passes its tax on by itself.
export interface VatHint {
  vat: string[];
  note: string;
}

const RANGES: Array<[from: number, to: number, hint: VatHint]> = [
  [4100, 4199, { vat: ["0_none"], note: "Löhne/Gehälter: keine Umsatzsteuer." }],
  [4800, 4899, { vat: ["0_none"], note: "Abschreibungen: keine Umsatzsteuer; Anlagen werden in der Anlagenverwaltung (UI) abgeschrieben." }],
  [3000, 4999, { vat: ["19_pre", "7_pre", "0_none"], note: "Aufwandskonto: nur Vorsteuer (_pre), nie 19_vat/7_vat." }],
  [8000, 8999, { vat: ["19_vat", "7_vat", "0_none"], note: "Erlöskonto: nur Umsatzsteuer (_vat), nie 19_pre/7_pre." }],
  [1800, 1899, { vat: ["0_none"], note: "Privatkonto: keine Umsatzsteuer." }],
];

const RATE_IN_NAME = /\b(7|16|19)\s?%/;

// chart: only "SKR03" yields hints. Account numbers of other charts mean something else.
export function vatHint(accountNumber: unknown, name: unknown, chart: "SKR03" | "unknown"): VatHint | undefined {
  if (chart !== "SKR03") return undefined;
  const n = Number(accountNumber);
  if (!Number.isInteger(n)) return undefined;
  const hit = RANGES.find(([from, to]) => n >= from && n <= to)?.[2];
  if (!hit) return undefined;
  if (typeof name === "string" && RATE_IN_NAME.test(name)) {
    return { vat: hit.vat, note: `${hit.note} Name nennt einen Steuersatz: wahrscheinlich ein Automatikkonto, das seine Steuer selbst setzt.` };
  }
  return hit;
}

// SKR03 shows in the catalog as 8400 "Erlöse ..." (SKR04 uses 4400). Account numbers are only 4-8 digits, so the
// check ignores longer numbers.
export function detectChart(rows: Array<Record<string, unknown>>): "SKR03" | "unknown" {
  const row = rows.find((r) => String(r.postingaccount_number) === "8400");
  return row && typeof row.name === "string" && /erl[öo]s/i.test(row.name) ? "SKR03" : "unknown";
}

const PLAIN_VAT = /^(19|7)_(vat|pre)$/;

// Warnings for a booking BEFORE it is sent. Only plain 19/7 _vat/_pre codes are compared; reverse-charge, OSS and
// 0_none are legitimate on many accounts. Chart unknown -> no warnings (never a wrong one).
export function vatWarnings(
  items: Array<{ account: number; vat: string; label: string }>,
  chart: "SKR03" | "unknown",
  // Free postings carry one vat code for the pair; only the Aufwand/Erlös side can take a tax, so the 0_none-only
  // side (Privat, Bank, Löhne, AfA) is not compared.
  taxAccountsOnly = false
): string[] {
  const out: string[] = [];
  for (const { account, vat, label } of items) {
    if (!PLAIN_VAT.test(vat)) continue;
    const hint = vatHint(account, undefined, chart);
    if (taxAccountsOnly && hint && hint.vat.length === 1) continue;
    if (hint && !hint.vat.includes(vat)) {
      out.push(`${label}: vat "${vat}" passt nicht zu Konto ${account}. ${hint.note} Üblich: ${hint.vat.join(", ")}.`);
    }
  }
  return out;
}
