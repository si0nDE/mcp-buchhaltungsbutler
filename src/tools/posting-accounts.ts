import { z } from "zod";
import { createTtlCache, type TtlCache } from "../bb-client/cache.js";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { defineTool, LIST_OUTPUT_SHAPE, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

const SUMMARY_FIELDS = ["postingaccount_number", "name"] as const;
const FULL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const FULL_CATALOG_PAGE_SIZE = 1000;
const FULL_CATALOG_MAX_PAGES = 20;

// Parses a postingaccount_number ("1000", "6815", ...) for range comparison.
// Returns undefined for non-numeric values so callers can exclude them from
// range filtering instead of crashing on NaN comparisons.
function parseAccountNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// The BuchhaltungsButler API now supports limit/offset on this endpoint
// under the client's JSON-body request format (form-encoded requests used to
// have these silently rejected). This pages through the full catalog in
// FULL_CATALOG_PAGE_SIZE-row batches, starting at offset 0 and stopping as
// soon as a page comes back short (fewer rows than the page size signals the
// end of data), so the accumulated result really is the complete catalog —
// not just its first page — with a FULL_CATALOG_MAX_PAGES safety cap in case
// the API ever behaves unexpectedly.
async function fetchFullCatalog(client: BBClient): Promise<BBListResult> {
  const allRows: Record<string, unknown>[] = [];
  let lastPageWasFull = false;
  for (let page = 0; page < FULL_CATALOG_MAX_PAGES; page++) {
    const offset = page * FULL_CATALOG_PAGE_SIZE;
    const result = await client.call<BBListResult>("settingsGetPostingaccounts", {
      limit: FULL_CATALOG_PAGE_SIZE,
      offset,
    });
    allRows.push(...result.data);
    lastPageWasFull = result.data.length >= FULL_CATALOG_PAGE_SIZE;
    if (!lastPageWasFull) break;
  }
  if (lastPageWasFull) {
    console.error(
      `list_posting_accounts: fetchFullCatalog hit its ${FULL_CATALOG_MAX_PAGES}-page safety cap ` +
        `(${allRows.length} rows fetched) while the last page was still full — the cached catalog may be ` +
        "incomplete. Investigate whether FULL_CATALOG_MAX_PAGES needs raising."
    );
  }
  return { success: true, message: "", rows: allRows.length, data: allRows };
}

export function createPostingAccountsTools(client: BBClient): [ToolDef, ToolDef] {
  const fullCatalog: TtlCache<BBListResult> = createTtlCache(FULL_CATALOG_TTL_MS, () =>
    fetchFullCatalog(client)
  );

  const listShape = {
    limit: z.number().int().default(20),
    offset: z.number().int().default(0),
    exclude_postingaccounts: z.boolean().optional(),
    exclude_accounts: z.boolean().optional(),
    exclude_creditors: z.boolean().optional(),
    exclude_debtors: z.boolean().optional(),
    postingaccount_number_from: z.number().int().optional(),
    postingaccount_number_to: z.number().int().optional(),
    search: z.string().optional(),
    refresh: z.boolean().default(false),
    full: z.boolean().default(false),
  };

  const listPostingAccounts = defineTool({
    name: "list_posting_accounts",
    description:
      "List posting accounts (Buchungskonten / SKR chart of accounts entries). Returns the full SKR " +
      "chart-of-accounts template, not just accounts actually booked against by this client — use " +
      "postingaccount_number_from/to or search to narrow down, or full: true for raw records including " +
      "type/parent_postingaccount_number. The full catalog is paged in (1000 rows per request) and cached " +
      "for 24h; filtering (range, search, exclude_*) and pagination happen client-side against that cached, " +
      "complete catalog — pass refresh: true to bypass the cache after an account was added or renamed elsewhere.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: LIST_OUTPUT_SHAPE,
    inputSchema: listShape,
    async handler(args) {
      const result = await fullCatalog.get(args.refresh);
      let rows = result.data;
      if (args.exclude_postingaccounts) rows = rows.filter((r) => r.type !== "postingaccount");
      if (args.exclude_accounts) rows = rows.filter((r) => r.type !== "account");
      if (args.exclude_creditors) rows = rows.filter((r) => r.type !== "creditor");
      if (args.exclude_debtors) rows = rows.filter((r) => r.type !== "debtor");
      if (args.postingaccount_number_from !== undefined) {
        const from = args.postingaccount_number_from;
        rows = rows.filter((r) => {
          const n = parseAccountNumber(r.postingaccount_number);
          return n !== undefined && n >= from;
        });
      }
      if (args.postingaccount_number_to !== undefined) {
        const to = args.postingaccount_number_to;
        rows = rows.filter((r) => {
          const n = parseAccountNumber(r.postingaccount_number);
          return n !== undefined && n <= to;
        });
      }
      if (args.search) {
        const needle = args.search.toLowerCase();
        rows = rows.filter((r) => typeof r.name === "string" && r.name.toLowerCase().includes(needle));
      }
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 20;
      rows = rows.slice(offset, offset + limit);
      return ok(trimList(rows, SUMMARY_FIELDS, args.full ?? false));
    },
  });

  const manageShape = {
    action: z.enum(["create", "update"]),
    name: z.string(),
    postingaccount_number: z.number().int(),
    parent_postingaccount_number: z.number().int().optional(),
  };

  const managePostingAccount = defineTool({
    name: "manage_posting_account",
    description:
      "Create or update a posting account. parent_postingaccount_number is required for create, ignored " +
      "for update. No delete endpoint exists for posting accounts — they can only be created or renamed/reparented.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: manageShape,
    async handler(args) {
      if (args.action === "create") {
        if (args.parent_postingaccount_number === undefined) {
          throw new Error(`"parent_postingaccount_number" is required for action "create"`);
        }
        const result = await client.call("settingsAddPostingaccount", {
          name: args.name,
          postingaccount_number: args.postingaccount_number,
          parent_postingaccount_number: args.parent_postingaccount_number,
        });
        fullCatalog.invalidate();
        return ok(result);
      }
      const result = await client.call("settingsUpdatePostingaccount", {
        name: args.name,
        postingaccount_number: args.postingaccount_number,
      });
      fullCatalog.invalidate();
      return ok(result);
    },
  });

  return [listPostingAccounts, managePostingAccount];
}
