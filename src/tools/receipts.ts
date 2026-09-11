import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

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

export function createReceiptsTools(client: BBClient): [ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef] {
  const listShape = {
    list_direction: z.enum(["inbound", "outbound"]),
    payment_status: z.enum(["paid", "unpaid"]).optional(),
    counterparty: z.string().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    limit: z.number().int().max(500).default(20),
    offset: z.number().int().default(0),
    deleted: z.boolean().optional(),
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
      const { full, limit, offset, counterparty, ...filters } = args;

      if (counterparty === undefined) {
        const result = await client.call<BBListResult>("receiptsGet", {
          ...filters,
          limit: limit ?? 20,
          offset: offset ?? 0,
        });
        return ok(trimList(result.data, SUMMARY_FIELDS, full ?? false));
      }

      const needle = counterparty.toLowerCase();
      const allRows: Record<string, unknown>[] = [];
      let truncated = false;
      for (let page = 0; page < COUNTERPARTY_SWEEP_MAX_PAGES; page++) {
        const result = await client.call<BBListResult>("receiptsGet", {
          ...filters,
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
      const paged = matched.slice(offset ?? 0, (offset ?? 0) + (limit ?? 20));
      return ok(trimList(paged, SUMMARY_FIELDS, full ?? false), truncated ? { truncated } : undefined);
    },
  });

  const getShape = {
    id_by_customer: z.number().int(),
    get_file: z.boolean().optional(),
  };

  const getReceipt = defineTool({
    name: "get_receipt",
    description: "Get a single receipt by its id_by_customer.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: getShape,
    async handler(args) {
      const { id_by_customer, ...rest } = args;
      const result = await client.call("receiptsGetIdByCustomer", rest, { idSuffix: id_by_customer });
      return ok(result);
    },
  });

  const receiptEntryShape = z.object({
    type: RECEIPT_TYPE,
    counterparty: z.string(),
    invoice_number: z.string(),
    date: z.string(),
    amount: z.number(),
    currency: z.string(),
    vat_rate: z.number().optional(),
    account: z.number().int().optional(),
    creditor_debtor: z.number().int().optional(),
    payment_reference: z.string().optional(),
    date_delivery: z.string().optional(),
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
      "with the same details creates duplicates.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: createShape,
    async handler(args) {
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
    currency: z.string().optional(),
    vat_rate: z.number().optional(),
    payment_reference: z.string().optional(),
    date_delivery: z.string().optional(),
    date_payment_due: z.string().optional(),
    link_to_receipt_id_by_customer: z.number().int().optional(),
  };

  const uploadReceipt = defineTool({
    name: "upload_receipt",
    description:
      "Upload a receipt file (base64-encoded PDF/XML/image) for OCR-assisted processing, with optional known metadata.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: uploadShape,
    async handler(args) {
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
    description: "Mark a receipt as deleted (deleted: true) or restore it (deleted: false).",
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

  return [listReceipts, getReceipt, createReceipts, uploadReceipt, setReceiptDeleted, getReceiptTransactions];
}
