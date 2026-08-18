import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { defineTool, ok, type ToolDef } from "./types.js";

const splitShape = z.object({
  postingaccount: z.number().int(),
  postingtext: z.string(),
  vat: z.string(),
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
  const costLocations = splits.map((s) => s.cost_location);
  const costLocationsTwo = splits.map((s) => s.cost_location_two);
  return {
    postingaccounts: splits.map((s) => s.postingaccount),
    postingtexts: splits.map((s) => s.postingtext),
    vats: splits.map((s) => s.vat),
    amounts: splits.map((s) => s.amount),
    ...(costLocations.some((c) => c !== undefined) ? { cost_locations: costLocations as string[] } : {}),
    ...(costLocationsTwo.some((c) => c !== undefined) ? { cost_locations_two: costLocationsTwo as string[] } : {}),
  };
}

export function createPostingsTools(
  client: BBClient
): [ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef] {
  const listShape = {
    date_from: z.string(),
    date_to: z.string(),
    date_last_action_from: z.string().optional(),
    date_last_action_to: z.string().optional(),
    account: z.string().optional(),
    postingaccount: z.string().optional(),
    posting_status: z.enum(["all", "fixed", "unfixed"]).optional(),
    cost_location: z.string().optional(),
    order: z.string().optional(),
    limit: z.number().int().max(1000).default(20),
    offset: z.number().int().default(0),
  };

  const listPostings = defineTool({
    name: "list_postings",
    description: "List postings (Buchungen) within a required date range, with optional filters.",
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
  });

  const addReceiptPostingsShape = {
    receipts: z.array(receiptPostingEntryShape).min(1),
  };

  const addReceiptPostings = defineTool({
    name: "add_receipt_postings",
    description: "Book one or more receipts onto posting accounts in a single batch call.",
    inputSchema: addReceiptPostingsShape,
    async handler(args) {
      const receipts = args.receipts.map(({ splits, ...rest }) => ({ ...rest, ...flattenSplits(splits) }));
      const result = await client.call("postingsAddBatchReceipts", { receipts });
      return ok(result);
    },
  });

  const transactionPostingEntryShape = z.object({
    transaction_id_by_customer: z.number().int(),
    oi_receipts_ids_by_customer: z.array(z.number().int()),
    splits: z.array(splitShape).min(1),
  });

  const addTransactionPostingsShape = {
    transactions: z.array(transactionPostingEntryShape).min(1),
  };

  const addTransactionPostings = defineTool({
    name: "add_transaction_postings",
    description: "Book one or more transactions onto posting accounts in a single batch call.",
    inputSchema: addTransactionPostingsShape,
    async handler(args) {
      const transactions = args.transactions.map(({ splits, ...rest }) => ({ ...rest, ...flattenSplits(splits) }));
      const result = await client.call("postingsAddBatchTransactions", { transactions });
      return ok(result);
    },
  });

  const freePostingEntryShape = z.object({
    date: z.string(),
    postingtext: z.string(),
    amount: z.string(),
    postingaccount_debit: z.number().int(),
    postingaccount_credit: z.number().int(),
    vat: z.string(),
    cost_location: z.string().optional(),
    cost_location_two: z.string().optional(),
  });

  const addFreePostingsShape = {
    free_postings: z.array(freePostingEntryShape).min(1),
  };

  const addFreePostings = defineTool({
    name: "add_free_postings",
    description: "Add one or more free-form postings (not tied to a receipt or transaction) in a single batch call.",
    inputSchema: addFreePostingsShape,
    async handler(args) {
      const result = await client.call("postingsAddBatchFree", { free_postings: args.free_postings });
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
    description: "Assign a receipt to an existing free posting.",
    inputSchema: assignShape,
    async handler(args) {
      const result = await client.call("postingsAssignReceiptToFreePosting", args);
      return ok(result);
    },
  });

  return [
    listPostings,
    addReceiptPostings,
    addTransactionPostings,
    addFreePostings,
    unconfirmPosting,
    assignReceiptToFreePosting,
  ];
}
