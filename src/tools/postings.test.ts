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

  it("list_postings passes a valid order value through to postingsGet", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [listPostings] = createPostingsTools(client);

    await listPostings.handler({ date_from: "2026-01-01", date_to: "2026-01-31", order: "date DESC" });

    expect(client.call).toHaveBeenCalledWith("postingsGet", {
      date_from: "2026-01-01",
      date_to: "2026-01-31",
      order: "date DESC",
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
            { postingaccount: 6815, postingtext: "Büromaterial", vat: "19_vat", amount: "100.00", cost_location: "CL1" },
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
          vats: ["19_vat"],
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
            { postingaccount: 6815, postingtext: "Büromaterial", vat: "19_vat", amount: "100.00", cost_location: "CL1" },
            { postingaccount: 6816, postingtext: "Porto", vat: "19_vat", amount: "5.00" },
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
          splits: [{ postingaccount: 6815, postingtext: "Miete", vat: "0_none", amount: "500.00" }],
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
          vats: ["0_none"],
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
          vat: "0_none",
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
          vat: "0_none",
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

  describe("travel expense account validation", () => {
    it("add_receipt_postings rejects a travel-expense account without traveler_name, without booking", async () => {
      const client = mockClient({ success: true });
      const [, addReceiptPostings] = createPostingsTools(client);

      await expect(
        addReceiptPostings.handler({
          receipts: [
            {
              receipt_id_by_customer: 42,
              creditor: 70001,
              debtor: 10001,
              splits: [{ postingaccount: 4663, postingtext: "Flug", vat: "0_none", amount: "300.00" }],
            },
          ],
        })
      ).rejects.toThrow(/traveler_name/);
      expect(client.call).not.toHaveBeenCalled();
    });

    it("add_receipt_postings rejects a travel-expense account without traveler_role, without booking", async () => {
      const client = mockClient({ success: true });
      const [, addReceiptPostings] = createPostingsTools(client);

      await expect(
        addReceiptPostings.handler({
          receipts: [
            {
              receipt_id_by_customer: 42,
              creditor: 70001,
              debtor: 10001,
              traveler_name: "Person A",
              splits: [{ postingaccount: 4663, postingtext: "Flug", vat: "0_none", amount: "300.00" }],
            },
          ],
        })
      ).rejects.toThrow(/traveler_role/);
      expect(client.call).not.toHaveBeenCalled();
    });

    it("add_receipt_postings rejects traveler_role 'unclear', instructing the caller to ask the user", async () => {
      const client = mockClient({ success: true });
      const [, addReceiptPostings] = createPostingsTools(client);

      await expect(
        addReceiptPostings.handler({
          receipts: [
            {
              receipt_id_by_customer: 42,
              creditor: 70001,
              debtor: 10001,
              traveler_name: "Person A",
              traveler_role: "unclear",
              business_purpose: "Kundentermin",
              splits: [{ postingaccount: 4663, postingtext: "Flug", vat: "0_none", amount: "300.00" }],
            },
          ],
        })
      ).rejects.toThrow(/ask the user/);
      expect(client.call).not.toHaveBeenCalled();
    });

    it("add_receipt_postings rejects a traveler_role/account-range mismatch, without booking", async () => {
      const client = mockClient({ success: true });
      const [, addReceiptPostings] = createPostingsTools(client);

      await expect(
        addReceiptPostings.handler({
          receipts: [
            {
              receipt_id_by_customer: 42,
              creditor: 70001,
              debtor: 10001,
              traveler_name: "Person A",
              traveler_role: "owner_manager",
              business_purpose: "Kundentermin",
              splits: [{ postingaccount: 4663, postingtext: "Flug", vat: "0_none", amount: "300.00" }],
            },
          ],
        })
      ).rejects.toThrow(/4670/);
      expect(client.call).not.toHaveBeenCalled();
    });

    it("add_receipt_postings books and records an audit-trail comment when fields are consistent", async () => {
      const client = mockClient({ success: true });
      const [, addReceiptPostings] = createPostingsTools(client);

      await addReceiptPostings.handler({
        receipts: [
          {
            receipt_id_by_customer: 42,
            creditor: 70001,
            debtor: 10001,
            traveler_name: "Person A",
            traveler_role: "owner_manager",
            business_purpose: "Kundentermin in München",
            splits: [{ postingaccount: 4673, postingtext: "Flug", vat: "0_none", amount: "300.00" }],
          },
        ],
      });

      expect(client.call).toHaveBeenCalledWith("postingsAddBatchReceipts", {
        receipts: [
          {
            receipt_id_by_customer: 42,
            creditor: 70001,
            debtor: 10001,
            postingaccounts: [4673],
            postingtexts: ["Flug"],
            vats: ["0_none"],
            amounts: ["300.00"],
          },
        ],
      });
      expect(client.call).toHaveBeenCalledWith("commentsAdd", {
        receipt_id_by_customer: 42,
        comment_text: expect.stringMatching(/Person A.*Unternehmer.*Kundentermin in München/s),
      });
    });

    it("add_transaction_postings rejects a traveler_role/account-range mismatch, without booking", async () => {
      const client = mockClient({ success: true });
      const [, , addTransactionPostings] = createPostingsTools(client);

      await expect(
        addTransactionPostings.handler({
          transactions: [
            {
              transaction_id_by_customer: 7,
              oi_receipts_ids_by_customer: [42],
              traveler_name: "Person A",
              traveler_role: "employee",
              business_purpose: "Kundentermin",
              splits: [{ postingaccount: 4673, postingtext: "Flug", vat: "0_none", amount: "300.00" }],
            },
          ],
        })
      ).rejects.toThrow(/4660/);
      expect(client.call).not.toHaveBeenCalled();
    });

    it("add_transaction_postings books and records an audit-trail comment when fields are consistent", async () => {
      const client = mockClient({ success: true });
      const [, , addTransactionPostings] = createPostingsTools(client);

      await addTransactionPostings.handler({
        transactions: [
          {
            transaction_id_by_customer: 7,
            oi_receipts_ids_by_customer: [42],
            traveler_name: "Person A",
            traveler_role: "employee",
            business_purpose: "Dienstreise Berlin",
            splits: [{ postingaccount: 4663, postingtext: "Bahnticket", vat: "0_none", amount: "150.00" }],
          },
        ],
      });

      expect(client.call).toHaveBeenCalledWith("postingsAddBatchTransactions", {
        transactions: [
          {
            transaction_id_by_customer: 7,
            oi_receipts_ids_by_customer: [42],
            postingaccounts: [4663],
            postingtexts: ["Bahnticket"],
            vats: ["0_none"],
            amounts: ["150.00"],
          },
        ],
      });
      expect(client.call).toHaveBeenCalledWith("commentsAdd", {
        transaction_id_by_customer: 7,
        comment_text: expect.stringMatching(/Person A.*Arbeitnehmer.*Dienstreise Berlin/s),
      });
    });

    it("add_free_postings rejects a travel-expense account without business_purpose, without booking", async () => {
      const client = mockClient({ success: true });
      const [, , , addFreePostings] = createPostingsTools(client);

      await expect(
        addFreePostings.handler({
          free_postings: [
            {
              date: "2026-01-01",
              postingtext: "Reisekostenkorrektur",
              amount: "50.00",
              postingaccount_debit: 4663,
              postingaccount_credit: 1000,
              vat: "0_none",
              traveler_name: "Person A",
              traveler_role: "employee",
            },
          ],
        })
      ).rejects.toThrow(/business_purpose/);
      expect(client.call).not.toHaveBeenCalled();
    });

    it("add_free_postings appends the audit-trail note to postingtext when fields are consistent", async () => {
      const client = mockClient({ success: true });
      const [, , , addFreePostings] = createPostingsTools(client);

      await addFreePostings.handler({
        free_postings: [
          {
            date: "2026-01-01",
            postingtext: "Reisekostenkorrektur",
            amount: "50.00",
            postingaccount_debit: 4663,
            postingaccount_credit: 1000,
            vat: "0_none",
            traveler_name: "Person A",
            traveler_role: "employee",
            business_purpose: "Dienstreise Berlin",
          },
        ],
      });

      expect(client.call).toHaveBeenCalledWith("postingsAddBatchFree", {
        free_postings: [
          expect.objectContaining({
            postingtext: expect.stringMatching(/^Reisekostenkorrektur.*Person A.*Arbeitnehmer.*Dienstreise Berlin/s),
          }),
        ],
      });
    });

    it("add_free_postings leaves ordinary postings untouched", async () => {
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
            vat: "0_none",
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
            vat: "0_none",
          },
        ],
      });
    });
  });
});
