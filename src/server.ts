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

  const tools = createAllTools(client);
  for (const tool of tools) {
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
  warnOnUnknownParameters(server, new Map(tools.map((t) => [t.name, new Set(Object.keys(t.inputSchema))])));

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

// The SDK's zod objects silently drop parameters a tool does not know (e.g. `search` on list_receipts), so the
// caller reads an unfiltered answer as a filtered one. Calls keep working; the answer gets an extra text block
// and structuredContent.warnings naming the ignored top-level parameters (nested fields are not checked).
function warnOnUnknownParameters(server: McpServer, known: Map<string, Set<string>>): void {
  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const original = handlers.get("tools/call");
  if (!original) {
    throw new Error("tools/call handler not registered; cannot warn on unknown parameters");
  }
  handlers.set("tools/call", async (request, extra) => {
    const result = (await original(request, extra)) as {
      content?: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    const params = (request as { params?: { name?: string; arguments?: Record<string, unknown> } }).params;
    const accepted = params?.name ? known.get(params.name) : undefined;
    if (!accepted || !params?.arguments || result.isError) return result;
    const unknown = Object.keys(params.arguments).filter((k) => !accepted.has(k));
    if (unknown.length === 0) return result;
    const warning =
      `Warnung: unbekannte Parameter ignoriert: ${unknown.join(", ")}. Der Aufruf wurde ohne sie ausgeführt, ein erwarteter Filter hat NICHT gewirkt. ` +
      `${params.name} kennt: ${[...accepted].join(", ")}.`;
    result.content = [...(result.content ?? []), { type: "text", text: warning }];
    if (result.structuredContent) {
      result.structuredContent.warnings = [...((result.structuredContent.warnings as string[] | undefined) ?? []), warning];
    }
    return result;
  });
}
