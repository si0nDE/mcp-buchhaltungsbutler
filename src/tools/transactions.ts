import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { defineTool, LIST_OUTPUT_SHAPE, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

const SUMMARY_FIELDS = ["id_by_customer", "to_from", "amount", "booking_date", "purpose"] as const;

export function createTransactionsTools(
  client: BBClient
): [ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef] {
  const listShape = {
    id_by_customer_from: z.number().int().optional(),
    id_by_customer_to: z.number().int().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    account: z.number().int().optional(),
    to_from: z.string().optional(),
    limit: z.number().int().max(500).default(20),
    offset: z.number().int().default(0),
    full: z.boolean().default(false),
  };

  const listTransactions = defineTool({
    name: "list_transactions",
    description: "List bank/cash transactions, with optional filters.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: LIST_OUTPUT_SHAPE,
    inputSchema: listShape,
    async handler(args) {
      const { full, limit, offset, ...filters } = args;
      const result = await client.call<BBListResult>("transactionsGet", {
        ...filters,
        limit: limit ?? 20,
        offset: offset ?? 0,
      });
      return ok(trimList(result.data, SUMMARY_FIELDS, full ?? false));
    },
  });

  const getShape = { id_by_customer: z.number().int() };

  const getTransaction = defineTool({
    name: "get_transaction",
    description: "Get a single transaction by its id_by_customer.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: getShape,
    async handler(args) {
      const result = await client.call("transactionsGetIdByCustomer", {}, { idSuffix: args.id_by_customer });
      return ok(result);
    },
  });

  const transactionEntryShape = z.object({
    account: z.number().int(),
    to_from: z.string(),
    amount: z.number(),
    booking_date: z.string(),
    value_date: z.string().optional(),
    account_number: z.string().optional(),
    bank_code: z.string().optional(),
    bank_name: z.string().optional(),
    purpose: z.string().optional(),
    type: z.string().optional(),
    booking_text: z.string().optional(),
    payment_reference: z.string().optional(),
    currency: z.string().optional(),
  });

  const createShape = {
    transactions: z.array(transactionEntryShape).min(1).max(50),
  };

  const createTransactions = defineTool({
    name: "create_transactions",
    description:
      "Add one or more transactions to a payment account in a single batch call (up to 50). Not " +
      "idempotent — calling again with the same details creates duplicates.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: createShape,
    async handler(args) {
      const result = await client.call("transactionsAddBatch", { transactions: args.transactions });
      return ok(result);
    },
  });

  const assignmentShape = z.object({
    transaction_id_by_customer: z.number().int(),
    receipt_id_by_customer: z.number().int(),
  });

  const assignShape = {
    assignments: z.array(assignmentShape).min(1).max(50),
  };

  const assignReceiptsToTransactions = defineTool({
    name: "assign_receipts_to_transactions",
    description: "Assign one or more receipts to transactions in a single batch call (up to 50).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: assignShape,
    async handler(args) {
      const result = await client.call("transactionsAssignBatchReceipt", {
        transactions_to_receipts: args.assignments,
      });
      return ok(result);
    },
  });

  const unassignShape = {
    transaction_id_by_customer: z.number().int(),
    receipt_id_by_customer: z.number().int(),
  };

  const unassignReceipt = defineTool({
    name: "unassign_receipt",
    description: "Remove the assignment of a specific receipt from a transaction.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: unassignShape,
    async handler(args) {
      const result = await client.call("transactionsUnassignReceipt", args);
      return ok(result);
    },
  });

  const assignedShape = {
    transaction_id_by_customer: z.number().int(),
    confirmed_only: z.boolean().optional(),
  };

  const getTransactionReceipts = defineTool({
    name: "get_transaction_receipts",
    description:
      "Get all receipts assigned to a specific transaction. For the reverse lookup (a receipt -> its " +
      "assigned transactions), use get_receipt_transactions instead.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: assignedShape,
    async handler(args) {
      const result = await client.call("transactionsAssignedReceiptsGet", args);
      return ok(result);
    },
  });

  return [
    listTransactions,
    getTransaction,
    createTransactions,
    assignReceiptsToTransactions,
    unassignReceipt,
    getTransactionReceipts,
  ];
}
