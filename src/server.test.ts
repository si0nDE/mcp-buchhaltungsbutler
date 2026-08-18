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
});
