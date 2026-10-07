import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import {
  assertEntertainmentExpenseFields,
  COMMENT_MAX_BYTES,
  computeEntertainmentReclass,
  formatEntertainmentExpenseNote,
  truncateToBytes,
} from "./entertainment-expense.js";
import { amountsMatch, buildSettlementPostingText } from "./payment-confirmation.js";
import { assertTravelExpenseFields, formatTravelExpenseNote } from "./travel-expense.js";
import { defineTool, OBJECT_OUTPUT_SHAPE, ok, type ToolDef } from "./types.js";

// BuchhaltungsButler's `vat`/`vats` fields take one of these fixed codes, not a
// percentage string — e.g. "0_none" for a 0%/no-VAT posting, not "0" or "0.00".
// Sending a percentage string fails with error_code 19 "Invalid vat specified".
const VAT_CODES = [
  "0_none",
  "19_vat",
  "7_vat",
  "19_pre",
  "7_pre",
  "19_both_1",
  "19_both_506",
  "19_both_6506",
  "19_both_511",
  "19_both_6511",
  "19_both_6501",
  "19_both_2",
  "7_both",
  "19_both_1_no_pre",
  "19_both_2_no_pre",
  "7_both_no_pre",
  "19_pre_app",
  "7_pre_app",
  "19_both_app_1",
  "19_both_app_506",
  "19_both_app_511",
  "19_both_app_2",
  "7_both_app",
] as const;

const vatShape = z
  .enum(VAT_CODES)
  .describe(
    "VAT code, not a percentage. Common: 0_none (keine USt.), 19_vat (19% USt.), 7_vat (7% USt.), " +
      "19_pre/7_pre (Vorsteuer). See BuchhaltungsButler API docs for the §13b/i.g.E. reverse-charge codes."
  );

const travelerFieldsShape = {
  traveler_name: z.string().optional(),
  traveler_role: z.enum(["employee", "owner_manager", "unclear"]).optional(),
  business_purpose: z.string().optional(),
};

const entertainmentFieldsShape = {
  participants: z.string().optional(),
  occasion: z.string().optional(),
  host_confirmed: z.boolean().optional(),
  entertainment_split_mode: z
    .enum(["gross_split", "net_reclass"])
    .optional()
    .describe(
      'Default "gross_split": 4650 and 4654 in the same call in a 70/30 ratio. "net_reclass": book only 4650/6640 ' +
        "with the full amount and input VAT; the response then contains entertainment_reclass_hints with the 30% " +
        "of NET to reclassify afterwards via add_free_postings (4654 an 4650, vat 0_none). Not booked automatically."
    ),
};

const splitShape = z.object({
  postingaccount: z.number().int(),
  postingtext: z.string(),
  vat: vatShape,
  amount: z.string(),
  cost_location: z.string().optional(),
  cost_location_two: z.string().optional(),
});

type Split = z.infer<typeof splitShape>;

function flattenSplits(splits: Split[]): {
  postingaccounts: number[];
  postingtexts: string[];
  vats: string[];
  amounts: string[];
  cost_locations?: string[];
  cost_locations_two?: string[];
} {
  const hasCostLocation = splits.some((s) => s.cost_location !== undefined);
  const hasCostLocationTwo = splits.some((s) => s.cost_location_two !== undefined);
  return {
    postingaccounts: splits.map((s) => s.postingaccount),
    postingtexts: splits.map((s) => s.postingtext),
    vats: splits.map((s) => s.vat),
    amounts: splits.map((s) => s.amount),
    ...(hasCostLocation ? { cost_locations: splits.map((s) => s.cost_location ?? "") } : {}),
    ...(hasCostLocationTwo ? { cost_locations_two: splits.map((s) => s.cost_location_two ?? "") } : {}),
  };
}

// oi_receipts_ids_by_customer only applies to transaction postings (assigning
// an existing "open item" receipt to one specific split of a bank-transaction
// posting) — receipt postings have no equivalent concept, so this extends
// splitShape rather than living on it directly.
const transactionSplitShape = splitShape.extend({
  receipt_id_by_customer: z.number().int().optional(),
});

type TransactionSplit = z.infer<typeof transactionSplitShape>;

