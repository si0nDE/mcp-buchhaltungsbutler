import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { supplyDateWarnings, unbookableRateWarnings, withWarnings } from "./bhb-systematik.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

const invoiceItemShape = z.object({
  name: z.string(),
  amount: z.string(),
  unit: z.string(),
  vat: z.string(),
  single_price: z.string(),
  description: z.string().optional(),
});

const eInvoiceItemShape = z.object({
  name: z.string(),
  amount: z.string(),
  unit: z.string(),
  tax_type: z.string(),
  tax_amount: z.string(),
  single_price: z.string(),
  description: z.string().optional(),
});

function flattenItems<
  T extends { name: string; amount: string; unit: string; single_price: string; description?: string },
>(items: T[], extra: Array<{ key: string; get: (item: T) => string }>): Record<string, string[]> {
  const base: Record<string, string[]> = {
    item_name: items.map((i) => i.name),
    item_amount: items.map((i) => i.amount),
    item_unit: items.map((i) => i.unit),
    item_single_price: items.map((i) => i.single_price),
  };
  for (const { key, get } of extra) {
    base[key] = items.map(get);
  }
  if (items.some((i) => i.description !== undefined)) {
    base.item_description = items.map((i) => i.description ?? "");
  }
  return base;
}

// Optional fields accepted by all three /invoices/create* endpoints
// (invoicesCreate, invoicesCreateDraft, invoicesCreateEInvoice).
const sharedInvoiceFields = {
  type: z.enum(["invoice", "credit", "offer"]),
  show_prices_type: z.enum(["net", "gross"]),
  company_name: z.string(),
  date: z.string(),
  contact_person_name: z.string().optional(),
  additional_addressline: z.string().optional(),
  recurring_interval: z.string().optional(),
  recurring_date_next: z.string().optional(),
  date_of_supply: z
    .string()
    .optional()
    .describe(
      "Leistungsdatum. Only a YYYY-MM-DD date that is not after `date` is taken over as the receipt's " +
        "date_delivery (UStVA by Leistungsdatum); a period text is shown on the PDF only, a later date is ignored."
    ),
  correspondence: z
    .string()
    .optional()
    .describe(
      "Free text on the invoice. A fixed code per tax case (e.g. \"DEnachFR\") placed here or in final_provisions can be " +
        "matched by an Automatisierungsregel on the PDF full text to book the invoice automatically (get_booking_guide automatisierungsregeln)."
    ),
  discount_type: z.string().optional(),
  discount_value: z.string().optional(),
  payment_conditions: z.string().optional(),
  final_provisions: z.string().optional(),
  show_bankdata: z.boolean().optional(),
  show_contactdata: z.boolean().optional(),
  customer_number: z.string().optional(),
  language: z.enum(["de_DE", "en_US"]).optional(),
};

