import { Ajv2020 } from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { BBClient } from "./bb-client/client.js";
import { createServer } from "./server.js";

describe("tools/list schemas", () => {
  it("declare no draft-07 dialect and compile with Ajv 2020-12", async () => {
    const server = createServer({} as BBClient);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const ajv = new Ajv2020({ strict: false });
    for (const tool of tools) {
      expect(tool.inputSchema.$schema, tool.name).toBeUndefined();
      expect(tool.outputSchema?.$schema, tool.name).toBeUndefined();
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
      if (tool.outputSchema) expect(() => ajv.compile(tool.outputSchema!), tool.name).not.toThrow();
    }
  });
});

describe("structuredContent with extra keys passes the client's output-schema validation", () => {
  async function connect(call: (key: string, params: Record<string, unknown>) => unknown) {
    const server = createServer({ call: async (k: string, p: Record<string, unknown>) => call(k, p) } as unknown as BBClient);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.listTools(); // the client caches output validators from tools/list
    return client;
  }

  it("audit_vat_period via a real client (defaults applied, schema validated)", async () => {
    const client = await connect((key, params) =>
      key === "receiptsGet" && params.list_direction === "inbound" && !params.offset
        ? { data: [{ id_by_customer: "1", type: "invoice inbound", date: "2026-08-01", counterparty: "Muster", amount: "10.00", invoicenumber: "A-1", deleted: "0" }] }
        : { data: [] }
    );
    const res = await client.callTool({ name: "audit_vat_period", arguments: { date_from: "2026-07-01", date_to: "2026-09-30" } });
    expect(res.isError).toBeFalsy();
    const data = (res.structuredContent as { data: { counts: Record<string, number>; findings: Array<{ check: string; display_ref: string }> } }).data;
    expect(data.counts).toEqual({ UNBOOKED: 1 });
    expect(data.findings[0].display_ref).toBe("Rg. A-1 · Muster · 01.08.2026 · 10,00 €");
  });

  it("list_receipts with invoicenumbers (missing_invoicenumbers)", async () => {
    const client = await connect(() => ({ data: [] }));
    const res = await client.callTool({ name: "list_receipts", arguments: { list_direction: "both", invoicenumbers: ["RE-X"] } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as Record<string, unknown>).missing_invoicenumbers).toEqual(["RE-X"]);
  });

  it("list_transactions with booked (query_counts)", async () => {
    const client = await connect((key) =>
      key === "postingsGet"
        ? { data: [] }
        : { data: [{ id_by_customer: "1", to_from: "A", amount: "1", booking_date: "2026-03-03", purpose: "" }] }
    );
    const res = await client.callTool({ name: "list_transactions", arguments: { booked: false } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as Record<string, unknown>).query_counts).toBeDefined();
  });

  it("list_transactions with with_posting_status", async () => {
    const client = await connect((key) =>
      key === "postingsGet"
        ? { data: [] }
        : { data: [{ id_by_customer: "1", to_from: "A", amount: "1", booking_date: "2026-03-03", purpose: "" }] }
    );
    const res = await client.callTool({ name: "list_transactions", arguments: { with_posting_status: true } });
    expect(res.isError).toBeFalsy();
  });

  it("list_postings filtered by transaction", async () => {
    const client = await connect(() => ({
      data: [
        { id_by_customer: "1", transaction_id_by_customer: "5001", amount: "1.00" },
        { id_by_customer: "2", transaction_id_by_customer: "5002", amount: "2.00" },
      ],
    }));
    const res = await client.callTool({
      name: "list_postings",
      arguments: { date_from: "2026-03-04", date_to: "2026-03-04", transaction_id_by_customer: 5001 },
    });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { data: { data: unknown[] } }).data.data).toHaveLength(1);
  });
});

