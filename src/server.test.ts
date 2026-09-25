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
  it("registers exactly 31 tools", () => {
    const server = createServer(mockClient({}));
    const registeredTools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registeredTools)).toHaveLength(31);
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
});
