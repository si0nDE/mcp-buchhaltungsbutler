import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createReceiptsTools } from "./receipts.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("receipts tools", () => {
  it("list_receipts trims fields and defaults limit to 20", async () => {
    const client = mockClient({
      success: true,
      rows: 1,
      data: [
        {
          id_by_customer: "1",
          type: "invoice inbound",
          date: "2026-01-01",
          counterparty: "ACME",
          amount: "10.00",
          invoicenumber: "R-1",
          due_date: "2026-01-15",
          deleted: "0",
          filename: "x.pdf",
        },
      ],
    });
    const [listReceipts] = createReceiptsTools(client);

    const result = await listReceipts.handler({ list_direction: "inbound" });

    expect(client.call).toHaveBeenCalledWith("receiptsGet", {
      list_direction: "inbound",
      limit: 20,
      offset: 0,
    });
    expect(JSON.parse(result.content[0].text)).toEqual([
      {
        id_by_customer: "1",
        type: "invoice inbound",
        date: "2026-01-01",
        counterparty: "ACME",
        amount: "10.00",
        invoicenumber: "R-1",
        due_date: "2026-01-15",
        deleted: "0",
      },
    ]);
  });

  it("list_receipts passes order through to receiptsGet", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [listReceipts] = createReceiptsTools(client);

    await listReceipts.handler({
      list_direction: "inbound",
      order: { date: "ASC", amount: "DESC" },
    });

    expect(client.call).toHaveBeenCalledWith("receiptsGet", {
      list_direction: "inbound",
      order: { date: "ASC", amount: "DESC" },
      limit: 20,
      offset: 0,
    });
  });

  it("get_receipt calls receiptsGetIdByCustomer with idSuffix", async () => {
    const client = mockClient({ success: true, data: { id_by_customer: "42" } });
    const [, getReceipt] = createReceiptsTools(client);

    await getReceipt.handler({ id_by_customer: 42 });

    expect(client.call).toHaveBeenCalledWith("receiptsGetIdByCustomer", {}, { idSuffix: 42 });
  });

  it("create_receipts calls receiptsAddBatch with a receipts array", async () => {
    const client = mockClient({ success: true });
    const [, , createReceipts] = createReceiptsTools(client);

    await createReceipts.handler({
      receipts: [
        {
          type: "invoice inbound",
          counterparty: "ACME",
          invoice_number: "R-1",
          date: "2026-01-01",
          amount: 10,
          currency: "EUR",
        },
      ],
    });

    expect(client.call).toHaveBeenCalledWith("receiptsAddBatch", {
      receipts: [
        {
          type: "invoice inbound",
          counterparty: "ACME",
          invoice_number: "R-1",
          date: "2026-01-01",
          amount: 10,
          currency: "EUR",
        },
      ],
    });
  });

  it("upload_receipt calls receiptsUpload", async () => {
    const client = mockClient({ success: true, id_by_customer: "9" });
    const [, , , uploadReceipt] = createReceiptsTools(client);

    await uploadReceipt.handler({ file: "base64...", type: "invoice inbound" });

    expect(client.call).toHaveBeenCalledWith("receiptsUpload", { file: "base64...", type: "invoice inbound" });
  });

  it("set_receipt_deleted true calls receiptsDeleteIdByCustomer", async () => {
    const client = mockClient({ success: true });
    const [, , , , setReceiptDeleted] = createReceiptsTools(client);

    await setReceiptDeleted.handler({ id_by_customer: 42, deleted: true });

    expect(client.call).toHaveBeenCalledWith("receiptsDeleteIdByCustomer", {}, { idSuffix: 42 });
  });

  it("set_receipt_deleted false calls receiptsRestoreIdByCustomer", async () => {
    const client = mockClient({ success: true });
    const [, , , , setReceiptDeleted] = createReceiptsTools(client);

    await setReceiptDeleted.handler({ id_by_customer: 42, deleted: false });

    expect(client.call).toHaveBeenCalledWith("receiptsRestoreIdByCustomer", {}, { idSuffix: 42 });
  });

  it("get_receipt_transactions calls receiptsAssignedTransactionsGet", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [, , , , , getReceiptTransactions] = createReceiptsTools(client);

    await getReceiptTransactions.handler({ receipt_id_by_customer: 42, confirmed_only: true });

    expect(client.call).toHaveBeenCalledWith("receiptsAssignedTransactionsGet", {
      receipt_id_by_customer: 42,
      confirmed_only: true,
    });
  });
});
