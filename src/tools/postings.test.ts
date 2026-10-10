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
          splits: [
            { postingaccount: 6815, postingtext: "Miete", vat: "0_none", amount: "500.00", receipt_id_by_customer: 42 },
          ],
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

  it("add_transaction_postings books a Drittland SaaS payment with 19_both_511 (guide reverse_charge_drittland)", async () => {
    const client = mockClient({ success: true });
    const [, , addTransactionPostings] = createPostingsTools(client);

    await addTransactionPostings.handler({
      transactions: [
        {
          transaction_id_by_customer: 1001,
          splits: [{ postingaccount: 4964, postingtext: "Beispiel Cloud Inc. RE-0042 Abo", vat: "19_both_511", amount: "86.96", receipt_id_by_customer: 2001 }],
        },
      ],
    });

    expect(client.call).toHaveBeenCalledWith("postingsAddBatchTransactions", {
      transactions: [
        {
          transaction_id_by_customer: 1001,
          oi_receipts_ids_by_customer: [2001],
          postingaccounts: [4964],
          postingtexts: ["Beispiel Cloud Inc. RE-0042 Abo"],
          vats: ["19_both_511"],
          amounts: ["86.96"],
        },
      ],
    });
  });

  it("add_transaction_postings books a Sammelzahlung (guide pfaendung_zahlung_buchen): one split per invoice, interest and costs, sum = payment", async () => {
    const client = mockClient({ success: true });
    const [, , addTransactionPostings] = createPostingsTools(client);
    const splits = [
      { postingaccount: 4980, postingtext: "RE-1", vat: "19_pre", amount: "119.00", receipt_id_by_customer: 11 },
      { postingaccount: 4980, postingtext: "RE-2", vat: "19_pre", amount: "238.00", receipt_id_by_customer: 12 },
      { postingaccount: 2110, postingtext: "Verzugszinsen", vat: "0_none", amount: "12.50" },
      { postingaccount: 4950, postingtext: "Inkassokosten", vat: "0_none", amount: "30.00" },
    ];

    await addTransactionPostings.handler({ transactions: [{ transaction_id_by_customer: 5, splits }] });

    const sent = (client.call as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "postingsAddBatchTransactions")![1].transactions[0];
    expect(sent.amounts).toEqual(["119.00", "238.00", "12.50", "30.00"]);
    expect(sent.amounts.reduce((a: number, b: string) => a + Number(b), 0)).toBeCloseTo(399.5, 2);
    expect(sent.oi_receipts_ids_by_customer).toEqual([11, 12, null, null]);
  });

  it("add_transaction_postings pads oi_receipts_ids_by_customer with null to match the split count, instead of sending a mismatched-length array (the root cause of a live 'internal error' on every call)", async () => {
    const client = mockClient({ success: true });
    const [, , addTransactionPostings] = createPostingsTools(client);

    await addTransactionPostings.handler({
      transactions: [
        {
          transaction_id_by_customer: 1042,
          splits: [{ postingaccount: 4964, postingtext: "Beispiel-Softwarekosten", vat: "19_both_1", amount: "19.33" }],
        },
      ],
    });

    expect(client.call).toHaveBeenCalledWith("postingsAddBatchTransactions", {
      transactions: [
        expect.objectContaining({
          oi_receipts_ids_by_customer: [null],
        }),
      ],
    });
  });

  it("add_transaction_postings positionally aligns oi_receipts_ids_by_customer across multiple splits, null where no receipt is given", async () => {
    const client = mockClient({ success: true });
    const [, , addTransactionPostings] = createPostingsTools(client);

    await addTransactionPostings.handler({
      transactions: [
        {
          transaction_id_by_customer: 7,
          splits: [
            { postingaccount: 6815, postingtext: "Miete", vat: "0_none", amount: "500.00" },
            {
              postingaccount: 6816,
              postingtext: "Nebenkosten",
              vat: "0_none",
              amount: "50.00",
              receipt_id_by_customer: 99,
            },
            { postingaccount: 6817, postingtext: "Sonstiges", vat: "0_none", amount: "10.00" },
          ],
        },
      ],
    });

    expect(client.call).toHaveBeenCalledWith(
      "postingsAddBatchTransactions",
      expect.objectContaining({
        transactions: [expect.objectContaining({ oi_receipts_ids_by_customer: [null, 99, null] })],
      })
    );
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

  it("assign_receipt_to_free_posting accepts the alias free_posting_id_by_customer and requires one id", async () => {
    const client = mockClient({ success: true });
    const [, , , , , assignReceiptToFreePosting] = createPostingsTools(client);

    await assignReceiptToFreePosting.handler({ receipt_id_by_customer: 42, free_posting_id_by_customer: 99 });
    expect(client.call).toHaveBeenCalledWith("postingsAssignReceiptToFreePosting", { receipt_id_by_customer: 42, posting_id_by_customer: 99 });
    await expect(assignReceiptToFreePosting.handler({ receipt_id_by_customer: 42 })).rejects.toThrow(/posting_id_by_customer is required/);
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
              traveler_name: "Person A",
              traveler_role: "employee",
              business_purpose: "Kundentermin",
              splits: [
                { postingaccount: 4673, postingtext: "Flug", vat: "0_none", amount: "300.00", receipt_id_by_customer: 42 },
              ],
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
            traveler_name: "Person A",
            traveler_role: "employee",
            business_purpose: "Dienstreise Berlin",
            splits: [
              {
                postingaccount: 4663,
                postingtext: "Bahnticket",
                vat: "0_none",
                amount: "150.00",
                receipt_id_by_customer: 42,
              },
            ],
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
            oi_receipts_ids_by_customer: [null, null],
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

describe("postings tools: compact, hints, free posting + receipt", () => {
  it("list_postings drops empty fields and links by default, keeps them on request", async () => {
    const row = { id_by_customer: "1", amount: "5.00", oss_origin_country: "", cost_location: null, receipts_assigned_links: "http://x" };
    const client = mockClient({ success: true, rows: 1, data: [row] });
    const [listPostings] = createPostingsTools(client);
    const compact = JSON.parse((await listPostings.handler({ date_from: "2026-01-01", date_to: "2026-01-31" })).content[0].text);
    expect(compact.data[0]).toEqual({ id_by_customer: "1", amount: "5.00" });
    const withLinks = JSON.parse(
      (await listPostings.handler({ date_from: "2026-01-01", date_to: "2026-01-31", include_links: true })).content[0].text
    );
    expect(withLinks.data[0].receipts_assigned_links).toBe("http://x");
    const raw = JSON.parse((await listPostings.handler({ date_from: "2026-01-01", date_to: "2026-01-31", compact: false })).content[0].text);
    expect(raw.data[0]).toEqual(row);
    const picked = JSON.parse(
      (await listPostings.handler({ date_from: "2026-01-01", date_to: "2026-01-31", fields: ["amount"] })).content[0].text
    );
    expect(picked.data[0]).toEqual({ amount: "5.00" });
  });

  it("add_transaction_postings appends a fix to the 'pre tax' error", async () => {
    const client = keyedMockClient({ postingsAddBatchTransactions: new Error("error 17: account must be posted with pre tax") });
    const [, , addTransactionPostings] = createPostingsTools(client);
    await expect(
      addTransactionPostings.handler({
        transactions: [{ transaction_id_by_customer: 1, splits: [{ postingaccount: 4950, postingtext: "x", vat: "19_vat", amount: "1.00" }] }],
      })
    ).rejects.toThrow(/19_pre/);
  });

  it("add_free_postings assigns the receipt to the newly created posting", async () => {
    const existing = { id_by_customer: "5", postingtext: "T", amount: "20.00", debit_postingaccount_number: "1800", credit_postingaccount_number: "8400" };
    const created = { ...existing, id_by_customer: "9" };
    let reads = 0;
    const call = vi.fn((key: string, _params?: unknown) => {
      if (key === "postingsGet") return Promise.resolve({ data: reads++ === 0 ? [existing] : [existing, created] });
      return Promise.resolve({ success: true });
    });
    const [, , , addFreePostings] = createPostingsTools({ call } as unknown as BBClient);
    const res = JSON.parse(
      (
        await addFreePostings.handler({
          free_postings: [
            { date: "2026-03-10", postingtext: "T", amount: "20.00", postingaccount_debit: 1800, postingaccount_credit: 8400, vat: "19_vat", receipt_id_by_customer: 3001 },
          ],
        })
      ).content[0].text
    );
    expect(call).toHaveBeenCalledWith("postingsAssignReceiptToFreePosting", { receipt_id_by_customer: 3001, posting_id_by_customer: 9 });
    expect(res.receipt_assignments).toEqual([{ index: 0, receipt_id_by_customer: 3001, posting_id_by_customer: 9, status: "assigned" }]);
    const sent = call.mock.calls.find((c) => c[0] === "postingsAddBatchFree")![1] as { free_postings: Array<Record<string, unknown>> };
    expect(sent.free_postings[0]).not.toHaveProperty("receipt_id_by_customer");
  });

  it("add_free_postings uses the id from the batch answer without searching", async () => {
    const call = vi.fn((key: string, _params?: unknown) =>
      Promise.resolve(key === "postingsAddBatchFree" ? { success: true, free_postings: [{ success: true, id_by_customer: 776 }] } : { data: [] })
    );
    const [, , , addFreePostings] = createPostingsTools({ call } as unknown as BBClient);
    const res = JSON.parse(
      (
        await addFreePostings.handler({
          free_postings: [
            { date: "2026-01-02", postingtext: "T", amount: "0.01", postingaccount_debit: 1800, postingaccount_credit: 1890, vat: "0_none", receipt_id_by_customer: 19 },
          ],
        })
      ).content[0].text
    );
    expect(call).toHaveBeenCalledWith("postingsAssignReceiptToFreePosting", { receipt_id_by_customer: 19, posting_id_by_customer: 776 });
    expect(res.receipt_assignments[0]).toMatchObject({ posting_id_by_customer: 776, status: "assigned" });
  });

  describe("dry_run", () => {
    function dryClient() {
      const call = vi.fn((key: string) => {
        if (key === "settingsGetPostingaccounts") return Promise.resolve({ data: [{ postingaccount_number: "8400", name: "Umsätze / Erlöse 19/16% Umsatzsteuer" }] });
        throw new Error(`unexpected write/read: ${key}`);
      });
      return { call } as unknown as BBClient;
    }
    const txEntry = (vat: string) => ({
      transactions: [{ transaction_id_by_customer: 1, splits: [{ postingaccount: 4950, postingtext: "x", vat: vat as never, amount: "119.00", receipt_id_by_customer: 5 }] }],
      dry_run: true,
    });

    it("writes nothing, returns the payload and warns about a vat code that does not fit the account", async () => {
      const client = dryClient();
      const [, , addTransactionPostings] = createPostingsTools(client);
      const res = JSON.parse((await addTransactionPostings.handler(txEntry("19_vat"))).content[0].text);
      expect(res).toMatchObject({ dry_run: true, written: false, would_send: { endpoint: "postingsAddBatchTransactions" } });
      expect(res.would_send.body.transactions[0].vats).toEqual(["19_vat"]);
      expect(res.warnings[0]).toMatch(/19_vat.*4950.*19_pre/);
      expect(
        (client.call as ReturnType<typeof vi.fn>).mock.calls.every((c) => ["settingsGetPostingaccounts", "transactionsGet"].includes(c[0]))
      ).toBe(true);
    });

    it("has no warning for the right code", async () => {
      const [, , addTransactionPostings] = createPostingsTools(dryClient());
      const res = JSON.parse((await addTransactionPostings.handler(txEntry("19_pre"))).content[0].text);
      expect(res.warnings).toBeUndefined();
    });

    it("free posting: only the Erlös/Aufwand side is checked, the receipt assignment is announced not made", async () => {
      const [, , , addFreePostings] = createPostingsTools(dryClient());
      const res = JSON.parse(
        (
          await addFreePostings.handler({
            free_postings: [
              { date: "2026-03-10", postingtext: "T", amount: "20.00", postingaccount_debit: 1800, postingaccount_credit: 8400, vat: "19_vat", receipt_id_by_customer: 3001 },
            ],
            dry_run: true,
          })
        ).content[0].text
      );
      expect(res.warnings).toBeUndefined();
      expect(res.would_assign_receipts).toEqual([{ index: 0, receipt_id_by_customer: 3001 }]);
    });

    it("warns about an invoice number in the posting text and leaves the text unchanged", async () => {
      const [, , addTransactionPostings, addFreePostings] = createPostingsTools(dryClient());
      const tx = txEntry("19_pre");
      tx.transactions[0].splits[0].postingtext = "Beispiel GmbH RE-0001 (privat)";
      const res = JSON.parse((await addTransactionPostings.handler(tx)).content[0].text);
      expect(res.warnings.join(" ")).toMatch(/Vorschlag: "Beispiel GmbH"/);
      expect(res.would_send.body.transactions[0].postingtexts).toEqual(["Beispiel GmbH RE-0001 (privat)"]);

      const free = JSON.parse(
        (
          await addFreePostings.handler({
            free_postings: [{ date: "2026-03-10", postingtext: "Kanzlei 2026-12345 Kosten", amount: "20.00", postingaccount_debit: 4950, postingaccount_credit: 1590, vat: "19_pre" }],
            dry_run: true,
          })
        ).content[0].text
      );
      expect(free.warnings.join(" ")).toMatch(/Vorschlag: "Kanzlei Kosten"/);
    });

    it("asks for the Zahlungsdatum when a free posting books Vorsteuer onto the Interimskonto (Dritter zahlt)", async () => {
      const [, , , addFreePostings] = createPostingsTools(dryClient());
      const run = async (debit: number, credit: number, vat: string) =>
        JSON.parse(
          (await addFreePostings.handler({ free_postings: [{ date: "2026-06-30", postingtext: "Kanzlei Kosten", amount: "388.12", postingaccount_debit: debit, postingaccount_credit: credit, vat: vat as never }], dry_run: true })).content[0].text
        );
      const hit = await run(4950, 1590, "19_pre");
      expect(hit.warnings.join(" ")).toMatch(/Frage vor dem Buchen.*2026-06-30.*Zahlungsdatum erfragen/);
      expect((await run(1590, 2700, "0_none")).warnings).toBeUndefined();
      expect((await run(4950, 1890, "19_pre")).warnings).toBeUndefined();
    });
  });
});
