import { createHash, timingSafeEqual } from "node:crypto";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { BBClient } from "./bb-client/client.js";
import { createClient } from "./bb-client/client.js";
import { loadConfig } from "./config.js";
import { createServer, readOnlyFromEnv } from "./server.js";

// Das Token ist der einzige Schutz des Endpunkts und gibt Lese- und Schreibzugriff auf die Buchhaltung.
// 32 Zeichen aus `openssl rand -base64 48` o. ä. sind nicht zu erraten; kürzere Werte lehnt der Start ab.
export const MIN_AUTH_TOKEN_LENGTH = 32;

/** Fehlertext, wenn das Token als Schutz nicht taugt, sonst null. */
export function authTokenProblem(token: string | undefined): string | null {
  if (!token) return "Missing required environment variable: MCP_AUTH_TOKEN";
  if (token.length < MIN_AUTH_TOKEN_LENGTH) {
    return (
      `MCP_AUTH_TOKEN is too short (${token.length} characters, minimum ${MIN_AUTH_TOKEN_LENGTH}). ` +
      "Generate a random one, e.g. `openssl rand -base64 48`."
    );
  }
  if (new Set(token).size < 8) {
    return "MCP_AUTH_TOKEN has too few distinct characters. Generate a random one, e.g. `openssl rand -base64 48`.";
  }
  return null;
}

export interface FailureLimiter {
  /** Sekunden bis zur Freigabe, 0 wenn die Adresse nicht gesperrt ist. */
  blockedFor(ip: string): number;
  recordFailure(ip: string): void;
}

export interface FailureLimiterOptions {
  /** Fehlversuche je Adresse, die im Fenster noch beantwortet werden. */
  max?: number;
  windowMs?: number;
  /** Obergrenze gemerkter Adressen, damit ein Angreifer den Speicher nicht füllt. */
  maxEntries?: number;
  now?: () => number;
}

// Zählt nur Fehlversuche. Ist die Grenze erreicht, wird die Adresse bis zum Ende des Fensters abgewiesen,
// auch mit richtigem Token: sonst bliebe die Rate, mit der sich Token durchprobieren lassen, unbegrenzt.
export function createFailureLimiter(options: FailureLimiterOptions = {}): FailureLimiter {
  const max = options.max ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { count: number; resetAt: number }>();

  function current(ip: string) {
    const entry = entries.get(ip);
    if (entry && entry.resetAt <= now()) {
      entries.delete(ip);
      return undefined;
    }
    return entry;
  }

  return {
    blockedFor(ip) {
      const entry = current(ip);
      if (!entry || entry.count < max) return 0;
      return Math.max(1, Math.ceil((entry.resetAt - now()) / 1000));
    },
    recordFailure(ip) {
      const entry = current(ip);
      if (entry) {
        entry.count += 1;
        return;
      }
      if (entries.size >= maxEntries) {
        const t = now();
        for (const [key, value] of entries) if (value.resetAt <= t) entries.delete(key);
        // Immer noch voll: die älteste Adresse weicht (Map hält die Einfügereihenfolge).
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value as string);
      }
      entries.set(ip, { count: 1, resetAt: now() + windowMs });
    },
  };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

export function requireBearerToken(token: string, limiter?: FailureLimiter) {
  const expected = sha256(token);
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = limiter ? clientIp(req) : "";
    const blockedFor = limiter?.blockedFor(ip) ?? 0;
    if (blockedFor > 0) {
      res.setHeader("Retry-After", String(blockedFor));
      res.status(429).json({ jsonrpc: "2.0", error: { code: -32002, message: "Too many failed attempts" }, id: null });
      return;
    }
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const actual = sha256(provided);
    if (!timingSafeEqual(actual, expected)) {
      limiter?.recordFailure(ip);
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

export interface HttpAppOptions {
  /**
   * Anzahl vertrauenswürdiger Reverse-Proxys vor dem Server (Express "trust proxy"). Nur damit sieht die
   * Drosselung die Adresse des Clients statt die des Proxys. 0 oder weggelassen: X-Forwarded-For wird ignoriert.
   */
  trustProxy?: number;
  /** Nur Tools mit readOnlyHint anbieten. */
  readOnly?: boolean;
  limiter?: FailureLimiter;
}

export function createHttpApp(
  bbClient: BBClient,
  authToken: string,
  allowedHosts?: string[],
  options: HttpAppOptions = {},
): Express {
  const app = express();
  app.disable("x-powered-by");
  if (options.trustProxy) app.set("trust proxy", options.trustProxy);

  if (allowedHosts) {
    app.use(hostHeaderValidation(allowedHosts));
  } else {
    console.warn(
      "Warning: Server is binding to 0.0.0.0 without DNS rebinding protection. " +
        "Set MCP_ALLOWED_HOSTS to restrict allowed hosts.",
    );
  }

  app.use(logRequests);

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use(requireBearerToken(authToken, options.limiter ?? createFailureLimiter()));

  // Body erst nach der Authentifizierung lesen und nie entpacken (inflate: false):
  // MCP-Clients senden unkomprimiert, und der Decoder (gzip/deflate/br) bleibt unerreichbar.
  app.use(express.json({ inflate: false }));

  app.post("/mcp", async (req, res) => {
    try {
      const server = createServer(bbClient, { readOnly: options.readOnly });
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

/** MCP_TRUST_PROXY: Anzahl der Proxys als ganze Zahl ab 0; alles andere ist ein Konfigurationsfehler. */
export function parseTrustProxy(value: string | undefined): number {
  const text = value?.trim();
  if (!text) return 0;
  if (!/^\d{1,2}$/.test(text)) {
    throw new Error(`MCP_TRUST_PROXY must be the number of reverse proxies in front of the server (0, 1, 2, ...), got "${text}".`);
  }
  return Number(text);
}

function main(): void {
  const port = Number(process.env.PORT ?? 3000);
  const authToken = process.env.MCP_AUTH_TOKEN;
  const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  const tokenProblem = authTokenProblem(authToken);
  if (tokenProblem || !authToken) {
    console.error(tokenProblem);
    process.exit(1);
  }

  let config;
  let trustProxy: number;
  try {
    config = loadConfig(process.env);
    trustProxy = parseTrustProxy(process.env.MCP_TRUST_PROXY);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }

  const readOnly = readOnlyFromEnv(process.env);
  if (readOnly) console.log("BHB_READ_ONLY is set: only read-only tools are offered.");
  if (!trustProxy) {
    console.warn(
      "Note: MCP_TRUST_PROXY is not set. Behind a reverse proxy all clients share the proxy's address, " +
        "so failed-login throttling applies to all of them together. Set MCP_TRUST_PROXY=1 for one proxy.",
    );
  }

  const bbClient = createClient(config);
  const app = createHttpApp(bbClient, authToken, allowedHosts, { trustProxy, readOnly });

  app.listen(port, () => {
    console.log(`MCP HTTP server listening on port ${port}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
