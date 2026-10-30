import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { supplyDateWarnings, unbookableRateWarnings, withWarnings } from "./bhb-systematik.js";
import {
  assertRecurring,
  RECURRING_DESCRIPTION,
  recurringCreatedWarning,
  recurringDryRun,
  recurringEndShape,
  recurringGuardShape,
} from "./recurring.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

const invoiceItemShape = z.object({
  name: z.string(),
  amount: z.string(),
  unit: z.string(),
  vat: z.string(),
  single_price: z.string(),
  description: z.string().optional(),
  tax_type: z
    .enum(["S", "Z", "AE", "K", "G", "E"])
    .optional()
    .describe(
      "Nur bei e_invoice: Steuerart. S = Umsatzsteuer (Satz aus vat, Standard bei vat > 0), Z = 0 %, AE = Reverse Charge (§ 13b), " +
        "K = EU-Lieferung, G = Drittlandslieferung (Export), E = steuerfrei. Bei vat 0 Pflicht, sonst bricht der Konnektor ab."
    ),
});

// E-Rechnung: vat bleibt der Satz, der Konnektor macht daraus tax_type/tax_amount (S mit Satz, sonst die gewählte Art mit 0).
function eInvoiceTax(item: { vat: string; tax_type?: string }, index: number): { type: string; amount: string } {
  const rate = Number(item.vat.replace(",", "."));
  if (!Number.isFinite(rate)) throw new Error(`items[${index}].vat ist keine Zahl: "${item.vat}".`);
  const type = item.tax_type ?? (rate > 0 ? "S" : undefined);
  if (type === undefined) {
    throw new Error(
      `items[${index}]: bei vat 0 braucht eine E-Rechnung tax_type (Z = 0 %, AE = Reverse Charge, K = EU-Lieferung, G = Export, E = steuerfrei).`
    );
  }
  return type === "S" ? { type, amount: item.vat } : { type, amount: "0" };
}

function flattenItems<
  T extends { name: string; amount: string; unit: string; single_price: string; description?: string },
