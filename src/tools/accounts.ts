import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import type { BBListResult } from "../bb-client/client.js";
import { defineTool, LIST_OUTPUT_SHAPE, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

export function createAccountsTools(client: BBClient): [ToolDef, ToolDef, ToolDef] {
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
    receipt_creates_transaction: z
      .boolean()
      .optional()
      .describe(
        "A receipt assigned to this account creates a transaction itself (cash, EÜR-Verrechnungskonto, Auslagen-/Prepaid-Konto). " +
          "Works for INBOUND receipts only: outgoing invoices never create a payment, enter those manually (get_booking_guide ausgangsrechnung_kasse)."
      ),
    is_revision_safe: z
      .boolean()
      .optional()
      .describe(
        "Revision-safe (Kassenbuch): payments on this account can never be deleted, only reversed (Storno), and the report " +
          "'Kassenbuch' becomes available, sorted by entry date. Cannot be changed later via API. For a cash account that needs " +
          "a Kassenbuch, and then consider receipt_creates_transaction false (it writes the payment at confirmation time, not in " +
          "receipt-date order)."
      ),
  };

  const createAccount = defineTool({
    name: "create_account",
    description:
      "Create a new basic account (cash register, bank account, or other). Not idempotent — calling " +
      "twice with the same details creates two accounts; check list_accounts first. Change or remove " +
      "it afterwards with manage_account. postingaccount_number must lie in the range permitted for the type (see get_booking_guide " +
      "konten_einrichtung): e.g. bank SKR03 1200-1288 / SKR04 1800-1888, cash 1000-1020 / 1600-1620, sonstiges Basiskonto such as " +
      "Privateinlagen 1890-1899 / 2180-2189. Where the Finanzamt expects a Kassenbuch (\"Kasse\"), use a revision-safe account or " +
      "better an Auslagen/EÜR-Verrechnungskonto (SKR03 1371 / SKR04 1486).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: createAccountShape,
    async handler(args) {
      const result = await client.call("accountsAdd", args);
      return ok(result);
    },
  });

  const manageAccountShape = {
    action: z.enum(["update", "delete"]),
    postingaccount_number: z.number().int().describe("Number of the basic account; it cannot be changed."),
    name: z.string().optional().describe("update only: new name."),
    receipt_creates_transaction: z
      .boolean()
      .optional()
      .describe("update only: a receipt assigned to this account creates a transaction itself. Manual accounts only."),
    is_disabled_in_select: z
      .boolean()
      .optional()
      .describe("update only: hide an unused basic account (e.g. an old bank account) in the account dropdown."),
  };

  const manageAccount = defineTool({
    name: "manage_account",
    description:
      "Update or delete a basic account (cash, bank, other). update changes only the fields you pass; is_revision_safe " +
      "cannot be changed via API. delete is DESTRUCTIVE and only works for an account without confirmed (fixed) " +
      "postings and without revision-safe transactions - otherwise BuchhaltungsButler refuses. An account that was already " +
      "booked on and is no longer used should be hidden (update is_disabled_in_select), not deleted. Check list_accounts first.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: manageAccountShape,
    async handler(args) {
      const { action, ...fields } = args;
      if (action === "delete") {
        const result = await client.call("accountsDelete", { postingaccount_number: fields.postingaccount_number });
        return ok(result);
      }
      const result = await client.call("accountsUpdate", fields);
      return ok(result);
    },
  });

  return [listAccounts, createAccount, manageAccount];
}
