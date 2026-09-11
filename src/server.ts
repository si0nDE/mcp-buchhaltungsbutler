import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BBClient } from "./bb-client/client.js";
import { createAllTools } from "./tools/index.js";

export function createServer(client: BBClient): McpServer {
  const server = new McpServer({
    name: "buchhaltungsbutler",
    version: "0.1.0",
  });

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

  return server;
}
