import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import type { BBListResult } from "../bb-client/client.js";
import { defineTool, ok, type ToolDef } from "./types.js";

export function createAccountsTools(client: BBClient): [ToolDef, ToolDef] {
  const listAccounts = defineTool({
    name: "list_accounts",
    description: "List all basic accounts (cash, bank, other) configured in BuchhaltungsButler.",
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
    description: "Create a new basic account (cash register, bank account, or other).",
    inputSchema: createAccountShape,
    async handler(args) {
      const result = await client.call("accountsAdd", args);
      return ok(result);
    },
  });

  return [listAccounts, createAccount];
}
