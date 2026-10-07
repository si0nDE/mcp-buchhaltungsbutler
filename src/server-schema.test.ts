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
