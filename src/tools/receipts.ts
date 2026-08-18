import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { defineTool, ok, type ToolDef } from "./types.js";

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
  };

  const listReceipts = defineTool({
    name: "list_receipts",
    description: "List receipts (Belege), inbound or outbound, with optional filters.",
    inputSchema: listShape,
    async handler(args) {
      const { full, limit, offset, ...filters } = args;
      const result = await client.call<BBListResult>("receiptsGet", {
        ...filters,
        limit: limit ?? 20,
        offset: offset ?? 0,
      });
      return ok(trimList(result.data, SUMMARY_FIELDS, full ?? false));
    },
  });

  const getShape = {
    id_by_customer: z.number().int(),
    get_file: z.boolean().optional(),
  };

  const getReceipt = defineTool({
    name: "get_receipt",
    description: "Get a single receipt by its id_by_customer.",
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
    description: "Create one or more receipts in a single batch call (up to 50).",
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
    description: "Get all transactions assigned to a specific receipt.",
    inputSchema: assignedShape,
    async handler(args) {
      const result = await client.call("receiptsAssignedTransactionsGet", args);
      return ok(result);
    },
  });

  return [listReceipts, getReceipt, createReceipts, uploadReceipt, setReceiptDeleted, getReceiptTransactions];
}
