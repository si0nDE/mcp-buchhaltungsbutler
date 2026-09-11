import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import type { BBListResult } from "../bb-client/client.js";
import { defineTool, LIST_OUTPUT_SHAPE, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

export function createAccountsTools(client: BBClient): [ToolDef, ToolDef] {
  const listAccounts = defineTool({
    name: "list_accounts",
    description:
      "List accounts configured in BuchhaltungsButler: cash registers, bank accounts, and \"other\" " +
      "accounts — this can include non-bank postingaccounts BuchhaltungsButler classifies as \"account\" " +
      "type, such as shareholder-liability accounts. Not the full SKR chart of accounts; use " +
      "list_posting_accounts for that.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: LIST_OUTPUT_SHAPE,
    inputSchema: {},
    async handler() {
      const result = await client.call<BBListResult>("accountsGet", {});
      return ok(result.data);
    },
  });

  const createAccountShape = {
    type: z.enum(["cash", "bank/institution", "other"]),
    name: z.string(),
    postingaccount_number: z.number().int(),
    receipt_creates_transaction: z.boolean().optional(),
    is_revision_safe: z.boolean().optional(),
  };

  const createAccount = defineTool({
    name: "create_account",
    description:
      "Create a new basic account (cash register, bank account, or other). Not idempotent — calling " +
      "twice with the same details creates two accounts; check list_accounts first. No update or " +
      "delete endpoint exists for accounts afterward.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: createAccountShape,
    async handler(args) {
      const result = await client.call("accountsAdd", args);
      return ok(result);
    },
  });

  return [listAccounts, createAccount];
}
