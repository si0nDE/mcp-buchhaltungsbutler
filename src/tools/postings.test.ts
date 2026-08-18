import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createPostingsTools } from "./postings.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("postings tools", () => {
  it("list_postings calls postingsGet with required date range and default limit", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [listPostings] = createPostingsTools(client);

    await listPostings.handler({ date_from: "2026-01-01", date_to: "2026-01-31" });

    expect(client.call).toHaveBeenCalledWith("postingsGet", {
      date_from: "2026-01-01",
      date_to: "2026-01-31",
      limit: 20,
      offset: 0,
    });
  });

  it("add_receipt_postings flattens splits into parallel arrays", async () => {
    const client = mockClient({ success: true });
    const [, addReceiptPostings] = createPostingsTools(client);

    await addReceiptPostings.handler({
      receipts: [
        {
          receipt_id_by_customer: 42,
          creditor: 70001,
          debtor: 10001,
          splits: [
            { postingaccount: 6815, postingtext: "Büromaterial", vat: "19", amount: "100.00", cost_location: "CL1" },
          ],
        },
      ],
    });

    expect(client.call).toHaveBeenCalledWith("postingsAddBatchReceipts", {
      receipts: [
        {
          receipt_id_by_customer: 42,
          creditor: 70001,
          debtor: 10001,
          postingaccounts: [6815],
          postingtexts: ["Büromaterial"],
          vats: ["19"],
          amounts: ["100.00"],
          cost_locations: ["CL1"],
        },
      ],
    });
  });

  it("add_receipt_postings fills missing cost_location with empty string in mixed-presence batches", async () => {
    const client = mockClient({ success: true });
    const [, addReceiptPostings] = createPostingsTools(client);

    await addReceiptPostings.handler({
      receipts: [
        {
          receipt_id_by_customer: 42,
          creditor: 70001,
          debtor: 10001,
          splits: [
            { postingaccount: 6815, postingtext: "Büromaterial", vat: "19", amount: "100.00", cost_location: "CL1" },
            { postingaccount: 6816, postingtext: "Porto", vat: "19", amount: "5.00" },
          ],
        },
      ],
    });

    expect(client.call).toHaveBeenCalledWith(
      "postingsAddBatchReceipts",
      expect.objectContaining({
        receipts: [
          expect.objectContaining({
            cost_locations: ["CL1", ""],
          }),
        ],
      })
    );
  });

  it("add_transaction_postings flattens splits into parallel arrays", async () => {
    const client = mockClient({ success: true });
    const [, , addTransactionPostings] = createPostingsTools(client);

    await addTransactionPostings.handler({
      transactions: [
        {
          transaction_id_by_customer: 7,
          oi_receipts_ids_by_customer: [42],
          splits: [{ postingaccount: 6815, postingtext: "Miete", vat: "0", amount: "500.00" }],
        },
      ],
    });

    expect(client.call).toHaveBeenCalledWith("postingsAddBatchTransactions", {
      transactions: [
        {
          transaction_id_by_customer: 7,
          oi_receipts_ids_by_customer: [42],
          postingaccounts: [6815],
          postingtexts: ["Miete"],
          vats: ["0"],
          amounts: ["500.00"],
        },
      ],
    });
  });

  it("add_free_postings calls postingsAddBatchFree", async () => {
    const client = mockClient({ success: true });
    const [, , , addFreePostings] = createPostingsTools(client);

    await addFreePostings.handler({
      free_postings: [
        {
          date: "2026-01-01",
          postingtext: "Privatentnahme",
          amount: "50.00",
          postingaccount_debit: 1800,
          postingaccount_credit: 1000,
          vat: "0",
        },
      ],
    });

    expect(client.call).toHaveBeenCalledWith("postingsAddBatchFree", {
      free_postings: [
        {
          date: "2026-01-01",
          postingtext: "Privatentnahme",
          amount: "50.00",
          postingaccount_debit: 1800,
          postingaccount_credit: 1000,
          vat: "0",
        },
      ],
    });
  });

  it("unconfirm_posting routes by type to the matching endpoint and id field", async () => {
    const client = mockClient({ success: true });
    const [, , , , unconfirmPosting] = createPostingsTools(client);

    await unconfirmPosting.handler({ type: "transaction", id_by_customer: 7 });
    expect(client.call).toHaveBeenCalledWith("postingsUnconfirmTransaction", {
      transaction_id_by_customer: 7,
    });

    await unconfirmPosting.handler({ type: "receipt", id_by_customer: 42 });
    expect(client.call).toHaveBeenCalledWith("postingsUnconfirmReceipt", { receipt_id_by_customer: 42 });

    await unconfirmPosting.handler({ type: "free", id_by_customer: 99 });
    expect(client.call).toHaveBeenCalledWith("postingsUnconfirmFree", { posting_id_by_customer: 99 });
  });

  it("assign_receipt_to_free_posting calls postingsAssignReceiptToFreePosting", async () => {
    const client = mockClient({ success: true });
    const [, , , , , assignReceiptToFreePosting] = createPostingsTools(client);

    await assignReceiptToFreePosting.handler({ receipt_id_by_customer: 42, posting_id_by_customer: 99 });

    expect(client.call).toHaveBeenCalledWith("postingsAssignReceiptToFreePosting", {
      receipt_id_by_customer: 42,
      posting_id_by_customer: 99,
    });
  });
});
