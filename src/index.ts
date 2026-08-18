import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "./bb-client/client.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const client = createClient(config);
const server = createServer(client);
const transport = new StdioServerTransport();
await server.connect(transport);
