import { createHash, timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Express, NextFunction, Request, Response } from "express";
import type { BBClient } from "./bb-client/client.js";
import { createClient } from "./bb-client/client.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function requireBearerToken(token: string) {
  const expected = sha256(token);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const actual = sha256(provided);
    if (!timingSafeEqual(actual, expected)) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    next();
  };
}

function methodNotAllowed(_req: Request, res: Response): void {
  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
}

function logRequests(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
}

export function createHttpApp(bbClient: BBClient, authToken: string, allowedHosts?: string[]): Express {
  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts });

  app.use(logRequests);

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use(requireBearerToken(authToken));

  app.post("/mcp", async (req, res) => {
    try {
      const server = createServer(bbClient);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}

function main(): void {
  const port = Number(process.env.PORT ?? 3000);
  const authToken = process.env.MCP_AUTH_TOKEN;
  const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  if (!authToken) {
    console.error("Missing required environment variable: MCP_AUTH_TOKEN");
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }

  const bbClient = createClient(config);
  const app = createHttpApp(bbClient, authToken, allowedHosts);

  app.listen(port, () => {
    console.log(`MCP HTTP server listening on port ${port}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