>(items: T[], extra: Array<{ key: string; get: (item: T, index: number) => string }>): Record<string, string[]> {
  const base: Record<string, string[]> = {
    item_name: items.map((i) => i.name),
    item_amount: items.map((i) => i.amount),
    item_unit: items.map((i) => i.unit),
    item_single_price: items.map((i) => i.single_price),
  };
  for (const { key, get } of extra) {
    base[key] = items.map((item, n) => get(item, n));
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

export function createInvoicesTools(client: BBClient): [ToolDef, ToolDef] {
  // invoicenumber/due_days/payment_reference are accepted by invoicesCreate and
  // invoicesCreateEInvoice, but NOT by invoicesCreateDraft - stripped below when draft.
  const createInvoiceShape = {
    ...sharedInvoiceFields,
    street: z.string().optional(),
    zip: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    email: z
      .string()
      .optional()
      .describe(
        "Adresse des Empfängers. BHB speichert und prüft sie, versendet aber nichts: weder die Rechnung noch die Läufe eines Plans " +
          "(beobachtet am 29./30.10.2026, die Spec hat keinen Versand-Endpunkt). Versand nur in der BHB-Oberfläche. Leer lassen, solange der Nutzer nichts anderes verlangt."
      ),
    invoicenumber: z.string().optional(),
    due_days: z.string().optional(),
    payment_reference: z
      .string()
      .optional()
      .describe("Only Amazon order id, PayPal transaction id and Stripe transaction id are supported; then the receipt matches that payment."),
    draft: z.boolean().default(false),
    e_invoice: z
      .boolean()
      .optional()
      .describe(
        "true = E-Rechnung (ZUGFeRD/XRechnung statt reinem PDF; Schalter \"E-Rechnung\" der Oberfläche). Bei Geschäftskunden (B2B) die Regel, bei Privatkunden reicht PDF. " +
          "Pflicht dann: street, zip, city, country, email; kein draft. Versendet wird auch dann nichts."
      ),
    e_invoice_id: z
      .string()
      .optional()
      .describe("Nur bei e_invoice: Referenz beim Käufer / Leitweg-ID (öffentliche Auftraggeber: die Leitweg-ID des Empfängers). Standard \"0\"."),
    items: z.array(invoiceItemShape).min(1),
    ...recurringGuardShape,
    ...recurringEndShape,
    dry_run: z
      .boolean()
      .optional()
      .describe(
        "Legt nichts an und ruft BHB nicht auf: zeigt die Termine (bei Wiederholung alle bis recurring_date_end, ohne Enddatum die nächsten 12), die Summe je Rechnung und " +
          "Hinweise. Die Rechnungsnummern nennt die API vorab nicht."
      ),
  };

  const createInvoice = defineTool({
    name: "create_invoice",
    description:
      "Create an invoice, credit note, or offer (type selects which). draft: true saves it as a draft " +
      "(invoicesCreateDraft) instead of finalizing it (invoicesCreate); draft mode does not support " +
      "invoicenumber, due_days, or payment_reference (a draft has no date and number until it is finalised; the number is then the " +
      "next one of the account's numbering, which must contain at least one digit). A NEGATIVE total makes BuchhaltungsButler " +
      "label the document a Rechnungskorrektur: then say \"Rechnungskorrektur zur Rechnung Nr. ... vom ...\" in correspondence " +
      "(create_invoice_correction does this for you for a full correction). " + RECURRING_DESCRIPTION + " Rates 5.5% and 10.7% cannot be " +
      "booked afterwards. e_invoice: true creates a structured e-invoice (ZUGFeRD/XRechnung) via the e-invoice endpoint: use it for business customers (B2B), " +
      "a plain PDF is fine for consumers (B2C); it needs street, zip, city, country and email, no draft, and items with vat 0 need a tax_type; the company master data " +
      "(address, tax number or USt-ID) must be complete in the account. A period of service must be given as its last day. It sends nothing. " +
      "Not verified: whether later runs of an e-invoice plan are e-invoices again.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: createInvoiceShape,
    async handler(args) {
      const {
        draft,
        items,
        invoicenumber,
        due_days,
        payment_reference,
        dry_run,
        confirm_creates_first_invoice,
        allow_open_ended,
        e_invoice,
        e_invoice_id,
        ...fields
      } = args;
      if (e_invoice) {
        if (draft) throw new Error("e_invoice kennt keinen Entwurf (draft).");
        const missing = (["street", "zip", "city", "country", "email"] as const).filter((k) => !fields[k]?.trim());
        if (missing.length > 0) throw new Error(`E-Rechnung: ${missing.join(", ")} fehlt (Pflicht in der Oberfläche und in der API).`);
      } else {
        if (e_invoice_id !== undefined) throw new Error("e_invoice_id gehört nur zu e_invoice: true.");
        if (items.some((i) => i.tax_type !== undefined)) throw new Error("tax_type gehört nur zu e_invoice: true.");
      }
      const taxes = e_invoice ? items.map((i, n) => eInvoiceTax(i, n)) : [];
      if (dry_run) return ok(recurringDryRun({ ...fields, items, draft }));
      assertRecurring({ ...fields, draft, confirm_creates_first_invoice, allow_open_ended });
      const flattened = e_invoice
        ? flattenItems(items, [
            { key: "item_tax_type", get: (_i, n) => taxes[n].type },
            { key: "item_tax_amount", get: (_i, n) => taxes[n].amount },
          ])
        : flattenItems(items, [{ key: "item_vat", get: (i) => i.vat }]);

      if (draft) {
        const payload = { ...fields, ...flattened };
        const result = await client.call("invoicesCreateDraft", payload);
        return ok(withWarnings(result, [...supplyDateWarnings(fields), ...unbookableRateWarnings(items)]));
      }

      const payload = {
        ...fields,
        ...(e_invoice ? { e_invoice_id: e_invoice_id ?? "0" } : {}),
        ...(invoicenumber !== undefined ? { invoicenumber } : {}),
        ...(due_days !== undefined ? { due_days } : {}),
        ...(payment_reference !== undefined ? { payment_reference } : {}),
        ...flattened,
      };
      let result: unknown;
      try {
        result = await client.call(e_invoice ? "invoicesCreateEInvoice" : "invoicesCreate", payload);
      } catch (err) {
        if (fields.recurring_interval === undefined) throw err;
        // Am 29.10.2026 endete ein Aufruf mit HTTP 500 und hatte die Rechnung trotzdem angelegt (ohne Plan).
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${msg} Bei einer Wiederholungsrechnung kann die erste Rechnung trotz Fehler entstanden sein, der Plan kann fehlen: ` +
            "mit list_receipts (outbound, Gegenpartei, heutiges Datum) prüfen, den Aufruf nicht wiederholen, bevor das geklärt ist, " +
            "und den Nutzer den Plan in der Oberfläche prüfen lassen."
        );
      }
      return ok(
        withWarnings(result, [
          ...supplyDateWarnings(fields),
          ...unbookableRateWarnings(items),
          ...(fields.recurring_interval !== undefined ? [recurringCreatedWarning(fields.recurring_date_end)] : []),
        ])
      );
    },
  });

  const createInvoiceCorrection = defineTool({
    name: "create_invoice_correction",
    description:
      "Create a Rechnungskorrektur for an existing OUTBOUND invoice: a new outbound invoice with all data of the " +
      "original, negated item prices and item names prefixed \"Gutschrift\"; invoice number from the customer's " +
      "number settings, date = today, correspondence text references the original. Find the original's " +
      "id_by_customer with list_receipts (list_direction outbound). Not idempotent - calling twice creates two " +
      "corrections. For a partial credit or other terms use create_invoice with type credit instead. The correction is an " +
      "additional document with its own number that stays active. To cancel an outbound invoice without a counter-document " +
      "(like \"Stornieren\" in the BHB UI) use set_receipt_deleted. When the user says \"stornieren\", ask which one they want " +
      "(get_booking_guide rechnungen_erstellen).",
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

  return [createInvoice, createInvoiceCorrection];
}
