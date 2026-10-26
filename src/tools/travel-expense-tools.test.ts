import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createServer } from "../server.js";
import { assertPurposeIsConcrete } from "./travel-expense-tools.js";

// All data is invented.
async function connect(call: (key: string, params: Record<string, unknown>) => unknown) {
  const server = createServer({ call: async (k: string, p: Record<string, unknown>) => call(k, p) } as unknown as BBClient);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  await client.listTools();
  return client;
}

const base = {
  traveller_name: "Erika Mustermann",
  traveller_type: "employee",
  traveller_confirmed: true,
  purpose: "Kundentermin Einführung Backup-Konzept bei Muster AG",
  departure: "2026-03-09T07:00",
  return: "2026-03-11T18:00",
  stops: [{ country: "Deutschland", arrival: "2026-03-09T09:00" }],
  company_name: "Beispiel GmbH",
};
const data = (res: unknown) => (res as { structuredContent: { data: Record<string, any> } }).structuredContent.data;
const errorText = (res: unknown) => JSON.stringify((res as { content: unknown }).content);

describe("assertPurposeIsConcrete", () => {
  it.each(["Geschäftsreise", "Dienstreise", "  Kundenbesuch ", "Meeting", "kurz"])("rejects %s", (purpose) => {
    expect(() => assertPurposeIsConcrete(purpose)).toThrow(/Reisezweck/);
  });
  it("accepts a concrete purpose", () => {
    expect(() => assertPurposeIsConcrete("Kundentermin Einführung Backup-Konzept bei Muster AG")).not.toThrow();
  });
});

describe("generate_travel_expense_report over the MCP client", () => {
  it("returns pdf, totals, days and a booking hint for a domestic trip", async () => {
    const client = await connect(() => ({}));
    const res = await client.callTool({ name: "generate_travel_expense_report", arguments: { ...base, use_lodging_flat_rate: true } });
    expect(res.isError).toBeFalsy();
    const d = data(res);
    expect(typeof d.pdf_base64).toBe("string");
    expect(d.totals.allowances).toBe(56);
    expect(d.totals.lodgingFlat).toBe(40);
    expect(d.totals.total).toBe(96);
    expect(d.days).toHaveLength(3);
    expect(d.booking_hint.chart).toBe("unknown");
    expect(d.booking_hint.splits.every((s: { account?: number }) => s.account === undefined)).toBe(true);
  });

  it("requires the traveller confirmation", async () => {
    const client = await connect(() => ({}));
    const res = await client.callTool({ name: "generate_travel_expense_report", arguments: { ...base, traveller_confirmed: false } });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("bestätigt");
  });

  it("rejects vague purposes", async () => {
    const client = await connect(() => ({}));
    const res = await client.callTool({ name: "generate_travel_expense_report", arguments: { ...base, purpose: "Geschäftsreise" } });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("Reisezweck");
  });

  it("requires the agreement answer for shareholder managers and warns about vGA when it is false", async () => {
    const client = await connect(() => ({}));
    const missing = await client.callTool({
      name: "generate_travel_expense_report",
      arguments: { ...base, traveller_type: "self_employed", is_shareholder_manager: true },
    });
    expect(missing.isError).toBe(true);
    expect(errorText(missing)).toContain("agreement_in_advance");
    const no = await client.callTool({
      name: "generate_travel_expense_report",
      arguments: { ...base, traveller_type: "self_employed", is_shareholder_manager: true, agreement_in_advance: false },
    });
    expect(no.isError).toBeFalsy();
    expect(data(no).warnings.some((w: string) => w.includes("vGA"))).toBe(true);
  });

  it("rejects the lodging flat rate for self-employed and the flat km rate for business cars", async () => {
    const client = await connect(() => ({}));
    const flat = await client.callTool({
      name: "generate_travel_expense_report",
      arguments: { ...base, traveller_type: "self_employed", use_lodging_flat_rate: true },
    });
    expect(flat.isError).toBe(true);
    const car = await client.callTool({
      name: "generate_travel_expense_report",
      arguments: { ...base, km_trips: [{ mode: "car", km: 100, date: "2026-03-09", ownership: "business" }] },
    });
    expect(car.isError).toBe(true);
  });

  it("warns when a trip with nights has neither lodging receipts nor a flat rate", async () => {
    const client = await connect(() => ({}));
    const res = await client.callTool({ name: "generate_travel_expense_report", arguments: base });
    expect(data(res).warnings.some((w: string) => w.includes("Übernachtung"))).toBe(true);
  });

  it("employee breakfast in the hotel counts as a provided meal on the next morning", async () => {
    const client = await connect(() => ({}));
    const res = await client.callTool({
      name: "generate_travel_expense_report",
      arguments: {
        ...base,
        expenses: [
          { category: "lodging", description: "Hotel Musterstadt", date: "2026-03-09", amount: 107, vat_amount: 7, vat_rate: 7, invoice_recipient: "company", breakfast_included: true },
        ],
      },
    });
    expect(res.isError).toBeFalsy();
    const day = data(res).days.find((d: { date: string }) => d.date === "2026-03-10");
    expect(day.reduction).toBe(5.6);
  });

  it("appends attachments to the PDF", async () => {
    const { PDFDocument, PageSizes } = await import("pdf-lib");
    const attachment = await PDFDocument.create();
    attachment.addPage(PageSizes.A4);
    const file = Buffer.from(await attachment.save()).toString("base64");
    const client = await connect(() => ({}));
    const plain = data(await client.callTool({ name: "generate_travel_expense_report", arguments: base }));
    const withAtt = data(
      await client.callTool({ name: "generate_travel_expense_report", arguments: { ...base, attachments: [{ file, type: "pdf" }] } })
    );
    const pages = async (b64: string) => (await PDFDocument.load(Buffer.from(b64, "base64"))).getPageCount();
    expect(await pages(withAtt.pdf_base64)).toBe((await pages(plain.pdf_base64)) + 1);
    expect(withAtt.warnings.some((w: string) => w.includes("E-Rechnung"))).toBe(true);
  });
});

