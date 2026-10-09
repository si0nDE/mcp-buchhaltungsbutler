import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { assertTransactionEntry } from "./bhb-systematik.js";
import { defineTool, LIST_OUTPUT_SHAPE, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

const QUERY_SWEEP_PAGE_SIZE = 500;
const QUERY_SWEEP_MAX_PAGES = 20;

const SUMMARY_FIELDS = ["id_by_customer", "to_from", "amount", "booking_date", "purpose"] as const;

export function createTransactionsTools(
  client: BBClient
): [ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef] {
  const listShape = {
    id_by_customer_from: z.number().int().optional(),
    id_by_customer_to: z.number().int().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    account: z.number().int().optional(),
    to_from: z.string().optional(),
    query: z
      .string()
      .optional()
      .describe(
        "Case-insensitive substring over to_from, purpose and payment_reference, filtered locally after sweeping all pages of the date window " +
          "(the API filters do not match substrings). The answer states how many transactions were scanned and how many matched. Narrow date_from/date_to."
      ),
    date_since_last_modified: z
      .string()
      .optional()
      .describe("'YYYY-MM-DD HH:MM:SS' (date only = 23:59:59): only transactions changed after that moment - for incremental sync."),
    limit: z.number().int().max(500).default(20),
    offset: z.number().int().default(0),
    full: z.boolean().default(false),
  };

  const listTransactions = defineTool({
    name: "list_transactions",
    description:
      "List bank/cash transactions, with optional filters. Without query, limit/offset apply to the API page. query searches to_from, purpose and " +
      "payment_reference as a substring (the API filters, to_from included, are exact); the answer reports scanned/matched counts.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: LIST_OUTPUT_SHAPE,
    inputSchema: listShape,
    async handler(args) {
      const { full, limit, offset, query, ...filters } = args;
      if (query === undefined) {
        const result = await client.call<BBListResult>("transactionsGet", {
          ...filters,
          limit: limit ?? 20,
          offset: offset ?? 0,
        });
        return ok(trimList(result.data, SUMMARY_FIELDS, full ?? false));
      }
      const needle = query.toLowerCase();
      const all: Record<string, unknown>[] = [];
      let truncated = false;
      for (let page = 0; page < QUERY_SWEEP_MAX_PAGES; page++) {
        const result = await client.call<BBListResult>("transactionsGet", {
          ...filters,
          limit: QUERY_SWEEP_PAGE_SIZE,
          offset: page * QUERY_SWEEP_PAGE_SIZE,
        });
        all.push(...result.data);
        if (result.data.length < QUERY_SWEEP_PAGE_SIZE) break;
        if (page === QUERY_SWEEP_MAX_PAGES - 1) truncated = true;
      }
      const matched = all.filter((r) =>
        ["to_from", "purpose", "payment_reference"].some((f) => typeof r[f] === "string" && (r[f] as string).toLowerCase().includes(needle))
      );
      const page = matched.slice(offset ?? 0, (offset ?? 0) + (limit ?? 20));
      const counts = { scanned: all.length, matched: matched.length, returned: page.length, truncated };
      const response = ok(trimList(page, SUMMARY_FIELDS, full ?? false), { query_counts: counts });
      response.content.push({
        type: "text",
        text:
          `query "${query}": ${counts.scanned} transactions scanned in the date window, ${counts.matched} matched, ${counts.returned} returned` +
          (truncated ? `. Sweep stopped after ${QUERY_SWEEP_MAX_PAGES} pages: matches may be missing, narrow date_from/date_to.` : "."),
      });
      return response;
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
    payment_reference: z
      .string()
      .optional()
      .describe("Zahlungsreferenz (PayPal, Amazon, Stripe, eBay, ...): decisive for matching a receipt that carries the same reference."),
    currency: z.string().optional().describe("Needed for foreign-currency payments; the balance view does not convert currencies."),
  });

  const createShape = {
    transactions: z.array(transactionEntryShape).min(1).max(50),
  };

  const createTransactions = defineTool({
    name: "create_transactions",
    description:
      "Add one or more transactions to a payment account in a single batch call (up to 50). Not " +
      "idempotent — calling again with the same details creates duplicates. Opening balance (Anfangsbestand) of a " +
      "bank/cash account: one manual transaction with the signed balance (mind the sign), booking_date = last day " +
      "of the previous year, to_from e.g. \"Anfangsbestand\"; then post it against 9000 (Saldenvortrag) via " +
      "add_transaction_postings with vat 0_none. Needed in the first year for EÜR and Bilanz alike. Rules: no amount " +
      "0.00 and purpose at most 500 characters (checked before sending); put the payment reference of PayPal/Amazon/" +
      "Stripe/eBay payments into payment_reference (not only into purpose) so receipts can be matched. Do not " +
      "create payments by hand on an account that is linked to a bank or payment provider: they would appear twice " +
      "on the next retrieval; payments the user deleted are not retrieved again. On a revision-safe account " +
      "(Kassenbuch) entries are only ever reversed, never deleted.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: createShape,
    async handler(args) {
      args.transactions.forEach((e, i) => assertTransactionEntry(e, `Zahlung ${i + 1}`));
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
    description:
      "Assign one or more receipts to transactions in a single batch call (up to 50). Assigning books nothing (see confirm_payment). " +
      "BuchhaltungsButler matches automatically by amount plus invoice number or counterparty within 90 days before to 30 days " +
      "after the payment; a receipt with Skonto, a foreign-currency receipt or several receipts for one payment are NOT matched " +
      "automatically - assign those here. Several receipts on one payment are only reliable with the same tax rate (Ist-Versteuerung: " +
      "the tax is derived per receipt in FIFO order); for Debitoren/Kreditoren DATEV cannot match several receipts on one " +
      "payment correctly, so prefer one payment per receipt (see get_booking_guide belege_upload_matching).",
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
    description:
      "Remove the assignment of a specific receipt from a transaction. With open-item bookkeeping (Debitoren/Kreditoren) a receipt " +
      "stays tied to its payment as long as that payment is booked: first undo the booking of the payment (cancel_posting), then " +
      "unassign, only then delete the receipt. A receipt booked on a Debitor/Kreditor with a fixed posting can only be deleted after " +
      "that posting was reversed (get_booking_guide festgeschriebene_loeschen).",
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

  const deleteTransaction = defineTool({
    name: "delete_transaction",
    description:
      "Delete a transaction by its id_by_customer. DESTRUCTIVE: in a revision-safe (GoBD) account nothing is " +
      "deleted - BuchhaltungsButler books a cancellation transaction (STORNO) instead. A transaction with fixed " +
      "(festgeschriebene) postings cannot be deleted; reverse those first (cancel_posting). Check get_transaction first " +
      "and let the user confirm. To wipe wrong postings only, use cancel_posting - not this.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: { transaction_id_by_customer: z.number().int() },
    async handler(args) {
      const result = await client.call("transactionsDelete", { transaction_id_by_customer: args.transaction_id_by_customer });
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
    deleteTransaction,
  ];
}
