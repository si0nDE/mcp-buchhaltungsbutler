import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { defineTool, ok, type ToolDef } from "./types.js";

const SUMMARY_FIELDS = ["postingaccount_number", "name", "email", "city"] as const;

const contactFieldsShape = {
  name: z.string(),
  postingaccount_number: z.string().optional(),
  contact_person_name: z.string().optional(),
  street: z.string().optional(),
  additional_address_line: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  sales_tax_id: z.string().optional(),
  email: z.string().optional(),
  iban: z.string().optional(),
  bic: z.string().optional(),
  customer_number: z.string().optional(),
  due_in_days: z.number().int().optional(),
};

export function createContactsTools(client: BBClient): [ToolDef, ToolDef, ToolDef] {
  const listShape = {
    contact_type: z.enum(["debtor", "creditor"]),
    limit: z.number().int().max(25).default(20),
    offset: z.number().int().default(0),
    full: z.boolean().default(false),
  };

  const listContacts = defineTool({
    name: "list_contacts",
    description: "List debtors (Debitoren) or creditors (Kreditoren).",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: listShape,
    async handler(args) {
      const endpointKey = args.contact_type === "debtor" ? "settingsGetDebtors" : "settingsGetCreditors";
      const result = await client.call<BBListResult>(endpointKey, {
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
      });
      return ok(trimList(result.data, SUMMARY_FIELDS, args.full ?? false));
    },
  });

  const createShape = {
    contact_type: z.enum(["debtor", "creditor"]),
    contacts: z.array(z.object(contactFieldsShape)).min(1),
  };

  const createContacts = defineTool({
    name: "create_contacts",
    description: "Create one or more debtors or creditors in a single batch call.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: createShape,
    async handler(args) {
      const endpointKey = args.contact_type === "debtor" ? "settingsAddBatchDebtors" : "settingsAddBatchCreditors";
      const payloadKey = args.contact_type === "debtor" ? "debtors" : "creditors";
      const result = await client.call(endpointKey, { [payloadKey]: args.contacts });
      return ok(result);
    },
  });

  const updateShape = {
    contact_type: z.enum(["debtor", "creditor"]),
    postingaccount_number: z.number().int(),
    name: z.string().optional(),
    contact_person_name: z.string().optional(),
    street: z.string().optional(),
    additional_address_line: z.string().optional(),
    zip: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    sales_tax_id: z.string().optional(),
    email: z.string().optional(),
    iban: z.string().optional(),
    bic: z.string().optional(),
    customer_number: z.string().optional(),
    due_in_days: z.number().int().optional(),
  };

  const updateContact = defineTool({
    name: "update_contact",
    description: "Update an existing debtor or creditor, identified by postingaccount_number.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: updateShape,
    async handler(args) {
      const { contact_type, customer_number, due_in_days, ...fields } = args;
      if (contact_type === "debtor") {
        const result = await client.call("settingsUpdateDebtor", {
          ...fields,
          ...(customer_number !== undefined ? { customer_number } : {}),
        });
        return ok(result);
      }
      const result = await client.call("settingsUpdateCreditor", {
        ...fields,
        ...(due_in_days !== undefined ? { due_in_days } : {}),
      });
      return ok(result);
    },
  });

  return [listContacts, createContacts, updateContact];
}