describe("lodging_nights and two-rate receipts", () => {
  it("lodging_nights caps the lodging flat rate (2 derived nights, 1 paid)", async () => {
    const client = await connect(() => ({}));
    const res = await client.callTool({
      name: "generate_travel_expense_report",
      arguments: { ...base, use_lodging_flat_rate: true, lodging_nights: 1 },
    });
    expect(res.isError).toBeFalsy();
    expect(data(res).totals.lodgingFlat).toBe(20);
  });

  it("a receipt with two VAT rates is entered as two expenses", async () => {
    const client = await connect(() => ({}));
    const res = await client.callTool({
      name: "generate_travel_expense_report",
      arguments: {
        ...base,
        expenses: [
          { category: "lodging", description: "Hotel Musterstadt Zimmer", date: "2026-03-09", amount: 107, vat_amount: 7, vat_rate: 7, invoice_recipient: "company" },
          { category: "incidental", description: "Hotel Musterstadt Getränke", date: "2026-03-09", amount: 11.9, vat_amount: 1.9, vat_rate: 19, invoice_recipient: "company" },
        ],
      },
    });
    expect(res.isError).toBeFalsy();
    expect(data(res).costs).toHaveLength(2);
  });
});

describe("generate_and_upload_travel_expense_report", () => {
  const chartRows = { data: [{ postingaccount_number: "8400", name: "Erlöse 19 % USt" }] };

  it("uploads the PDF, uses the chart for account numbers and returns the id instead of the pdf", async () => {
    const call = vi.fn(async (key: string, _params?: Record<string, unknown>) => {
      if (key === "receiptsUpload") return { id_by_customer: 4711 };
      if (key === "settingsGetPostingaccounts") return chartRows;
      return { data: [] };
    });
    const client = await connect(call);
    const res = await client.callTool({
      name: "generate_and_upload_travel_expense_report",
      arguments: { ...base, use_lodging_flat_rate: true },
    });
    expect(res.isError).toBeFalsy();
    const d = data(res);
    expect(d.id_by_customer).toBe(4711);
    expect(d.pdf_base64).toBeUndefined();
    expect(d.booking_hint.chart).toBe("SKR03");
    expect(d.booking_hint.splits.length).toBeGreaterThan(0);
    expect(d.booking_hint.splits.every((s: { account?: number }) => typeof s.account === "number")).toBe(true);
    const upload = call.mock.calls.find(([key]) => key === "receiptsUpload");
    expect(upload).toBeDefined();
    const params = upload![1] as Record<string, unknown>;
    expect(params.counterparty).toBe("Erika Mustermann");
    expect(params.date).toBe("2026-03-11");
    expect(params.amount).toBe(96);
    expect(String(params.file_name)).toContain("Reisekostenabrechnung");
  });

  it("falls back to chart unknown when the catalog call fails, without failing the upload", async () => {
    const call = vi.fn(async (key: string, _params?: Record<string, unknown>) => {
      if (key === "receiptsUpload") return { id_by_customer: 4712 };
      if (key === "settingsGetPostingaccounts") throw new Error("catalog down");
      return { data: [] };
    });
    const client = await connect(call);
    const res = await client.callTool({
      name: "generate_and_upload_travel_expense_report",
      arguments: { ...base, use_lodging_flat_rate: true },
    });
    expect(res.isError).toBeFalsy();
    const d = data(res);
    expect(d.id_by_customer).toBe(4712);
    expect(d.booking_hint.chart).toBe("unknown");
    expect(d.booking_hint.splits.every((s: { account?: number }) => s.account === undefined)).toBe(true);
  });
});

