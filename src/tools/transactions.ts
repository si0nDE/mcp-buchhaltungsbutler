import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { assertTransactionEntry } from "./bhb-systematik.js";
import { cashbackHint, cashbackHintText, cashbackUnconfirmedText, resolveCashback } from "./cashback.js";
import { getChart } from "./posting-accounts.js";
import { attachPostingStatus, postingStatusNote } from "./posting-status.js";
import { type CallToolResult, defineTool, LIST_OUTPUT_SHAPE, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

const QUERY_SWEEP_PAGE_SIZE = 500;
const QUERY_SWEEP_MAX_PAGES = 20;

const SUMMARY_FIELDS = ["id_by_customer", "to_from", "amount", "booking_date", "purpose"] as const;
const QUERY_FIELDS = ["to_from", "purpose", "payment_reference"];

// Erkannte Sonderfälle (bisher: PayPal-Cashback) als Textblock und structuredContent.booking_hints anhängen.
// Die Liste liefert type nicht: Kandidaten schlägt resolveCashback einzeln nach (höchstens 25 Abfragen je Aufruf).
async function withCashbackHint(client: BBClient, response: CallToolResult, rows: Record<string, unknown>[]): Promise<CallToolResult> {
  const { confirmed, unconfirmed } = await resolveCashback(client, rows);
  if (unconfirmed.length > 0) response.content.push({ type: "text", text: cashbackUnconfirmedText(unconfirmed) });
  if (confirmed.length === 0) return response;
  const chart = await getChart(client).catch(() => "unknown" as const);
  response.content.push({ type: "text", text: cashbackHintText(confirmed, chart) });
  response.structuredContent = {
    ...response.structuredContent,
    booking_hints: [{ ...cashbackHint(confirmed, chart), ...(unconfirmed.length ? { unconfirmed_ids: unconfirmed } : {}) }],
  };
  return response;
}

export function createTransactionsTools(
  client: BBClient
): [ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef] {
  const listShape = {
    id_by_customer_from: z
      .number()
      .int()
      .optional()
      .describe("Exclusive lower bound (observed live: from 100 to 105 returns 101-104; from = to returns nothing)."),
    id_by_customer_to: z.number().int().optional().describe("Exclusive upper bound, see id_by_customer_from."),
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
    with_posting_status: z
      .boolean()
      .optional()
      .describe(
        "Add posting_status {booked, posting_ids, splits, fixed} per transaction (one sweep of postings over the rows' date span). " +
          "Use before booking: the API has no booking flag on transactions."
      ),
    booked: z
      .boolean()
      .optional()
      .describe("true: only booked transactions, false: only open ones. Sweeps all pages of the date window like query; implies with_posting_status."),
  };

  const listTransactions = defineTool({
    name: "list_transactions",
    description:
      "List bank/cash transactions, with optional filters. Without query, limit/offset apply to the API page. query searches to_from, purpose and " +
      "payment_reference as a substring (the API filters, to_from included, are exact); the answer reports scanned/matched counts. " +
      "The list does not carry the Zahlungsart (type, only get_transaction has it). Recognised special cases come as booking_hints with " +
      "the booking to use: PayPal Business Debit cashback (positive payment from 'PayPal Inc Debit Card', confirmed by looking up type " +
      "\"Cash Back Bonus\" per payment; find them with query \"PayPal Inc Debit Card\").",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: LIST_OUTPUT_SHAPE,
    inputSchema: listShape,
    async handler(args) {
      const { full, limit, offset, query, with_posting_status, booked, ...filters } = args;
      if (query === undefined && booked === undefined) {
        const result = await client.call<BBListResult>("transactionsGet", {
          ...filters,
          limit: limit ?? 20,
          offset: offset ?? 0,
        });
        if (!with_posting_status) return withCashbackHint(client, ok(trimList(result.data, SUMMARY_FIELDS, full ?? false)), result.data);
        const st = await attachPostingStatus(client, result.data);
        const response = ok(trimList(st.rows, [...SUMMARY_FIELDS, "posting_status"], full ?? false));
        response.content.push({ type: "text", text: postingStatusNote(st.scanned, st.truncated) });
        return withCashbackHint(client, response, result.data);
      }
      const needle = (query ?? "").toLowerCase();
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
      let matched =
        query === undefined
          ? all
          : all.filter((r) => QUERY_FIELDS.some((f) => typeof r[f] === "string" && (r[f] as string).toLowerCase().includes(needle)));
      let statusNote: string | undefined;
      let fieldsOut: readonly string[] = SUMMARY_FIELDS;
      if (booked !== undefined || with_posting_status) {
        const st = await attachPostingStatus(client, matched);
        matched = booked === undefined ? st.rows : st.rows.filter((r) => (r.posting_status as { booked: boolean }).booked === booked);
        statusNote = postingStatusNote(st.scanned, st.truncated);
        fieldsOut = [...SUMMARY_FIELDS, "posting_status"];
      }
      const page = matched.slice(offset ?? 0, (offset ?? 0) + (limit ?? 20));
      const counts = { scanned: all.length, matched: matched.length, returned: page.length, truncated };
      const response = ok(trimList(page, fieldsOut, full ?? false), { query_counts: counts });
      response.content.push({
        type: "text",
        text:
          `${query === undefined ? "no query" : `query "${query}"`}: ${counts.scanned} transactions scanned in the date window, ${counts.matched} matched, ${counts.returned} returned` +
          (truncated ? `. Sweep stopped after ${QUERY_SWEEP_MAX_PAGES} pages: matches may be missing, narrow date_from/date_to.` : "."),
      });
      if (statusNote) response.content.push({ type: "text", text: statusNote });
      return withCashbackHint(client, response, page);
    },
  });

  const getShape = { id_by_customer: z.number().int() };

  const getTransaction = defineTool({
    name: "get_transaction",
    description:
      "Get a single transaction by its id_by_customer, with posting_status {booked, posting_ids, splits, fixed} (looked up from the postings of that day). A recognised special case (PayPal Business Debit cashback) comes with booking_hints.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: getShape,
    async handler(args) {
      const result = await client.call<{ data?: Record<string, unknown> }>("transactionsGetIdByCustomer", {}, { idSuffix: args.id_by_customer });
      const row = result?.data;
      if (row && typeof row === "object" && typeof row.booking_date === "string") {
        try {
          const st = await attachPostingStatus(client, [{ ...row, id_by_customer: row.id_by_customer ?? args.id_by_customer }]);
          const { posting_status } = st.rows[0] as { posting_status: unknown };
          return withCashbackHint(client, ok({ ...result, data: { ...row, posting_status } }), [row]);
        } catch {
          const response = ok(result);
          response.content.push({ type: "text", text: "posting_status could not be determined (postings lookup failed); check list_postings before booking." });
          return withCashbackHint(client, response, [row]);
        }
      }
      return withCashbackHint(client, ok(result), row ? [row] : []);
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
