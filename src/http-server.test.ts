import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "./bb-client/client.js";
import { createHttpApp, requireBearerToken } from "./http-server.js";

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

describe("createHttpApp", () => {
  async function withApp(run: (base: string) => Promise<void>): Promise<void> {
    const app = createHttpApp({} as BBClient, "secret-token");
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
});