// BuchhaltungsButler requires oi_receipts_ids_by_customer to be a *parallel*
// array — one entry per split, positionally aligned with postingaccounts/
// postingtexts/vats/amounts, null where a split has no receipt — not a
// free-standing list of receipt ids for the transaction as a whole. Sending
// a shorter (or longer) array than the split count causes a generic
// "error_code 0 / An internal error occurred" on BuchhaltungsButler's side
// rather than a clear validation error, which is what surfaced this: every
// add_transaction_postings call failed because the connector previously
// passed through whatever flat array the caller supplied, unrelated to the
// actual split count.
function flattenTransactionSplits(splits: TransactionSplit[]) {
  return {
    ...flattenSplits(splits),
    oi_receipts_ids_by_customer: splits.map((s) => s.receipt_id_by_customer ?? null),
  };
}

interface CommentJob {
  target: { receipt_id_by_customer: number } | { transaction_id_by_customer: number };
  text: string;
}

// Comments are sent AFTER the booking succeeded. A failing comment must not
// turn a completed booking into an error (a retry would book twice), so it is
// reported as a warning instead. The text is always cut to BHB's limit first.
async function sendComments(client: BBClient, jobs: CommentJob[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const job of jobs) {
    const [kind, id] = Object.entries(job.target)[0];
    try {
      await client.call("commentsAdd", { ...job.target, comment_text: truncateToBytes(job.text, COMMENT_MAX_BYTES) });
    } catch (error) {
      warnings.push(
        `Kommentar zu ${kind === "receipt_id_by_customer" ? "Beleg" : "Transaktion"} ${id} konnte nicht angelegt werden ` +
          `(${error instanceof Error ? error.message : String(error)}). Die Buchung wurde bereits gebucht - NICHT erneut ` +
          "buchen; den Kommentar bei Bedarf per add_comment nachtragen."
      );
    }
  }
  return warnings;
}

interface AuditItem {
  target: CommentJob["target"];
  entry: {
    splits: Array<{ postingaccount: number; amount: string; vat: string }>;
    traveler_name?: string;
    business_purpose?: string;
    participants?: string;
    occasion?: string;
    entertainment_split_mode?: string;
  };
  travelMatch: ReturnType<typeof assertTravelExpenseFields>;
  entertainmentMatch: true | undefined;
}

// Built BEFORE booking so everything that can fail on our side fails before
// anything is sent to BuchhaltungsButler.
function collectAuditArtifacts(items: AuditItem[]): { commentJobs: CommentJob[]; hints: Array<Record<string, unknown>> } {
  const commentJobs: CommentJob[] = [];
  const hints: Array<Record<string, unknown>> = [];
  for (const { target, entry, travelMatch, entertainmentMatch } of items) {
    if (travelMatch) {
      commentJobs.push({
        target,
        text: formatTravelExpenseNote({
          traveler_name: entry.traveler_name!,
          traveler_role: travelMatch.role,
          business_purpose: entry.business_purpose!,
        }),
      });
    }
    if (entertainmentMatch) {
      commentJobs.push({
        target,
        text: formatEntertainmentExpenseNote({ participants: entry.participants!, occasion: entry.occasion! }),
      });
      if (entry.entertainment_split_mode === "net_reclass") {
        const hint = computeEntertainmentReclass(entry.splits);
        if (hint) hints.push({ ...target, ...hint });
      }
    }
  }
  return { commentJobs, hints };
}

function withExtras(result: unknown, extras: { warnings: string[]; hints: Array<Record<string, unknown>> }) {
  const add: Record<string, unknown> = {};
  if (extras.warnings.length > 0) add.warnings = extras.warnings;
  if (extras.hints.length > 0) add.entertainment_reclass_hints = extras.hints;
  return ok(Object.keys(add).length > 0 ? { ...(result as Record<string, unknown>), ...add } : result);
}

