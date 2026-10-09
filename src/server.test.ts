import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";
import type { BBClient } from "./bb-client/client.js";

async function connectedClient(client: BBClient) {
  const server = createServer(client);
  const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return mcpClient;
}

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("createServer", () => {
  it("registers exactly 45 tools", () => {
    const server = createServer(mockClient({}));
    const registeredTools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registeredTools)).toHaveLength(46);
  });

  it("wires list_accounts through to the given client", async () => {
    const client = mockClient({ success: true, rows: 1, data: [{ name: "Kasse", postingaccount_number: "1000" }] });
    const server = createServer(client);
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
      }
    )._registeredTools;

    const result = await registeredTools.list_accounts.handler({});

    expect(client.call).toHaveBeenCalledWith("accountsGet", {});
    expect(JSON.parse(result.content[0].text)).toEqual([{ name: "Kasse", postingaccount_number: "1000" }]);
  });

  it("every registered tool has explicit readOnlyHint and destructiveHint annotations", () => {
    const server = createServer(mockClient({}));
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
      }
    )._registeredTools;

    for (const [name, tool] of Object.entries(registeredTools)) {
      expect(typeof tool.annotations?.readOnlyHint, `${name} readOnlyHint`).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint, `${name} destructiveHint`).toBe("boolean");
    }
  });

  it("marks read tools as readOnlyHint and non-destructive", () => {
    const server = createServer(mockClient({}));
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
      }
    )._registeredTools;

    for (const name of ["list_accounts", "list_receipts", "get_receipt", "list_postings"]) {
      expect(registeredTools[name].annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it("marks non-additive-update tools as destructiveHint", () => {
    // destructiveHint means "non-additive update" per the MCP spec, not just
    // "deletes data" — overwriting existing fields or removing an existing
    // relationship both qualify, not only outright deletion.
    const server = createServer(mockClient({}));
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
      }
    )._registeredTools;

    for (const name of [
      "manage_cost_location", // can delete
      "set_receipt_deleted", // can delete
      "update_contact", // overwrites existing debtor/creditor fields
      "manage_posting_account", // update branch overwrites existing name
      "unassign_receipt", // removes an existing assignment
      "unconfirm_posting", // flips an existing posting's fixed/confirmed status
      "cancel_posting", // removes unfixed postings (guarded wrapper around unconfirm)
    ]) {
      expect(registeredTools[name].annotations, name).toEqual({ readOnlyHint: false, destructiveHint: true });
    }
  });

  it("passes the real MCP SDK's output-schema validation for a list tool", async () => {
    const client = mockClient({ success: true, rows: 1, data: [{ name: "Kasse", postingaccount_number: "1000" }] });
    const mcpClient = await connectedClient(client);

    const result = await mcpClient.callTool({ name: "list_accounts", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      data: [{ name: "Kasse", postingaccount_number: "1000" }],
    });
  });

  it("passes the real MCP SDK's output-schema validation for an object-returning tool", async () => {
    const client = mockClient({ success: true, message: "" });
    const mcpClient = await connectedClient(client);

    const result = await mcpClient.callTool({
      name: "add_comment",
      arguments: { comment_text: "note", receipt_id_by_customer: 1 },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ data: { success: true, message: "" } });
  });

  it("lists ignored top-level parameters as a warning instead of failing", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const mcp = await connectedClient(client);

    const res = (await mcp.callTool({ name: "list_receipts", arguments: { search: "Hudu", list_direction: "inbound", limit: 5 } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent: { warnings?: string[] };
    };

    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(res.content.at(-1)?.text).toMatch(/unbekannte Parameter ignoriert: search/);
    expect(res.structuredContent.warnings?.[0]).toMatch(/search/);
    const clean = (await mcp.callTool({ name: "list_receipts", arguments: { list_direction: "inbound", limit: 5 } })) as { content: Array<{ text: string }> };
    expect(clean.content.map((c) => c.text).join(" ")).not.toMatch(/unbekannte Parameter/);
  });

  it("accepts a number for amount and sends it as a string", async () => {
    const client = mockClient({ success: true, data: [] });
    const mcp = await connectedClient(client);

    await mcp.callTool({
      name: "add_free_postings",
      arguments: {
        free_postings: [
          { date: "2026-03-18", postingtext: "t", amount: 52.33, postingaccount_debit: 4964, postingaccount_credit: 1890, vat: "19_both_511" },
        ],
      },
    });

    const sent = JSON.stringify((client.call as ReturnType<typeof vi.fn>).mock.calls);
    expect(sent).toContain('"amount":"52.33"');
  });
});
