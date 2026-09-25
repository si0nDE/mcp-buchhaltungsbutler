import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createPostingsTools } from "./postings.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

function keyedMockClient(responses: Record<string, unknown>): BBClient {
  return {
    call: vi.fn((key: string) => {
      if (!(key in responses)) throw new Error(`unexpected call: ${key}`);
      const value = responses[key];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }) as BBClient["call"],
  };
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

  describe("entertainment expense (Bewirtungskosten) account validation", () => {
    it("add_receipt_postings rejects a deductible split without a paired non-deductible split", async () => {
      const client = mockClient({ success: true });
      const [, addReceiptPostings] = createPostingsTools(client);

      await expect(
        addReceiptPostings.handler({
          receipts: [
            {
              receipt_id_by_customer: 42,
              creditor: 70001,
              debtor: 10001,
              participants: "Person A, Person B",
              occasion: "Kundengespräch",
              host_confirmed: true,
              splits: [{ postingaccount: 4650, postingtext: "Bewirtung", vat: "19_vat", amount: "70.00" }],
            },
          ],
        })
      ).rejects.toThrow(/4654/);
      expect(client.call).not.toHaveBeenCalled();
    });

    it("add_receipt_postings rejects missing occasion, without booking", async () => {
      const client = mockClient({ success: true });
      const [, addReceiptPostings] = createPostingsTools(client);

      await expect(
        addReceiptPostings.handler({
          receipts: [
            {
              receipt_id_by_customer: 42,
              creditor: 70001,
              debtor: 10001,
              participants: "Person A, Person B",
              host_confirmed: true,
              splits: [
                { postingaccount: 4650, postingtext: "Bewirtung", vat: "19_vat", amount: "70.00" },
                { postingaccount: 4654, postingtext: "Bewirtung nicht abz.", vat: "19_vat", amount: "30.00" },
              ],
            },
          ],
        })
      ).rejects.toThrow(/occasion/);
      expect(client.call).not.toHaveBeenCalled();
    });

    it("add_receipt_postings rejects host_confirmed: false, asking the caller to check with the user", async () => {
      const client = mockClient({ success: true });
      const [, addReceiptPostings] = createPostingsTools(client);

      await expect(
        addReceiptPostings.handler({
          receipts: [
            {
              receipt_id_by_customer: 42,
              creditor: 70001,
              debtor: 10001,
              participants: "Person A, Person B",
              occasion: "Kundengespräch",
              host_confirmed: false,
              splits: [
                { postingaccount: 4650, postingtext: "Bewirtung", vat: "19_vat", amount: "70.00" },
                { postingaccount: 4654, postingtext: "Bewirtung nicht abz.", vat: "19_vat", amount: "30.00" },
              ],
            },
          ],
        })
      ).rejects.toThrow(/ask the user/);
      expect(client.call).not.toHaveBeenCalled();
    });

    it("add_receipt_postings rejects a split ratio that isn't approximately 70/30", async () => {
      const client = mockClient({ success: true });
      const [, addReceiptPostings] = createPostingsTools(client);

      await expect(
        addReceiptPostings.handler({
          receipts: [
            {
              receipt_id_by_customer: 42,
              creditor: 70001,
              debtor: 10001,
              participants: "Person A, Person B",
              occasion: "Kundengespräch",
              host_confirmed: true,
              splits: [
                { postingaccount: 4650, postingtext: "Bewirtung", vat: "19_vat", amount: "50.00" },
                { postingaccount: 4654, postingtext: "Bewirtung nicht abz.", vat: "19_vat", amount: "50.00" },
              ],
            },
          ],
        })
      ).rejects.toThrow(/70.*30/);
      expect(client.call).not.toHaveBeenCalled();
    });

    it("add_receipt_postings books and records an audit-trail comment when the split and fields are consistent", async () => {
      const client = mockClient({ success: true });
      const [, addReceiptPostings] = createPostingsTools(client);

      await addReceiptPostings.handler({
        receipts: [
          {
            receipt_id_by_customer: 42,
            creditor: 70001,
            debtor: 10001,
            participants: "Person A, Person B",
            occasion: "Kundengespräch",
            host_confirmed: true,
            splits: [
              { postingaccount: 4650, postingtext: "Bewirtung", vat: "19_vat", amount: "70.00" },
              { postingaccount: 4654, postingtext: "Bewirtung nicht abz.", vat: "19_vat", amount: "30.00" },
              { postingaccount: 1576, postingtext: "Vorsteuer", vat: "19_vat", amount: "19.00" },
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
            postingaccounts: [4650, 4654, 1576],
            postingtexts: ["Bewirtung", "Bewirtung nicht abz.", "Vorsteuer"],
            vats: ["19_vat", "19_vat", "19_vat"],
            amounts: ["70.00", "30.00", "19.00"],
          },
        ],
      });
      expect(client.call).toHaveBeenCalledWith("commentsAdd", {
        receipt_id_by_customer: 42,
        comment_text: expect.stringMatching(/Person A, Person B.*Kundengespräch/s),
      });
    });

    it("add_transaction_postings books and records an audit-trail comment when the split and fields are consistent", async () => {
      const client = mockClient({ success: true });
      const [, , addTransactionPostings] = createPostingsTools(client);

      await addTransactionPostings.handler({
        transactions: [
          {
            transaction_id_by_customer: 7,
            oi_receipts_ids_by_customer: [42],
            participants: "Person A, Person B",
            occasion: "Kundengespräch",
            host_confirmed: true,
            splits: [
              { postingaccount: 6640, postingtext: "Bewirtung", vat: "19_vat", amount: "70.00" },
              { postingaccount: 6644, postingtext: "Bewirtung nicht abz.", vat: "19_vat", amount: "30.00" },
            ],
          },
        ],
      });

      expect(client.call).toHaveBeenCalledWith("postingsAddBatchTransactions", {
        transactions: [
          {
            transaction_id_by_customer: 7,
            oi_receipts_ids_by_customer: [42],
            postingaccounts: [6640, 6644],
            postingtexts: ["Bewirtung", "Bewirtung nicht abz."],
            vats: ["19_vat", "19_vat"],
            amounts: ["70.00", "30.00"],
          },
        ],
      });
      expect(client.call).toHaveBeenCalledWith("commentsAdd", {
        transaction_id_by_customer: 7,
        comment_text: expect.stringMatching(/Person A, Person B.*Kundengespräch/s),
      });
    });
  });

  describe("confirm_payment", () => {
    it("rejects a receipt/transaction amount mismatch without assigning or booking", async () => {
      const client = keyedMockClient({
        receiptsGetIdByCustomer: {
          success: true,
          data: { amount: "123.45", invoicenumber: "RE-2026-0042", counterparty: "Musterfirma GmbH" },
        },
        transactionsGetIdByCustomer: { success: true, data: { amount: "-100.00" } },
      });
      const [, , , , , , confirmPayment] = createPostingsTools(client);

      await expect(
        confirmPayment.handler({
          receipt_id_by_customer: 1111,
          transaction_id_by_customer: 2222,
          posting_account: 70999,
        })
      ).rejects.toThrow(/123.45.*100.00/s);

      expect(client.call).not.toHaveBeenCalledWith("transactionsAssignBatchReceipt", expect.anything());
      expect(client.call).not.toHaveBeenCalledWith("postingsAddBatchTransactions", expect.anything());
    });

    it("assigns and books the settlement posting when amounts match, reporting status booked", async () => {
      const client = keyedMockClient({
        receiptsGetIdByCustomer: {
          success: true,
          data: { amount: "123.45", invoicenumber: "RE-2026-0042", counterparty: "Musterfirma GmbH" },
        },
        transactionsGetIdByCustomer: { success: true, data: { amount: "-123.45" } },
        transactionsAssignBatchReceipt: { success: true },
        postingsAddBatchTransactions: { success: true },
      });
      const [, , , , , , confirmPayment] = createPostingsTools(client);

      const result = await confirmPayment.handler({
        receipt_id_by_customer: 1111,
        transaction_id_by_customer: 2222,
        posting_account: 70999,
      });

      expect(client.call).toHaveBeenCalledWith("transactionsAssignBatchReceipt", {
        transactions_to_receipts: [{ transaction_id_by_customer: 2222, receipt_id_by_customer: 1111 }],
      });
      expect(client.call).toHaveBeenCalledWith("postingsAddBatchTransactions", {
        transactions: [
          {
            transaction_id_by_customer: 2222,
            oi_receipts_ids_by_customer: [1111],
            postingaccounts: [70999],
            postingtexts: ["Ausgleich Beleg RE-2026-0042 - Musterfirma GmbH"],
            vats: ["0_none"],
            amounts: ["123.45"],
          },
        ],
      });
      expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "booked" });
    });

    it("uses a caller-supplied postingtext instead of the default", async () => {
      const client = keyedMockClient({
        receiptsGetIdByCustomer: { success: true, data: { amount: "123.45" } },
        transactionsGetIdByCustomer: { success: true, data: { amount: "-123.45" } },
        transactionsAssignBatchReceipt: { success: true },
        postingsAddBatchTransactions: { success: true },
      });
      const [, , , , , , confirmPayment] = createPostingsTools(client);

      await confirmPayment.handler({
        receipt_id_by_customer: 1111,
        transaction_id_by_customer: 2222,
        posting_account: 70999,
        postingtext: "Custom Ausgleichstext",
      });

      expect(client.call).toHaveBeenCalledWith(
        "postingsAddBatchTransactions",
        expect.objectContaining({
          transactions: [expect.objectContaining({ postingtexts: ["Custom Ausgleichstext"] })],
        })
      );
    });

    it("reports status assigned_only, without throwing, when booking fails after a successful assignment", async () => {
      const client = keyedMockClient({
        receiptsGetIdByCustomer: { success: true, data: { amount: "123.45" } },
        transactionsGetIdByCustomer: { success: true, data: { amount: "-123.45" } },
        transactionsAssignBatchReceipt: { success: true },
        postingsAddBatchTransactions: new Error("posting rejected"),
      });
      const [, , , , , , confirmPayment] = createPostingsTools(client);

      const result = await confirmPayment.handler({
        receipt_id_by_customer: 1111,
        transaction_id_by_customer: 2222,
        posting_account: 70999,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe("assigned_only");
      expect(parsed.error).toMatch(/posting rejected/);
    });

    it("propagates a failure from the assignment call itself (nothing was booked)", async () => {
      const client = keyedMockClient({
        receiptsGetIdByCustomer: { success: true, data: { amount: "123.45" } },
        transactionsGetIdByCustomer: { success: true, data: { amount: "-123.45" } },
        transactionsAssignBatchReceipt: new Error("assignment rejected"),
      });
      const [, , , , , , confirmPayment] = createPostingsTools(client);

      await expect(
        confirmPayment.handler({
          receipt_id_by_customer: 1111,
          transaction_id_by_customer: 2222,
          posting_account: 70999,
        })
      ).rejects.toThrow(/assignment rejected/);

      expect(client.call).not.toHaveBeenCalledWith("postingsAddBatchTransactions", expect.anything());
    });
  });
});
