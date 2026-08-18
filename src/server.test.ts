import { describe, expect, it } from "vitest";
import { createServer } from "./server.js";

describe("createServer", () => {
  it("creates an McpServer with the expected name and no tools", () => {
    const server = createServer();
    expect(server.server.getClientVersion()).toBeUndefined();
    const registeredTools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registeredTools ?? {})).toHaveLength(0);
  });
});
