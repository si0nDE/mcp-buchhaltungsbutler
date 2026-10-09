import { z } from "zod";

// Shared by the read tools that return wide rows (list_postings, get_account_ledger, list_receipts).
// compact drops what carries no information for a check - empty values and PDF links - so a
// row shrinks to the fields that are actually filled. Nothing with a value is removed, except
// links, which only come back with include_links.
export const compactShape = {
  compact: z
    .boolean()
    .default(true)
    .describe(
      "Default true: leave out empty fields (oss_*, cost_location, journal_number, ...) and PDF links. Set false for the raw rows."
    ),
  include_links: z.boolean().optional().describe("With compact: keep the PDF links (*_links / *_link). Default false."),
  fields: z
    .array(z.string())
    .optional()
    .describe("Return only these fields per row (e.g. [\"id_by_customer\",\"date\",\"amount\"]). Overrides compact."),
};

export interface CompactOptions {
  compact?: boolean;
  include_links?: boolean;
  fields?: string[];
}

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const isLinkKey = (k: string) => /(^|_)links?$/.test(k);

export function compactRow(row: unknown, opts: CompactOptions): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
  const rec = row as Record<string, unknown>;
  if (opts.fields && opts.fields.length > 0) {
    return Object.fromEntries(opts.fields.filter((f) => f in rec).map((f) => [f, rec[f]]));
  }
  if (opts.compact === false) return rec;
  return Object.fromEntries(
    Object.entries(rec).filter(([k, v]) => !isEmpty(v) && (opts.include_links || !isLinkKey(k)))
  );
}

export function compactRows(rows: unknown, opts: CompactOptions): unknown {
  return Array.isArray(rows) ? rows.map((r) => compactRow(r, opts)) : rows;
}
