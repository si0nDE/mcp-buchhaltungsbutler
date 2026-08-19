import { describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";
import type { BBClient } from "./bb-client/client.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("createServer", () => {
  it("registers exactly 30 tools", () => {
    const server = createServer(mockClient({}));
    const registeredTools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registeredTools)).toHaveLength(30);
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

  it("marks the two delete-capable tools as destructiveHint", () => {
    const server = createServer(mockClient({}));
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
      }
    )._registeredTools;

    for (const name of ["manage_cost_location", "set_receipt_deleted"]) {
      expect(registeredTools[name].annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    }
  });
});
