import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { defineTool, ok, type ToolDef } from "./types.js";

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
    description: "List posting accounts (Buchungskonten / SKR chart of accounts entries).",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: listShape,
    async handler(args) {
      const { full, ...filters } = args;
      const result = await client.call<BBListResult>("settingsGetPostingaccounts", filters);
      return ok(trimList(result.data, SUMMARY_FIELDS, full ?? false));
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
      "Create or update a posting account. parent_postingaccount_number is required for create, ignored for update.",
    annotations: { readOnlyHint: false, destructiveHint: true },
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