describe("new Bewirtung fields over the real MCP client (input zod conversion, output-schema validation)", () => {
  // All data is invented.
  async function connect(call: (key: string, params: Record<string, unknown>) => unknown) {
    const server = createServer({ call: async (k: string, p: Record<string, unknown>) => call(k, p) } as unknown as BBClient);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.listTools();
    return client;
  }

  const defaultCall = (key: string) => {
    if (key === "postingaccountsGet" || key === "postingsAccountsGet") return { data: [{ postingaccount_number: "8400", name: "Erlöse 19 % USt" }] };
    return key.endsWith("Get") ? { data: [] } : { success: true };
  };
  const text = (res: unknown) => JSON.stringify(res);

  const missingArgs = {
    date: "29.07.2026",
    location: "Restaurant Zur Beispielstube, Würzburg",
    occasion: "Nachbesprechung der Vertriebsplanung 2026 mit Abstimmung der nächsten Schritte",
    participants: [{ name: "Max Mustermann", company: "Beispiel GmbH", relation: "external" }],
    host_name: "Erika Beispiel",
    original_invoice_status: "missing_requested",
    entertainment_type: "business",
    missing_invoice_treatment: "practice_70_30_no_vat",
    gross_amount: 37.5,
    payment_evidence: { description: "Kartenzahlung Beispielbank" },
    invoice_requests: [{ date: "2026-07-31", channel: "E-Mail" }],
  };

  const presentArgs = {
    date: "24.09.2026",
    location: "Restaurant Zur Alten Post, München",
    occasion: "Vertragsverhandlung Rahmenvertrag IT-Sicherheitsaudits 2026/2027 mit Kunde GmbH",
    participants: [
      { name: "Anna Beispiel", company: "Beispielfirma UG" },
      { name: "Max Mustermann", company: "Kunde GmbH" },
    ],
    host_name: "Anna Beispiel",
    food_net: 32.5,
    food_vat: 2.28,
    drinks_net: 38.0,
    drinks_vat: 7.22,
    tip: 4.5,
  };

  const auditFields = {
    participants: "Max Mustermann, Erika Beispiel",
    occasion: "Besprechung zur Angebotsplanung 2026",
    entertainment_type: "business",
    original_invoice_status: "missing_requested",
    missing_invoice_treatment: "practice_70_30_no_vat",
    bewirtungsangaben_signed: true,
  };
  const splits = [
    { postingaccount: 4650, postingtext: "Bewirtung", vat: "0_none", amount: "26.25" },
    { postingaccount: 4654, postingtext: "Bewirtung nicht abz.", vat: "0_none", amount: "11.25" },
  ];

  it("get_receipt extract_text returns date_candidates and a warning for several dates", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("Datum 08.10.2026", { x: 20, y: 150, size: 12, font });
    page.drawText("Faellig 22.10.2026", { x: 20, y: 120, size: 12, font });
    const file_content = Buffer.from(await doc.save()).toString("base64");
    const client = await connect((key) =>
      key === "receiptsGetIdByCustomer" ? { success: true, data: { id_by_customer: "42", file_type: "pdf", file_content } } : defaultCall(key)
    );
    const res = await client.callTool({ name: "get_receipt", arguments: { id_by_customer: 42, extract_text: true } });
    expect(res.isError).toBeFalsy();
    const sc = (res.structuredContent as { data: { date_candidates?: string[]; warnings?: string[]; data?: Record<string, unknown> } }).data;
    expect(sc.date_candidates).toEqual(["2026-10-08", "2026-10-22"]);
    expect(sc.warnings?.some((w) => w.includes("mehrere"))).toBe(true);
    expect(sc.data).not.toHaveProperty("file_content");
  });

  it("generate_entertainment_receipt in missing-invoice mode returns pdf, booking_hint and the BFH warning", async () => {
    const client = await connect(defaultCall);
    const res = await client.callTool({ name: "generate_entertainment_receipt", arguments: missingArgs });
    expect(res.isError).toBeFalsy();
    const data = (res.structuredContent as { data: { pdf_base64?: unknown; booking_hint?: unknown; warnings?: string[] } }).data;
    expect(typeof data.pdf_base64).toBe("string");
    expect(text(data.booking_hint)).toContain("26.25");
    expect(text(data.booking_hint)).toContain("11.25");
    expect(text(data.booking_hint)).toContain("0_none");
    expect(text(res)).toContain("X R 57/09");
  });

  it("generate_entertainment_receipt without original_invoice_status (zod default over the wire) returns invoice_net_total", async () => {
    const client = await connect(defaultCall);
    const res = await client.callTool({ name: "generate_entertainment_receipt", arguments: presentArgs });
    expect(res.isError).toBeFalsy();
    const data = (res.structuredContent as { data: { booking_hint?: Record<string, unknown> } }).data;
    expect(data.booking_hint).toHaveProperty("invoice_net_total");
  });

  it("generate_entertainment_receipt in missing mode without the required fields is a tool error listing all of them", async () => {
    const client = await connect(defaultCall);
    const { gross_amount: _g, payment_evidence: _p, invoice_requests: _i, ...rest } = missingArgs;
    const res = await client.callTool({ name: "generate_entertainment_receipt", arguments: rest });
    expect(res.isError).toBe(true);
    const msg = text(res);
    expect(msg).toContain("gross_amount");
    expect(msg).toContain("payment_evidence");
    expect(msg).toContain("invoice_requests");
  });

  it("add_transaction_postings dry_run: warns, and the audit-only fields stay out of would_send", async () => {
    const client = await connect(defaultCall);
    const res = await client.callTool({
      name: "add_transaction_postings",
      arguments: { dry_run: true, transactions: [{ transaction_id_by_customer: 1001, splits, ...auditFields }] },
    });
    expect(res.isError).toBeFalsy();
    const sc = (
      res.structuredContent as { data: { warnings?: string[]; would_send: { body: { transactions: Array<Record<string, unknown>> } } } }
    ).data;
    expect(sc.warnings?.some((w) => w.includes("X R 57/09"))).toBe(true);
    const sent = sc.would_send.body.transactions[0];
    for (const key of ["entertainment_type", "original_invoice_status", "missing_invoice_treatment", "bewirtungsangaben_signed", "participants", "occasion"]) {
      expect(sent, key).not.toHaveProperty(key);
    }
  });

  it("add_transaction_postings rejects host_confirmed together with original_invoice_status present as a tool error", async () => {
    const client = await connect(defaultCall);
    const res = await client.callTool({
      name: "add_transaction_postings",
      arguments: {
        dry_run: true,
        transactions: [
          {
            transaction_id_by_customer: 1001,
            splits,
            participants: auditFields.participants,
            occasion: auditFields.occasion,
            host_confirmed: true,
            original_invoice_status: "present",
          },
        ],
      },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("host_confirmed");
  });

  it("add_receipt_postings dry_run carries the X R 57/09 warning", async () => {
    const client = await connect(defaultCall);
    const res = await client.callTool({
      name: "add_receipt_postings",
      arguments: { dry_run: true, receipts: [{ receipt_id_by_customer: 521, creditor: 70001, debtor: 10001, splits, ...auditFields }] },
    });
    expect(res.isError).toBeFalsy();
    const sc = (res.structuredContent as { data: { warnings?: string[] } }).data;
    expect(sc.warnings?.some((w) => w.includes("X R 57/09"))).toBe(true);
  });
});
