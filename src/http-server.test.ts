import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "./bb-client/client.js";
import {
  authTokenProblem,
  createFailureLimiter,
  createHttpApp,
  MIN_AUTH_TOKEN_LENGTH,
  parseTrustProxy,
  requireBearerToken,
} from "./http-server.js";

function mockReqRes(authorization?: string) {
  const req = { headers: { authorization } } as Request;
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status } as unknown as Response;
  const next = vi.fn();
  return { req, res, next, status, json };
}

describe("requireBearerToken", () => {
  const middleware = requireBearerToken("secret-token");

  it("calls next() when the bearer token matches", () => {
    const { req, res, next } = mockReqRes("Bearer secret-token");

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects with 401 when the token is wrong", () => {
    const { req, res, next, status, json } = mockReqRes("Bearer wrong-token");

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: "Unauthorized" }) })
    );
  });

  it("rejects with 401 when the Authorization header is missing", () => {
    const { req, res, next, status } = mockReqRes(undefined);

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it("rejects with 401 when the header doesn't use the Bearer scheme", () => {
    const { req, res, next, status } = mockReqRes("Basic secret-token");

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });
});

describe("authTokenProblem", () => {
  it("rejects a missing token", () => {
    expect(authTokenProblem(undefined)).toContain("MCP_AUTH_TOKEN");
    expect(authTokenProblem("")).toContain("MCP_AUTH_TOKEN");
  });

  it("rejects a token shorter than the minimum", () => {
    expect(authTokenProblem("a1b2c3d4e5f6g7h8")).toContain(`minimum ${MIN_AUTH_TOKEN_LENGTH}`);
  });

  it("rejects a long token made of few distinct characters", () => {
    expect(authTokenProblem("a".repeat(40))).toContain("distinct");
  });

  it("accepts a long random token", () => {
    expect(authTokenProblem("Zk3vQ9pLx7Tn2Wb8Rm4Yc6Hd1Sf5Jg0Ae")).toBeNull();
  });
});

describe("parseTrustProxy", () => {
  it("defaults to 0", () => {
    expect(parseTrustProxy(undefined)).toBe(0);
    expect(parseTrustProxy(" ")).toBe(0);
  });

  it("reads a hop count", () => {
    expect(parseTrustProxy("1")).toBe(1);
  });

  it("rejects anything that is not a hop count", () => {
    expect(() => parseTrustProxy("true")).toThrow("MCP_TRUST_PROXY");
    expect(() => parseTrustProxy("-1")).toThrow("MCP_TRUST_PROXY");
  });
});

describe("createFailureLimiter", () => {
  it("blocks an address after max failures and releases it when the window ends", () => {
    let t = 1_000;
    const limiter = createFailureLimiter({ max: 3, windowMs: 60_000, now: () => t });

    limiter.recordFailure("a");
    limiter.recordFailure("a");
    expect(limiter.blockedFor("a")).toBe(0);
    limiter.recordFailure("a");
    expect(limiter.blockedFor("a")).toBe(60);
    expect(limiter.blockedFor("b")).toBe(0);

    t += 60_000;
    expect(limiter.blockedFor("a")).toBe(0);
  });

  it("keeps at most maxEntries addresses", () => {
    const limiter = createFailureLimiter({ max: 1, maxEntries: 2, now: () => 0 });

    limiter.recordFailure("a");
    limiter.recordFailure("b");
    limiter.recordFailure("c");

    expect(limiter.blockedFor("a")).toBe(0);
    expect(limiter.blockedFor("b")).toBeGreaterThan(0);
    expect(limiter.blockedFor("c")).toBeGreaterThan(0);
  });
});

describe("createHttpApp", () => {
  async function withApp(
    run: (base: string) => Promise<void>,
    options: Parameters<typeof createHttpApp>[3] = {},
  ): Promise<void> {
    const app = createHttpApp({} as BBClient, "secret-token", undefined, options);
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("answers /health without a token", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
    });
  });

  it("rejects an unauthenticated body with 401 before parsing it", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(401);
    });
  });

  it("rejects an unauthenticated compressed body with 401", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Encoding": "br" },
        body: new Uint8Array([1, 2, 3]),
      });
      expect(res.status).toBe(401);
    });
  });

  it("rejects a compressed body with 415 even when authenticated", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
          "Content-Encoding": "br",
        },
        body: new Uint8Array([1, 2, 3]),
      });
      expect(res.status).toBe(415);
    });
  });

  it("serves an authenticated, uncompressed MCP request", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("serverInfo");
    });
  });

  it("does not announce Express", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.headers.get("x-powered-by")).toBeNull();
    });
  });

  it("answers 429 with Retry-After after too many failed attempts, even for the right token", async () => {
    await withApp(
      async (base) => {
        const post = (token: string) =>
          fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });

        expect((await post("wrong-1")).status).toBe(401);
        expect((await post("wrong-2")).status).toBe(401);
        const blocked = await post("secret-token");
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
        expect((await fetch(`${base}/health`)).status).toBe(200);
      },
      { limiter: createFailureLimiter({ max: 2 }) },
    );
  });

  it("throttles per forwarded client address when a proxy is trusted", async () => {
    await withApp(
      async (base) => {
        const post = (token: string, forwardedFor: string) =>
          fetch(`${base}/mcp`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": forwardedFor },
            body: "{}",
          });

        expect((await post("wrong", "203.0.113.7")).status).toBe(401);
        expect((await post("wrong", "203.0.113.7")).status).toBe(429);
        expect((await post("wrong", "203.0.113.8")).status).toBe(401);
      },
      { trustProxy: 1, limiter: createFailureLimiter({ max: 1 }) },
    );
  });

  it("ignores X-Forwarded-For without a trusted proxy", async () => {
    await withApp(
      async (base) => {
        const post = (forwardedFor: string) =>
          fetch(`${base}/mcp`, {
            method: "POST",
            headers: { Authorization: "Bearer wrong", "X-Forwarded-For": forwardedFor },
            body: "{}",
          });

        expect((await post("203.0.113.7")).status).toBe(401);
        expect((await post("203.0.113.8")).status).toBe(429);
      },
      { limiter: createFailureLimiter({ max: 1 }) },
    );
  });

  it("offers only read-only tools in read-only mode", async () => {
    await withApp(
      async (base) => {
        const res = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            Authorization: "Bearer secret-token",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        });
        const text = await res.text();
        expect(text).toContain('"list_receipts"');
        expect(text).not.toContain('"add_receipt_postings"');
        expect(text).not.toContain('"delete_transaction"');
      },
      { readOnly: true },
    );
  });
});
