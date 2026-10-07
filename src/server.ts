import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BBClient } from "./bb-client/client.js";
import { SERVER_INSTRUCTIONS } from "./tools/bhb-systematik.js";
import { createAllTools } from "./tools/index.js";
import { VERSION } from "./version.js";

export function createServer(client: BBClient): McpServer {
  const server = new McpServer(
    {
      name: "buchhaltungsbutler",
      version: VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  for (const tool of createAllTools(client)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      tool.handler
    );
  }

  stripDraft07Dialect(server);

  return server;
}

// The SDK (1.30) always renders zod schemas as JSON Schema draft-07 and stamps
// "$schema": "http://json-schema.org/draft-07/schema#" on every input/output
// schema. Clients that validate with Ajv's default 2020-12 mode reject that
// dialect ("invalid outputSchema"). The schemas we emit are plain object/array
// schemas, so dropping the declaration makes them default to 2020-12.
function stripDraft07Dialect(server: McpServer): void {
  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const original = handlers.get("tools/list");
  if (!original) {
    throw new Error("tools/list handler not registered; cannot strip draft-07 $schema");
  }
  handlers.set("tools/list", async (request, extra) => {
    const result = (await original(request, extra)) as {
      tools: Array<{ inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> }>;
    };
    for (const tool of result.tools) {
      if (tool.inputSchema) delete tool.inputSchema.$schema;
      if (tool.outputSchema) delete tool.outputSchema.$schema;
    }
    return result;
  });
}
