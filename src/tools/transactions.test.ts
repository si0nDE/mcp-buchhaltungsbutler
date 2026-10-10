import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createTransactionsTools } from "./transactions.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("transactions tools", () => {
  it("list_transactions trims fields and defaults limit to 20", async () => {
    const client = mockClient({
      success: true,
      rows: 1,
      data: [
        { id_by_customer: "1", to_from: "ACME", amount: "-10.00", booking_date: "2026-01-01", value_date: "2026-01-01", purpose: "Miete" },
      ],
    });
    const [listTransactions] = createTransactionsTools(client);

    const result = await listTransactions.handler({});

    expect(client.call).toHaveBeenCalledWith("transactionsGet", { limit: 20, offset: 0 });
    expect(JSON.parse(result.content[0].text)).toEqual([
      { id_by_customer: "1", to_from: "ACME", amount: "-10.00", booking_date: "2026-01-01", purpose: "Miete" },
    ]);
  });

  it("get_transaction calls transactionsGetIdByCustomer with idSuffix", async () => {
    const client = mockClient({ success: true, data: {} });
    const [, getTransaction] = createTransactionsTools(client);

    await getTransaction.handler({ id_by_customer: 7 });

    expect(client.call).toHaveBeenCalledWith("transactionsGetIdByCustomer", {}, { idSuffix: 7 });
  });

  it("create_transactions calls transactionsAddBatch", async () => {
    const client = mockClient({ success: true });
    const [, , createTransactions] = createTransactionsTools(client);

    await createTransactions.handler({
      transactions: [{ account: 1200, to_from: "ACME", amount: -10, booking_date: "2026-01-01 00:00:00" }],
    });

    expect(client.call).toHaveBeenCalledWith("transactionsAddBatch", {
      transactions: [{ account: 1200, to_from: "ACME", amount: -10, booking_date: "2026-01-01 00:00:00" }],
    });
  });

  it("assign_receipts_to_transactions calls transactionsAssignBatchReceipt", async () => {
    const client = mockClient({ success: true });
    const [, , , assignReceiptsToTransactions] = createTransactionsTools(client);

    await assignReceiptsToTransactions.handler({
      assignments: [{ transaction_id_by_customer: 7, receipt_id_by_customer: 42 }],
    });

    expect(client.call).toHaveBeenCalledWith("transactionsAssignBatchReceipt", {
      transactions_to_receipts: [{ transaction_id_by_customer: 7, receipt_id_by_customer: 42 }],
    });
  });

  it("unassign_receipt calls transactionsUnassignReceipt", async () => {
    const client = mockClient({ success: true });
    const [, , , , unassignReceipt] = createTransactionsTools(client);

    await unassignReceipt.handler({ transaction_id_by_customer: 7, receipt_id_by_customer: 42 });

    expect(client.call).toHaveBeenCalledWith("transactionsUnassignReceipt", {
      transaction_id_by_customer: 7,
      receipt_id_by_customer: 42,
    });
  });

  it("get_transaction_receipts calls transactionsAssignedReceiptsGet", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [, , , , , getTransactionReceipts] = createTransactionsTools(client);

    await getTransactionReceipts.handler({ transaction_id_by_customer: 7 });

    expect(client.call).toHaveBeenCalledWith("transactionsAssignedReceiptsGet", {
      transaction_id_by_customer: 7,
    });
  });

  it("list_transactions query sweeps the window, filters locally and reports counts before and after", async () => {
    const rows = [
      { id_by_customer: "1", to_from: "Beispiel Cloud Inc.", amount: "-10.00", booking_date: "2026-01-01", purpose: "Abo" },
      { id_by_customer: "2", to_from: "ACME", amount: "-5.00", booking_date: "2026-01-02", purpose: "BEISPIEL Rechnung 7" },
      { id_by_customer: "3", to_from: "ACME", amount: "-1.00", booking_date: "2026-01-03", purpose: "Miete" },
    ];
    const client = mockClient({ success: true, rows: 3, data: rows });
    const [listTransactions] = createTransactionsTools(client);

    const result = await listTransactions.handler({ query: "beispiel", date_from: "2026-01-01", date_to: "2026-01-31", limit: 20, offset: 0 });

    expect(client.call).toHaveBeenCalledWith("transactionsGet", { date_from: "2026-01-01", date_to: "2026-01-31", limit: 500, offset: 0 });
    expect(JSON.parse(result.content[0].text).map((r: { id_by_customer: string }) => r.id_by_customer)).toEqual(["1", "2"]);
    expect(result.content[1].text).toMatch(/3 transactions scanned.*2 matched, 2 returned/);
    expect(result.structuredContent?.query_counts).toEqual({ scanned: 3, matched: 2, returned: 2, truncated: false });
  });
});

describe("posting status on transactions", () => {
  const txs = [
    { id_by_customer: "5001", to_from: "A", amount: "559.30", booking_date: "2026-03-03 00:00:00", purpose: "x" },
    { id_by_customer: "5002", to_from: "B", amount: "-10.00", booking_date: "2026-03-03 00:00:00", purpose: "y" },
  ];
  const postings = [
    { id_by_customer: "8001", transaction_id_by_customer: "5001", fixed: "0" },
    { id_by_customer: "8002", transaction_id_by_customer: "5001", fixed: "0" },
    { id_by_customer: "8003", transaction_id_by_customer: null, fixed: "0" },
  ];
  const client = (): BBClient => ({
    call: vi.fn(async (key: string) => (key === "postingsGet" ? { data: postings } : { data: txs })),
  }) as unknown as BBClient;

  it("list_transactions with_posting_status marks booked and open transactions", async () => {
    const c = client();
    const [list] = createTransactionsTools(c);
    const result = await list.handler({ with_posting_status: true });
    const rows = JSON.parse(result.content[0].text);
    expect(rows[0].posting_status).toEqual({ booked: true, posting_ids: ["8001", "8002"], splits: 2, fixed: false });
    expect(rows[1].posting_status.booked).toBe(false);
    expect(c.call).toHaveBeenCalledWith("postingsGet", expect.objectContaining({ date_from: "2026-03-03", date_to: "2026-03-03", posting_status: "all" }));
  });

  it("list_transactions booked=false returns only open transactions", async () => {
    const [list] = createTransactionsTools(client());
    const result = await list.handler({ booked: false });
    const rows = JSON.parse(result.content[0].text);
    expect(rows.map((r: { id_by_customer: string }) => r.id_by_customer)).toEqual(["5002"]);
  });

  it("get_transaction adds posting_status", async () => {
    const c = { call: vi.fn(async (key: string) => (key === "postingsGet" ? { data: postings } : { data: txs[0] })) } as unknown as BBClient;
    const [, get] = createTransactionsTools(c);
    const result = await get.handler({ id_by_customer: 5001 });
    expect(JSON.parse(result.content[0].text).data.posting_status.booked).toBe(true);
  });
});
