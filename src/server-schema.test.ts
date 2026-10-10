import { Ajv2020 } from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
