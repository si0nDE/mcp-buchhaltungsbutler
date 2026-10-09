import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createReceiptsTools } from "./receipts.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

function receipt(id: string, counterparty: string): Record<string, unknown> {
  return {
    id_by_customer: id,
    type: "invoice inbound",
    date: "2026-01-01",
    counterparty,
    amount: "10.00",
    invoicenumber: `R-${id}`,
    due_date: null,
    deleted: "0",
  };
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

  it("list_receipts filters counterparty as a case-insensitive substring, client-side", async () => {
    const client: BBClient = {
      call: vi.fn().mockResolvedValue({
        success: true,
        rows: 2,
        data: [receipt("1", "Musterfirma GmbH"), receipt("2", "ACME Corp")],
      }),
    };
    const [listReceipts] = createReceiptsTools(client);

    const result = await listReceipts.handler({ list_direction: "inbound", counterparty: "muster" });

    // counterparty must not be sent to the API — it only matches exactly there.
    expect(client.call).toHaveBeenCalledWith("receiptsGet", {
      list_direction: "inbound",
      limit: 500,
      offset: 0,
    });
    expect(JSON.parse(result.content[0].text)).toEqual([
      expect.objectContaining({ id_by_customer: "1", counterparty: "Musterfirma GmbH" }),
    ]);
  });

  it("list_receipts sweeps multiple pages for counterparty and applies limit/offset after filtering", async () => {
    const page0 = Array.from({ length: 500 }, (_, i) => receipt(`p0-${i}`, "ACME Corp"));
    const page1 = [receipt("match-1", "Musterfirma GmbH"), receipt("match-2", "Musterfirma GmbH")];
    const call = vi.fn().mockResolvedValueOnce({ success: true, rows: 500, data: page0 }).mockResolvedValueOnce({
      success: true,
      rows: page1.length,
      data: page1,
    });
    const client: BBClient = { call };
    const [listReceipts] = createReceiptsTools(client);

    const result = await listReceipts.handler({
      list_direction: "inbound",
      counterparty: "muster",
      limit: 1,
      offset: 1,
    });

    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenNthCalledWith(1, "receiptsGet", { list_direction: "inbound", limit: 500, offset: 0 });
    expect(call).toHaveBeenNthCalledWith(2, "receiptsGet", { list_direction: "inbound", limit: 500, offset: 500 });
    expect(JSON.parse(result.content[0].text)).toEqual([
      expect.objectContaining({ id_by_customer: "match-2" }),
    ]);
    expect(result.structuredContent?.truncated).toBeUndefined();
  });

  it("list_receipts reports truncated when the counterparty sweep hits the page cap", async () => {
    const fullPage = { success: true, rows: 500, data: Array.from({ length: 500 }, (_, i) => receipt(`x-${i}`, "ACME")) };
    const client: BBClient = { call: vi.fn().mockResolvedValue(fullPage) };
    const [listReceipts] = createReceiptsTools(client);

    const result = await listReceipts.handler({ list_direction: "inbound", counterparty: "acme" });

    expect(client.call).toHaveBeenCalledTimes(20);
    expect(result.structuredContent?.truncated).toBe(true);
  });

  it("get_receipt calls receiptsGetIdByCustomer with idSuffix", async () => {
    const client = mockClient({ success: true, data: { id_by_customer: "42" } });
    const [, getReceipt] = createReceiptsTools(client);

    await getReceipt.handler({ id_by_customer: 42 });

    expect(client.call).toHaveBeenCalledWith("receiptsGetIdByCustomer", {}, { idSuffix: 42 });
  });

  it("get_receipt with extract_text forces get_file: true in the request regardless of the caller's get_file", async () => {
    const client = mockClient({ success: true, data: { id_by_customer: "42", file_type: "xml" } });
    const [, getReceipt] = createReceiptsTools(client);

    await getReceipt.handler({ id_by_customer: 42, get_file: false, extract_text: true });

    expect(client.call).toHaveBeenCalledWith(
      "receiptsGetIdByCustomer",
      { get_file: true },
      { idSuffix: 42 }
    );
  });

  it("get_receipt with extract_text replaces file_content with extracted file_text for a text PDF", async () => {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([300, 100]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    page.drawText("Rechnung Nr. 92119", { x: 50, y: 50, size: 12, font });
    const fileContent = Buffer.from(await pdfDoc.save()).toString("base64");

    const client = mockClient({
      success: true,
      data: { id_by_customer: "42", file_type: "pdf", file_content: fileContent },
    });
    const [, getReceipt] = createReceiptsTools(client);

    const result = await getReceipt.handler({ id_by_customer: 42, extract_text: true });

    const data = result.structuredContent!.data as { data: { file_text?: string; file_content?: string } };
    expect(data.data.file_text).toBe("Rechnung Nr. 92119");
    expect(data.data).not.toHaveProperty("file_content");
  });

  it("get_receipt with extract_text falls back to file_content when the receipt isn't a PDF", async () => {
    const client = mockClient({
      success: true,
      data: { id_by_customer: "42", file_type: "xml", file_content: "PHhtbC8+" },
    });
    const [, getReceipt] = createReceiptsTools(client);

    const result = await getReceipt.handler({ id_by_customer: 42, extract_text: true });

    const data = result.structuredContent!.data as { data: { file_text?: string; file_content?: string } };
    expect(data.data.file_content).toBe("PHhtbC8+");
    expect(data.data).not.toHaveProperty("file_text");
  });

  it("get_receipt with extract_text falls back to file_content when nothing could be extracted (e.g. a scan)", async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([200, 200]);
    const fileContent = Buffer.from(await pdfDoc.save()).toString("base64");

    const client = mockClient({
      success: true,
      data: { id_by_customer: "42", file_type: "pdf", file_content: fileContent },
    });
    const [, getReceipt] = createReceiptsTools(client);

    const result = await getReceipt.handler({ id_by_customer: 42, extract_text: true });

    const data = result.structuredContent!.data as { data: { file_text?: string; file_content?: string } };
    expect(data.data.file_content).toBe(fileContent);
    expect(data.data).not.toHaveProperty("file_text");
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

  it("list_receipts passes include_offers through to receiptsGet", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [listReceipts] = createReceiptsTools(client);

    await listReceipts.handler({ list_direction: "outbound", include_offers: true });

    expect(client.call).toHaveBeenCalledWith("receiptsGet", {
      list_direction: "outbound",
      include_offers: true,
      limit: 20,
      offset: 0,
    });
  });

});

describe("list_receipts list_direction both", () => {
  it("queries both directions, tags rows and merges by date", async () => {
    const call = vi.fn((_k: string, p: { list_direction: string }) =>
      Promise.resolve({
        data: [{ id_by_customer: p.list_direction === "inbound" ? 1 : 2, date: p.list_direction === "inbound" ? "2026-01-01" : "2026-02-01" }],
      })
    );
    const [listReceipts] = createReceiptsTools({ call } as unknown as BBClient);
    const res = JSON.parse((await listReceipts.handler({ list_direction: "both", limit: 20, offset: 0, full: false })).content[0].text);
    expect(res.map((r: { id_by_customer: number; list_direction: string }) => [r.id_by_customer, r.list_direction])).toEqual([
      [2, "outbound"],
      [1, "inbound"],
    ]);
  });
});