describe("upload error handling and warnings (fix round 1)", () => {
  const upload = (call: (k: string, p: Record<string, unknown>) => unknown, args: Record<string, unknown> = {}) =>
    connect(call).then((c) =>
      c.callTool({ name: "generate_and_upload_travel_expense_report", arguments: { ...base, use_lodging_flat_rate: true, ...args } })
    );
  const hotel = { category: "lodging", description: "Hotel Musterstadt", date: "2026-03-09", amount: 107, vat_amount: 7, vat_rate: 7, invoice_recipient: "company" };

  it("rethrows an upload failure with the duplicate-risk text", async () => {
    const res = await upload((k) => {
      if (k === "receiptsUpload") throw new Error("HTTP 500");
      return { data: [] };
    });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("HTTP 500");
    expect(errorText(res)).toContain("list_receipts");
  });

  it("treats success:false as a failure", async () => {
    const res = await upload((k) => (k === "receiptsUpload" ? { success: false, message: "Kontingent erschöpft" } : { data: [] }));
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("Kontingent erschöpft");
    expect(errorText(res)).toContain("list_receipts");
  });

  it.each([{}, undefined])("warns instead of failing when the response has no id (%j)", async (response) => {
    const res = await upload((k) => (k === "receiptsUpload" ? response : { data: [] }));
    expect(res.isError).toBeFalsy();
    expect(data(res).id_by_customer).toBeNull();
    expect(data(res).warnings).toContain("Upload ohne ID quittiert: per list_receipts prüfen, nicht erneut hochladen.");
  });

  it("warns about lodging flat rate plus lodging receipt", async () => {
    const client = await connect(() => ({}));
    const both = data(
      await client.callTool({ name: "generate_travel_expense_report", arguments: { ...base, use_lodging_flat_rate: true, expenses: [hotel] } })
    );
    expect(both.warnings.some((w: string) => w.includes("Übernachtungspauschale für 2 Nächte und Übernachtungsbeleg"))).toBe(true);
    const capped = data(
      await client.callTool({
        name: "generate_travel_expense_report",
        arguments: { ...base, use_lodging_flat_rate: true, lodging_nights: 1, expenses: [hotel] },
      })
    );
    const w = capped.warnings.find((x: string) => x.includes("Übernachtungsbeleg gleichzeitig"));
    expect(w).toContain("lodging_nights");
    expect(w).toContain("1 Nacht ");
    const none = data(await client.callTool({ name: "generate_travel_expense_report", arguments: { ...base, use_lodging_flat_rate: true } }));
    expect(none.warnings?.some((x: string) => x.includes("Übernachtungsbeleg gleichzeitig")) ?? false).toBe(false);
  });

  it("does not look up the chart when validation fails", async () => {
    const call = vi.fn(async (_k: string, _p?: Record<string, unknown>) => ({ data: [] }));
    const res = await upload(call, { traveller_confirmed: false });
    expect(res.isError).toBe(true);
    expect(call.mock.calls.some(([k]) => k === "settingsGetPostingaccounts")).toBe(false);
  });

  it("warns when the total is 0", async () => {
    const client = await connect(() => ({}));
    const res = await client.callTool({
      name: "generate_travel_expense_report",
      arguments: { ...base, departure: "2026-03-09T09:00", return: "2026-03-09T13:00", stops: [{ country: "Deutschland", arrival: "2026-03-09T10:00" }] },
    });
    expect(data(res).totals.total).toBe(0);
    expect(data(res).warnings.some((w: string) => w.includes("Gesamtbetrag 0 €"))).toBe(true);
  });
});
