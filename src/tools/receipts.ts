import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { assertDeliveryDate, DATE_DELIVERY_GUIDE } from "./bhb-systematik.js";
import { extractReceiptText } from "./receipt-text-extraction.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

interface ReceiptGetResult {
  data?: {
    file_content?: string;
    file_type?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// The API's counterparty filter matches exactly, not as a substring, so a
// caller searching for "Musterfirma" by typing "Muster" gets zero results
// even though matching receipts exist. When counterparty is given, we instead
// sweep every page (dropping counterparty from the request), filter locally,
// and only then apply the caller's limit/offset — otherwise results past the
// first server-side page would be silently missed.
const COUNTERPARTY_SWEEP_PAGE_SIZE = 500;
const COUNTERPARTY_SWEEP_MAX_PAGES = 20;

const LIST_RECEIPTS_OUTPUT_SHAPE = {
  data: z.array(z.record(z.string(), z.unknown())),
  truncated: z
    .boolean()
    .optional()
    .describe(
      `True if the counterparty sweep hit its ${COUNTERPARTY_SWEEP_MAX_PAGES}-page cap before scanning ` +
        "all receipts in range — matches may have been missed. Narrow date_from/date_to and retry."
    ),
};

const SUMMARY_FIELDS = [
  "id_by_customer",
  "type",
  "date",
  "counterparty",
  "amount",
  "invoicenumber",
  "due_date",
  "deleted",
] as const;

const RECEIPT_TYPE = z.enum(["invoice inbound", "invoice outbound", "credit inbound", "credit outbound"]);

export function createReceiptsTools(client: BBClient): [ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef] {
  const listShape = {
    list_direction: z
      .enum(["inbound", "outbound", "both"])
      .describe('"both" runs inbound and outbound in one call; every row then carries its direction in list_direction.'),
    payment_status: z.enum(["paid", "unpaid"]).optional(),
    counterparty: z.string().optional(),
    invoicenumber: z.string().optional().describe("Exact invoice number: the duplicate check before creating or uploading a receipt."),
    due_date: z.string().optional().describe("YYYY-MM-DD, receipts with this due date."),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    limit: z.number().int().max(500).default(20),
    offset: z.number().int().default(0),
    deleted: z.boolean().optional(),
    date_since_last_modified: z
      .string()
      .optional()
      .describe("'YYYY-MM-DD HH:MM:SS' (date only = 23:59:59): only receipts changed after that moment - for incremental sync."),
    include_offers: z.boolean().optional().describe("Also include offers (Angebote). Default false."),
    full: z.boolean().default(false),
    order: z
      .object({
        date: z.enum(["ASC", "DESC"]).optional(),
        amount: z.enum(["ASC", "DESC"]).optional(),
        invoicenumber: z.enum(["ASC", "DESC"]).optional(),
        invoicingparty: z.enum(["ASC", "DESC"]).optional(),
      })
      .optional()
      .describe('Sort order, e.g. {"date": "ASC"} or {"date": "ASC", "amount": "DESC"}.'),
  };

  type ListFilters = Omit<z.infer<z.ZodObject<typeof listShape>>, "list_direction" | "full" | "limit" | "offset" | "counterparty">;

  async function fetchDirection(
    direction: "inbound" | "outbound",
    args: ListFilters & { counterparty?: string; limit?: number; offset?: number }
  ): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
    const { counterparty, limit, offset, ...filters } = args;
    if (counterparty === undefined) {
      const result = await client.call<BBListResult>("receiptsGet", {
        ...filters,
        list_direction: direction,
        limit: limit ?? 20,
        offset: offset ?? 0,
      });
      return { rows: result.data, truncated: false };
    }
    const needle = counterparty.toLowerCase();
    const allRows: Record<string, unknown>[] = [];
    let truncated = false;
    for (let page = 0; page < COUNTERPARTY_SWEEP_MAX_PAGES; page++) {
      const result = await client.call<BBListResult>("receiptsGet", {
        ...filters,
        list_direction: direction,
        limit: COUNTERPARTY_SWEEP_PAGE_SIZE,
        offset: page * COUNTERPARTY_SWEEP_PAGE_SIZE,
      });
      allRows.push(...result.data);
      if (result.data.length < COUNTERPARTY_SWEEP_PAGE_SIZE) break;
      if (page === COUNTERPARTY_SWEEP_MAX_PAGES - 1) truncated = true;
    }
    const matched = allRows.filter(
      (r) => typeof r.counterparty === "string" && r.counterparty.toLowerCase().includes(needle)
    );
    return { rows: matched.slice(offset ?? 0, (offset ?? 0) + (limit ?? 20)), truncated };
  }

  async function listOneDirection(
    direction: "inbound" | "outbound",
    args: ListFilters & { counterparty?: string; limit?: number; offset?: number; full?: boolean }
  ) {
    const { full, ...rest } = args;
    const { rows, truncated } = await fetchDirection(direction, rest);
    return ok(trimList(rows, SUMMARY_FIELDS, full ?? false), truncated ? { truncated } : undefined);
  }

  const listReceipts = defineTool({
    name: "list_receipts",
    description:
      "List receipts (Belege), inbound or outbound, with optional filters. counterparty matches as a " +
      "case-insensitive substring (e.g. \"muster\" matches \"Musterfirma GmbH\"), unlike the underlying " +
      "API's exact match — this sweeps every page internally to filter, so results may take longer for " +
      "a wide date range.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: LIST_RECEIPTS_OUTPUT_SHAPE,
    inputSchema: listShape,
    async handler(args) {
      const { full, limit, offset, counterparty, list_direction, ...filters } = args;
      if (list_direction !== "both") {
        return listOneDirection(list_direction, { ...filters, full, limit, offset, counterparty });
      }
      // Without a counterparty filter, offset/limit apply to the merged list: fetch limit+offset
      // from each direction, merge by date and cut afterwards.
      const win = (offset ?? 0) + (limit ?? 20);
      const [inbound, outbound] = await Promise.all(
        (["inbound", "outbound"] as const).map((dir) =>
          fetchDirection(dir, { ...filters, counterparty, limit: win, offset: 0 })
        )
      );
      const tag = (rows: Record<string, unknown>[], dir: string): Record<string, unknown>[] =>
        rows.map((r) => ({ ...r, list_direction: dir }));
      const merged = [...tag(inbound.rows, "inbound"), ...tag(outbound.rows, "outbound")].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
      const paged = merged.slice(offset ?? 0, win);
      const truncated = inbound.truncated || outbound.truncated;
      return ok(
        trimList(paged, [...SUMMARY_FIELDS, "list_direction"], full ?? false),
        truncated ? { truncated } : undefined
      );
    },
  });

  const getShape = {
    id_by_customer: z.number().int(),
    get_file: z.boolean().optional(),
    extract_text: z
      .boolean()
      .optional()
      .describe(
        "For a text-based PDF receipt, return the extracted text as file_text instead of the raw base64 " +
          "file_content - much cheaper on context than get_file alone. Implies fetching the file regardless " +
          "of get_file. Falls back to the normal file_content behavior if the receipt isn't a PDF or nothing " +
          "could be extracted (e.g. a scanned image with no text layer)."
      ),
  };

  const getReceipt = defineTool({
    name: "get_receipt",
    description: "Get a single receipt by its id_by_customer.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: getShape,
    async handler(args) {
      const { id_by_customer, extract_text, ...rest } = args;
      const params = extract_text ? { ...rest, get_file: true } : rest;
      const result = await client.call<ReceiptGetResult>("receiptsGetIdByCustomer", params, {
        idSuffix: id_by_customer,
      });

      if (extract_text && result.data?.file_type === "pdf" && result.data.file_content) {
        const text = await extractReceiptText(result.data.file_content);
        if (text !== undefined) {
          const { file_content, ...restData } = result.data;
          return ok({ ...result, data: { ...restData, file_text: text } });
        }
      }

      return ok(result);
    },
  });

  const receiptEntryShape = z.object({
    type: RECEIPT_TYPE,
    counterparty: z.string(),
    invoice_number: z.string(),
    date: z.string(),
    amount: z.number(),
    currency: z
      .string()
      .describe("API accepts only USD, GBP and CHF here (EUR amounts: see get_booking_guide topic fremdwaehrung); never an empty string."),
    vat_rate: z.number().optional(),
    account: z.number().int().optional(),
    creditor_debtor: z.number().int().optional(),
    payment_reference: z
      .string()
      .optional()
      .describe(
        "Zahlungsreferenz for matching with the payment (PayPal/Amazon/Stripe/eBay orders). Must also be on the payment. " +
          "On a PDF it is only read when it follows a signal word (Referenz, Reference, Zahlungsreferenz, Transaction-id, Zahlungs-ID, Verwendungszweck, Purpose, ...) plus colon/space."
      ),
    date_delivery: z.string().optional().describe(DATE_DELIVERY_GUIDE),
    date_payment_due: z.string().optional(),
    link_to_receipt_id_by_customer: z.number().int().optional(),
  });

  const createShape = {
    receipts: z.array(receiptEntryShape).min(1).max(50),
  };

  const createReceipts = defineTool({
    name: "create_receipts",
    description:
      "Create one or more receipts in a single batch call (up to 50). Not idempotent — calling again " +
      "with the same details creates duplicates, and BuchhaltungsButler does not warn about them: check list_receipts " +
      "(counterparty, invoicenumber) first. date_delivery must not be after date (checked before sending). Every receipt counts " +
      "against the monthly upload quota (500, 1000 for E-Commerce Premium); deleting does not give it back. Pass payment_reference " +
      "for e-commerce receipts so the receipt matches the payment.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: createShape,
    async handler(args) {
      args.receipts.forEach((r, i) => assertDeliveryDate(r, `Beleg ${i + 1} (${r.invoice_number})`));
      const result = await client.call("receiptsAddBatch", { receipts: args.receipts });
      return ok(result);
    },
  });

  const uploadShape = {
    file: z.string(),
    type: RECEIPT_TYPE,
    file_name: z.string().optional(),
    account: z.number().int().optional(),
    creditor_debtor: z.number().int().optional(),
    counterparty: z.string().optional(),
    invoice_number: z.string().optional(),
    date: z.string().optional(),
    amount: z.number().optional(),
    currency: z.string().optional().describe("Only 'EUR' is accepted on upload; a foreign currency is chosen on the receipt in the UI."),
    vat_rate: z.number().optional(),
    payment_reference: z
      .string()
      .optional()
      .describe(
        "Zahlungsreferenz for matching with the payment (PayPal/Amazon/Stripe/eBay orders). Must also be on the payment. " +
          "On a PDF it is only read when it follows a signal word (Referenz, Reference, Zahlungsreferenz, Transaction-id, Zahlungs-ID, Verwendungszweck, Purpose, ...) plus colon/space."
      ),
    date_delivery: z.string().optional().describe(DATE_DELIVERY_GUIDE),
    date_payment_due: z.string().optional(),
    link_to_receipt_id_by_customer: z.number().int().optional(),
  };

  const uploadReceipt = defineTool({
    name: "upload_receipt",
    description:
      "Upload a receipt file (base64-encoded PDF/XML/image) for OCR-assisted processing, with optional known metadata. " +
      "Accepted: PDF, JPEG, PNG, TIFF, BMP, GIF, ZUGFeRD (PDF with embedded XML), XRechnung (XML); at most 50 pages and 20 MB. " +
      "OCR only reads the first pages (none from page 4 on: then pass counterparty/date/amount yourself); an abweichendes " +
      "Leistungsdatum is never recognised. On credit notes (Gutschriften, Provisionsabrechnungen) OCR often takes the own company as counterparty " +
      "and a customer number as invoice number: pass counterparty and invoice_number yourself. Receipt fields cannot be changed or marked as checked " +
      "via the API afterwards (get_booking_guide topic belegpruefung). A write-protected PDF fails with 'Datei kann nicht verarbeitet werden': print it to a new PDF. " +
      "Every upload counts against the monthly quota and deleting does not give it back, so do not upload test files. " +
      "BuchhaltungsButler does not warn about a duplicate upload: check list_receipts (counterparty, invoicenumber) first. " +
      "For automatic matching of e-commerce receipts pass payment_reference (the same value must be on the payment).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: uploadShape,
    async handler(args) {
      assertDeliveryDate(args, "Upload");
      const result = await client.call("receiptsUpload", args);
      return ok(result);
    },
  });

  const setDeletedShape = {
    id_by_customer: z.number().int(),
    deleted: z.boolean(),
  };

  const setReceiptDeleted = defineTool({
    name: "set_receipt_deleted",
    description:
      "Mark a receipt as deleted (deleted: true) or restore it (deleted: false). Nothing is deleted physically (GoBD): a deleted " +
      "receipt stays in the archive, is listed with list_receipts deleted: true and can be restored. The upload quota used " +
      "(500 receipts per month, 1000 for E-Commerce Premium) is NOT given back by deleting. A receipt with a fixed " +
      "Debitor/Kreditor booking or a booked assigned payment cannot be deleted before that booking is undone " +
      "(get_booking_guide festgeschriebene_loeschen).",
    annotations: { readOnlyHint: false, destructiveHint: true },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: setDeletedShape,
    async handler(args) {
      const endpointKey = args.deleted ? "receiptsDeleteIdByCustomer" : "receiptsRestoreIdByCustomer";
      const result = await client.call(endpointKey, {}, { idSuffix: args.id_by_customer });
      return ok(result);
    },
  });

  const assignedShape = {
    receipt_id_by_customer: z.number().int(),
    confirmed_only: z.boolean().optional(),
  };

  const getReceiptTransactions = defineTool({
    name: "get_receipt_transactions",
    description:
      "Get all transactions assigned to a specific receipt. For the reverse lookup (transactions -> " +
      "their assigned receipts), use get_transaction_receipts instead.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: assignedShape,
    async handler(args) {
      const result = await client.call("receiptsAssignedTransactionsGet", args);
      return ok(result);
    },
  });

  const overviewShape = {
    receipt_id_by_customer: z.number().int(),
    date_from: z
      .string()
      .optional()
      .describe("YYYY-MM-DD, start of the posting search. Default: 1 January of the receipt's year (a free posting may predate the receipt)."),
    date_to: z.string().optional().describe("YYYY-MM-DD, end of the posting search. Default: 31 December of the year after the receipt."),
  };

  const OVERVIEW_PAGE = 1000;
  const OVERVIEW_MAX_PAGES = 5;

  const getReceiptOverview = defineTool({
    name: "get_receipt_overview",
    description:
      "One answer for 'what is the state of this receipt': metadata (no file), assigned bank transactions, the postings that " +
      "reference it (kind receipt/transaction/free), paid_by_transactions, paid_by_free_postings and open_amount. Replaces " +
      "get_receipt + get_receipt_transactions + a posting search. Postings are searched by period (date_from/date_to, " +
      "up to " + OVERVIEW_MAX_PAGES * OVERVIEW_PAGE + " postings; postings_search_truncated says if that cap was hit). " +
      "Free postings with a receipt do NOT count as payment in BuchhaltungsButler (amount_paid stays 0, the receipt stays " +
      "'teilausgeglichen'). open_amount is BHB's own figure (amount - amount_paid); with Sammelzahlung, Skonto or provider " +
      "fees it is misleading - compare the transaction amounts yourself.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: overviewShape,
    async handler(args) {
      const receiptRes = await client.call<{ data?: Record<string, unknown> }>(
        "receiptsGetIdByCustomer",
        {},
        { idSuffix: args.receipt_id_by_customer }
      );
      // The live API nests the record one level deeper than the spec; accept both.
      const raw = (receiptRes.data as { data?: Record<string, unknown> } | undefined)?.data ?? receiptRes.data ?? {};
      const { file_content, file_type, ...receipt } = raw as Record<string, unknown>;
      const year = Number(String(receipt.date ?? "").slice(0, 4)) || new Date().getFullYear();
      const date_from = args.date_from ?? `${year}-01-01`;
      const date_to = args.date_to ?? `${year + 1}-12-31`;

      const txRes = await client.call<{ data?: Array<Record<string, unknown>> }>("receiptsAssignedTransactionsGet", {
        receipt_id_by_customer: args.receipt_id_by_customer,
      });
      const transactions = txRes.data ?? [];

      const rows: Array<Record<string, unknown>> = [];
      let truncated = false;
      for (let page = 0; page < OVERVIEW_MAX_PAGES; page++) {
        const res = await client.call<{ data?: Array<Record<string, unknown>> }>("postingsGet", {
          date_from,
          date_to,
          posting_status: "all",
          limit: OVERVIEW_PAGE,
          offset: page * OVERVIEW_PAGE,
        });
        const batch = res.data ?? [];
        rows.push(...batch);
        if (batch.length < OVERVIEW_PAGE) break;
        if (page === OVERVIEW_MAX_PAGES - 1) truncated = true;
      }
      const id = String(args.receipt_id_by_customer);
      const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === "";
      const postings = rows
        .filter(
          (p) =>
            String(p.receipt_id_by_customer) === id ||
            String(p.receipts_assigned_ids_by_customer ?? "")
              .split(",")
              .map((x) => x.trim())
              .includes(id)
        )
        .map((p) => ({
          id_by_customer: p.id_by_customer,
          kind: !blank(p.transaction_id_by_customer) ? "transaction" : String(p.receipt_id_by_customer) === id ? "receipt" : "free",
          date: String(p.date ?? "").slice(0, 10),
          postingtext: p.postingtext,
          amount: p.amount,
          debit: p.debit_postingaccount_number,
          credit: p.credit_postingaccount_number,
          vat: p.vat,
          fixed: p.fixed,
        }));

      const sum = (xs: unknown[]) => xs.reduce<number>((a, v) => a + Math.abs(Number(v) || 0), 0);
      const round = (n: number) => Math.round(n * 100) / 100;
      const amount = Number(receipt.amount);
      const paidByTransactions = round(sum(transactions.map((t) => t.amount)));
      const paidByFree = round(sum(postings.filter((p) => p.kind === "free").map((p) => p.amount)));
      const openAmount = Number.isFinite(amount) ? round(Math.abs(amount) - Math.abs(Number(receipt.amount_paid) || 0)) : undefined;
      const notes: string[] = [];
      if (paidByFree > 0) {
        notes.push("Freie Buchungen mit Beleg zählen in BHB nicht als Zahlung: amount_paid und open_amount berücksichtigen sie nicht.");
      }
      if (transactions.length > 0 && Number.isFinite(amount) && Math.abs(paidByTransactions - Math.abs(amount)) > 0.005) {
        notes.push(
          "Die zugeordneten Zahlungen weichen vom Belegbetrag ab (Sammelzahlung, Skonto oder Gebühren?): die Anzeige 'unter-/überzahlt' kann dann falsch sein."
        );
      }
      return ok({
        receipt,
        transactions,
        postings,
        paid_by_transactions: paidByTransactions,
        paid_by_free_postings: paidByFree,
        amount_paid_bhb: receipt.amount_paid,
        open_amount: openAmount,
        postings_period: { date_from, date_to },
        ...(truncated ? { postings_search_truncated: true } : {}),
        ...(notes.length ? { notes } : {}),
      });
    },
  });

  return [listReceipts, getReceipt, createReceipts, uploadReceipt, setReceiptDeleted, getReceiptTransactions, getReceiptOverview];
}
