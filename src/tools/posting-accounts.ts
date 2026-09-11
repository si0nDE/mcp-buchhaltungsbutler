import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { defineTool, LIST_OUTPUT_SHAPE, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

const SUMMARY_FIELDS = ["postingaccount_number", "name", "type", "parent_postingaccount_number"] as const;

export function createPostingAccountsTools(client: BBClient): [ToolDef, ToolDef] {
  const listShape = {
    limit: z.number().int().default(20),
    offset: z.number().int().default(0),
    exclude_postingaccounts: z.boolean().optional(),
    exclude_accounts: z.boolean().optional(),
    exclude_creditors: z.boolean().optional(),
    exclude_debtors: z.boolean().optional(),
    full: z.boolean().default(false),
  };

  const listPostingAccounts = defineTool({
    name: "list_posting_accounts",
    description:
      "List posting accounts (Buchungskonten / SKR chart of accounts entries). The BuchhaltungsButler " +
      "API rejects any query parameter on this endpoint (limit/offset/order/exclude_*), so filtering " +
      "and pagination are applied client-side after fetching the full list.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: LIST_OUTPUT_SHAPE,
    inputSchema: listShape,
    async handler(args) {
      const result = await client.call<BBListResult>("settingsGetPostingaccounts", {});
      let rows = result.data;
      if (args.exclude_postingaccounts) rows = rows.filter((r) => r.type !== "postingaccount");
      if (args.exclude_accounts) rows = rows.filter((r) => r.type !== "account");
      if (args.exclude_creditors) rows = rows.filter((r) => r.type !== "creditor");
      if (args.exclude_debtors) rows = rows.filter((r) => r.type !== "debtor");
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
        return ok(result);
      }
      const result = await client.call("settingsUpdatePostingaccount", {
        name: args.name,
        postingaccount_number: args.postingaccount_number,
      });
      return ok(result);
    },
  });

  return [listPostingAccounts, managePostingAccount];
}