export function createPostingsTools(
  client: BBClient
): [ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef] {
  const listShape = {
    date_from: z.string(),
    date_to: z.string(),
    date_last_action_from: z.string().optional(),
    date_last_action_to: z.string().optional(),
    account: z.string().optional(),
    postingaccount: z.string().optional(),
    posting_status: z.enum(["all", "fixed", "unfixed"]).optional(),
    cost_location: z.string().optional(),
    order: z
      .enum([
        "default",
        "date ASC",
        "date DESC",
        "date_last_action ASC",
        "date_last_action DESC",
        "id_by_customer ASC",
        "id_by_customer DESC",
      ])
      .optional(),
    limit: z.number().int().max(1000).default(20),
    offset: z.number().int().default(0),
  };

  const listPostings = defineTool({
    name: "list_postings",
    description: "List postings (Buchungen) within a required date range, with optional filters.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: listShape,
    async handler(args) {
      const result = await client.call("postingsGet", {
        ...args,
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
      });
      return ok(result);
    },
  });

  const receiptPostingEntryShape = z.object({
    receipt_id_by_customer: z.number().int(),
    creditor: z.number().int(),
    debtor: z.number().int(),
    splits: z.array(splitShape).min(1),
    ...travelerFieldsShape,
    ...entertainmentFieldsShape,
  });

  const addReceiptPostingsShape = {
    receipts: z.array(receiptPostingEntryShape).min(1),
  };

  const addReceiptPostings = defineTool({
    name: "add_receipt_postings",
    description:
      "Book one or more receipts onto posting accounts in a single batch call. Use this when the " +
      "posting is backed by a receipt/invoice document; for a bank transaction use " +
      "add_transaction_postings, and for entries with no receipt or transaction (e.g. depreciation, " +
      "opening balances) use add_free_postings. Booking onto a travel-expense account (Reisekosten " +
      "Arbeitnehmer/Unternehmer, SKR03 4660-4678 or SKR04 6650-6680) requires traveler_name, " +
      "traveler_role (employee or owner_manager — ask the user if unclear, never infer it from the " +
      "invoice address or payment method), and business_purpose. Booking onto a Bewirtungskosten " +
      "(business entertainment) account (SKR03 4650/4654 or SKR04 6640/6644) requires the deductible " +
      "(4650/6640) and non-deductible (4654/6644) splits to both be present in an approximately 70/30 " +
      "ratio, plus participants, occasion, and host_confirmed: true (confirming a proper signed " +
      "Bewirtungsbeleg exists per § 4 Abs. 5 Nr. 2 EStG — ask the user if unsure, don't assume). Both " +
      "sets of fields are recorded as a comment on the receipt for the audit trail." +
      " The audit comment is cut to BuchhaltungsButler's 210-character limit; if it still fails after the booking " +
      "the call returns a warning instead of an error (never re-book). entertainment_split_mode " +
      '"net_reclass" books only 4650/6640 with full amount and input VAT and returns ' +
      "entertainment_reclass_hints (30% of NET, to book via add_free_postings as 4654 an 4650, vat 0_none).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: addReceiptPostingsShape,
    async handler(args) {
      const travelMatches = args.receipts.map((entry) =>
        assertTravelExpenseFields(
          entry.splits.map((s) => s.postingaccount),
          entry
        )
      );
      const entertainmentMatches = args.receipts.map((entry) => assertEntertainmentExpenseFields(entry.splits, entry));
      const receipts = args.receipts.map(
        ({ splits, traveler_name, traveler_role, business_purpose, participants, occasion, host_confirmed, entertainment_split_mode, ...rest }) => ({
          ...rest,
          ...flattenSplits(splits),
        })
      );
      const { commentJobs, hints } = collectAuditArtifacts(
        args.receipts.map((entry, i) => ({
          target: { receipt_id_by_customer: entry.receipt_id_by_customer },
          entry,
          travelMatch: travelMatches[i],
          entertainmentMatch: entertainmentMatches[i],
        }))
      );
      const result = await client.call("postingsAddBatchReceipts", { receipts });
      const warnings = await sendComments(client, commentJobs);
      return withExtras(result, { warnings, hints });
    },
  });

  const transactionPostingEntryShape = z.object({
    transaction_id_by_customer: z.number().int(),
    splits: z.array(transactionSplitShape).min(1),
    ...travelerFieldsShape,
    ...entertainmentFieldsShape,
  });

  const addTransactionPostingsShape = {
    transactions: z.array(transactionPostingEntryShape).min(1),
  };

  const addTransactionPostings = defineTool({
    name: "add_transaction_postings",
    description:
      "Book one or more transactions onto posting accounts in a single batch call. Use this for a bank " +
      "transaction; for a receipt/invoice use add_receipt_postings, and for entries with no receipt or " +
      "transaction use add_free_postings. Each split may optionally set receipt_id_by_customer to assign " +
      "an existing 'open item' receipt to that specific split — omit it for splits with no receipt; the " +
      "connector aligns these into BuchhaltungsButler's required parallel array automatically. Booking " +
      "onto a travel-expense account (Reisekosten " +
      "Arbeitnehmer/Unternehmer, SKR03 4660-4678 or SKR04 6650-6680) requires traveler_name, " +
      "traveler_role (employee or owner_manager — ask the user if unclear, never infer it from the " +
      "invoice address or payment method), and business_purpose. Booking onto a Bewirtungskosten " +
      "(business entertainment) account (SKR03 4650/4654 or SKR04 6640/6644) requires the deductible " +
      "(4650/6640) and non-deductible (4654/6644) splits to both be present in an approximately 70/30 " +
      "ratio, plus participants, occasion, and host_confirmed: true (confirming a proper signed " +
      "Bewirtungsbeleg exists per § 4 Abs. 5 Nr. 2 EStG — ask the user if unsure, don't assume). Both " +
      "sets of fields are recorded as a comment on the transaction for the audit trail." +
      " The audit comment is cut to BuchhaltungsButler's 210-character limit; if it still fails after the booking " +
      "the call returns a warning instead of an error (never re-book). entertainment_split_mode " +
      '"net_reclass" books only 4650/6640 with full amount and input VAT and returns ' +
      "entertainment_reclass_hints (30% of NET, to book via add_free_postings as 4654 an 4650, vat 0_none). " +
      "Give split amounts as positive numbers; the direction follows the transaction. The connector passes " +
      "amounts through unchanged. Observed live on one outgoing card payment: negative splits were rejected with " +
      "BuchhaltungsButler error 27 (sum does not match the transaction amount), positive ones were accepted - " +
      "not verified for other transaction types.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: addTransactionPostingsShape,
    async handler(args) {
      const travelMatches = args.transactions.map((entry) =>
        assertTravelExpenseFields(
          entry.splits.map((s) => s.postingaccount),
          entry
        )
      );
      const entertainmentMatches = args.transactions.map((entry) =>
        assertEntertainmentExpenseFields(entry.splits, entry)
      );
      const transactions = args.transactions.map(
        ({ splits, traveler_name, traveler_role, business_purpose, participants, occasion, host_confirmed, entertainment_split_mode, ...rest }) => ({
          ...rest,
          ...flattenTransactionSplits(splits),
        })
      );
      const { commentJobs, hints } = collectAuditArtifacts(
        args.transactions.map((entry, i) => ({
          target: { transaction_id_by_customer: entry.transaction_id_by_customer },
          entry,
          travelMatch: travelMatches[i],
          entertainmentMatch: entertainmentMatches[i],
        }))
      );
      const result = await client.call("postingsAddBatchTransactions", { transactions });
      const warnings = await sendComments(client, commentJobs);
      return withExtras(result, { warnings, hints });
    },
  });

  const freePostingEntryShape = z.object({
    date: z.string(),
    postingtext: z.string(),
    amount: z.string(),
    postingaccount_debit: z.number().int(),
    postingaccount_credit: z.number().int(),
    vat: vatShape,
    cost_location: z.string().optional(),
    cost_location_two: z.string().optional(),
    ...travelerFieldsShape,
  });

  const addFreePostingsShape = {
    free_postings: z.array(freePostingEntryShape).min(1),
  };

  const addFreePostings = defineTool({
    name: "add_free_postings",
    description:
      "Add one or more free-form postings (not tied to a receipt or transaction) in a single batch " +
      "call, e.g. depreciation or opening balances. For a receipt or bank transaction, use " +
      "add_receipt_postings or add_transaction_postings instead. Booking onto a travel-expense account " +
      "(Reisekosten Arbeitnehmer/Unternehmer, SKR03 4660-4678 or SKR04 6650-6680) requires " +
      "traveler_name, traveler_role (employee or owner_manager — ask the user if unclear, never infer " +
      "it from the invoice address or payment method), and business_purpose; these are appended to " +
      "postingtext for the audit trail (free postings have no id to attach a comment to).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: addFreePostingsShape,
    async handler(args) {
      const free_postings = args.free_postings.map(({ traveler_name, traveler_role, business_purpose, ...rest }) => {
        const match = assertTravelExpenseFields([rest.postingaccount_debit, rest.postingaccount_credit], {
          traveler_name,
          traveler_role,
          business_purpose,
        });
        if (!match) return rest;
        return {
          ...rest,
          postingtext: `${rest.postingtext} — ${formatTravelExpenseNote({
            traveler_name: traveler_name!,
            traveler_role: match.role,
            business_purpose: business_purpose!,
          })}`,
        };
      });
      const result = await client.call("postingsAddBatchFree", { free_postings });
      return ok(result);
    },
  });

  const unconfirmShape = {
    type: z.enum(["transaction", "receipt", "free"]),
    id_by_customer: z.number().int(),
  };

  const unconfirmPosting = defineTool({
    name: "unconfirm_posting",
    description: "Unconfirm a fixed posting so it can be edited again. type selects which kind of posting.",
    // Flips an existing posting's fixed/confirmed status — a non-additive
    // state change, same class as update_contact/manage_posting_account/
    // unassign_receipt, so destructiveHint follows them for consistency.
    annotations: { readOnlyHint: false, destructiveHint: true },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: unconfirmShape,
    async handler(args) {
      if (args.type === "transaction") {
        const result = await client.call("postingsUnconfirmTransaction", {
          transaction_id_by_customer: args.id_by_customer,
        });
        return ok(result);
      }
      if (args.type === "receipt") {
        const result = await client.call("postingsUnconfirmReceipt", {
          receipt_id_by_customer: args.id_by_customer,
        });
        return ok(result);
      }
      const result = await client.call("postingsUnconfirmFree", { posting_id_by_customer: args.id_by_customer });
      return ok(result);
    },
  });

  const assignShape = {
    receipt_id_by_customer: z.number().int(),
    posting_id_by_customer: z.number().int(),
  };

  const assignReceiptToFreePosting = defineTool({
    name: "assign_receipt_to_free_posting",
    description:
      "Assign a receipt to an existing free posting. Not for transactions — to assign a receipt to a " +
      "transaction, use assign_receipts_to_transactions instead.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: assignShape,
    async handler(args) {
      const result = await client.call("postingsAssignReceiptToFreePosting", args);
      return ok(result);
    },
  });

  const confirmPaymentShape = {
    receipt_id_by_customer: z.number().int(),
    transaction_id_by_customer: z.number().int(),
    posting_account: z
      .number()
      .int()
      .describe(
        "The creditor/debtor posting account the receipt was originally booked against (the same account " +
          "passed as creditor/debtor to add_receipt_postings). Not auto-discovered — the BuchhaltungsButler " +
          "API has no way to look up which account a given receipt was booked against, so pass the account " +
          "you already used or can look up with a single list_postings call."
      ),
    postingtext: z.string().optional(),
  };

  const confirmPayment = defineTool({
    name: "confirm_payment",
    description:
      "Close out a receipt against a matching bank transaction: assigning a receipt to a transaction " +
      "(assign_receipts_to_transactions) creates no posting and leaves the creditor/debtor balance " +
      "untouched by itself — a booking against posting_account is still required to actually settle it. " +
      "This tool does both in the right order and reports which of them actually completed, so a caller " +
      "can't mistake 'assigned' for 'paid'. Rejects with an error if the receipt's and transaction's " +
      "amounts don't match (no silent partial settlement). Does not set or ask about the fixed/festgeschrieben " +
      "state — that has no equivalent in the BuchhaltungsButler API and is a client-specific policy decision, " +
      "not something this connector can or should decide.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    outputSchema: OBJECT_OUTPUT_SHAPE,
    inputSchema: confirmPaymentShape,
    async handler(args) {
      const receipt = await client.call<{ data: { amount: string; invoicenumber?: string; counterparty?: string } }>(
        "receiptsGetIdByCustomer",
        {},
        { idSuffix: args.receipt_id_by_customer }
      );
      const transaction = await client.call<{ data: { amount: string } }>(
        "transactionsGetIdByCustomer",
        {},
        { idSuffix: args.transaction_id_by_customer }
      );

      if (!amountsMatch(receipt.data.amount, transaction.data.amount)) {
        throw new Error(
          `Receipt ${args.receipt_id_by_customer} amount (${receipt.data.amount}) does not match transaction ` +
            `${args.transaction_id_by_customer} amount (${transaction.data.amount}) — refusing to assign or book ` +
            `a partial settlement. Confirm the correct receipt/transaction pair with the user instead of guessing.`
        );
      }

      const assignResult = await client.call("transactionsAssignBatchReceipt", {
        transactions_to_receipts: [
          {
            transaction_id_by_customer: args.transaction_id_by_customer,
            receipt_id_by_customer: args.receipt_id_by_customer,
          },
        ],
      });

      const amount = Math.abs(Number(receipt.data.amount)).toFixed(2);
      const postingtext = args.postingtext ?? buildSettlementPostingText(receipt.data, args.receipt_id_by_customer);

      try {
        const postingResult = await client.call("postingsAddBatchTransactions", {
          transactions: [
            {
              transaction_id_by_customer: args.transaction_id_by_customer,
              oi_receipts_ids_by_customer: [args.receipt_id_by_customer],
              postingaccounts: [args.posting_account],
              postingtexts: [postingtext],
              vats: ["0_none"],
              amounts: [amount],
            },
          ],
        });
        return ok({ status: "booked", amount, assign: assignResult, posting: postingResult });
      } catch (err) {
        return ok({
          status: "assigned_only",
          amount,
          assign: assignResult,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  return [
    listPostings,
    addReceiptPostings,
    addTransactionPostings,
    addFreePostings,
    unconfirmPosting,
    assignReceiptToFreePosting,
    confirmPayment,
  ];
}
