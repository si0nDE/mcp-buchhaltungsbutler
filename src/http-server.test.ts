import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { requireBearerToken } from "./http-server.js";

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