export function createInvoicesTools(client: BBClient): [ToolDef, ToolDef, ToolDef] {
  // invoicenumber/due_days/payment_reference are accepted by invoicesCreate and
  // invoicesCreateEInvoice, but NOT by invoicesCreateDraft - stripped below when draft.
  const createInvoiceShape = {
    ...sharedInvoiceFields,
    street: z.string().optional(),
    zip: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    email: z.string().optional(),
    invoicenumber: z.string().optional(),
    due_days: z.string().optional(),
    payment_reference: z
      .string()
      .optional()
      .describe("Only Amazon order id, PayPal transaction id and Stripe transaction id are supported; then the receipt matches that payment."),
    draft: z.boolean().default(false),
    items: z.array(invoiceItemShape).min(1),
  };

  const createInvoice = defineTool({
    name: "create_invoice",
    description:
      "Create an invoice, credit note, or offer (type selects which). draft: true saves it as a draft " +
      "(invoicesCreateDraft) instead of finalizing it (invoicesCreate); draft mode does not support " +
      "invoicenumber, due_days, or payment_reference (a draft has no date and number until it is finalised; the number is then the " +
      "next one of the account's numbering, which must contain at least one digit). A NEGATIVE total makes BuchhaltungsButler " +
      "label the document a Rechnungskorrektur: then say \"Rechnungskorrektur zur Rechnung Nr. ... vom ...\" in correspondence " +
      "(create_invoice_correction does this for you for a full correction). recurring_interval creates the first invoice at once " +
      "and the next ones from recurring_date_next; stopping a plan is only possible in the UI. Rates 5.5% and 10.7% cannot be " +
      "booked afterwards. For a structured e-invoice (XRechnung/ZUGFeRD), use create_einvoice instead.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: createInvoiceShape,
    async handler(args) {
      const { draft, items, invoicenumber, due_days, payment_reference, ...fields } = args;
      const flattened = flattenItems(items, [{ key: "item_vat", get: (i) => i.vat }]);

      if (draft) {
        const payload = { ...fields, ...flattened };
        const result = await client.call("invoicesCreateDraft", payload);
        return ok(withWarnings(result, [...supplyDateWarnings(fields), ...unbookableRateWarnings(items)]));
      }

      const payload = {
        ...fields,
        ...(invoicenumber !== undefined ? { invoicenumber } : {}),
        ...(due_days !== undefined ? { due_days } : {}),
        ...(payment_reference !== undefined ? { payment_reference } : {}),
        ...flattened,
      };
      const result = await client.call("invoicesCreate", payload);
      return ok(withWarnings(result, [...supplyDateWarnings(fields), ...unbookableRateWarnings(items)]));
    },
  });

  const createEInvoiceShape = {
    ...sharedInvoiceFields,
    street: z.string(),
    zip: z.string(),
    city: z.string(),
    country: z.string(),
    email: z.string(),
    invoicenumber: z.string().optional(),
    due_days: z.string().optional(),
    payment_reference: z.string().optional(),
    e_invoice_id: z.string(),
    items: z.array(eInvoiceItemShape).min(1),
  };

  const createEInvoice = defineTool({
    name: "create_einvoice",
    description:
      "Create a structured e-invoice (e.g. XRechnung/ZUGFeRD) with tax-type/tax-amount line items. " +
      "Requires the full postal address and email in addition to the base invoice fields, and the company master data " +
      "(address, tax number or USt-ID) must be complete in the account. e_invoice_id is the buyer reference (\"0\" if there is none); " +
      "for public contracting authorities it must be the Leitweg-ID the recipient provides. A period of service must be given as its " +
      "last day. For a normal " +
      "PDF invoice, credit note, or offer, use create_invoice instead.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: createEInvoiceShape,
    async handler(args) {
      const { items, ...fields } = args;
      const payload = {
        ...fields,
        ...flattenItems(items, [
          { key: "item_tax_type", get: (i) => i.tax_type },
          { key: "item_tax_amount", get: (i) => i.tax_amount },
        ]),
      };
      const result = await client.call("invoicesCreateEInvoice", payload);
      return ok(withWarnings(result, supplyDateWarnings(fields)));
    },
  });

  const createInvoiceCorrection = defineTool({
    name: "create_invoice_correction",
    description:
      "Create a Rechnungskorrektur for an existing OUTBOUND invoice: a new outbound invoice with all data of the " +
      "original, negated item prices and item names prefixed \"Gutschrift\"; invoice number from the customer's " +
      "number settings, date = today, correspondence text references the original. Find the original's " +
      "id_by_customer with list_receipts (list_direction outbound). Not idempotent - calling twice creates two " +
      "corrections. For a partial credit or other terms use create_invoice with type credit instead.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: { receipt_id_by_customer: z.number().int() },
    async handler(args) {
      const result = await client.call("invoicesInvoiceCorrectionCreate", {
        receipt_id_by_customer: args.receipt_id_by_customer,
      });
      return ok(result);
    },
  });

  return [createInvoice, createEInvoice, createInvoiceCorrection];
}
