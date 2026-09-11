import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";
import { BuchhaltungsButlerApiError, BuchhaltungsButlerRateLimitError } from "./errors.js";
import type { Config } from "../config.js";

const config: Config = {
  apiClient: "app-client",
  apiSecret: "app-secret",
  apiKey: "customer-key",
  baseUrl: "https://webapp.buchhaltungsbutler.de/api/v1",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createClient", () => {
  it("sends Basic Auth and injects api_key as a JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, rows: 0, data: [] }));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await client.call("accountsGet", {});

    expect(fetchMock).toHaveBeenCalledWith(
      "https://webapp.buchhaltungsbutler.de/api/v1/accounts/get",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("app-client:app-secret").toString("base64")}`,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ api_key: "customer-key" }),
      })
    );
  });

  it("does not let params.api_key override the configured api_key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, rows: 0, data: [] }));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await client.call("accountsGet", { api_key: "attacker-supplied-key" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://webapp.buchhaltungsbutler.de/api/v1/accounts/get",
      expect.objectContaining({
        body: JSON.stringify({ api_key: "customer-key" }),
      })
    );
  });

  it("sends nested arrays and objects as native JSON, not bracket notation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true }));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await client.call("receiptsAddBatch", {
      receipts: [{ type: "invoice inbound", counterparty: "ACME & Co" }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: JSON.stringify({
          receipts: [{ type: "invoice inbound", counterparty: "ACME & Co" }],
          api_key: "customer-key",
        }),
      })
    );
  });

  it("throws before calling fetch when a required field is missing", async () => {
    const fetchMock = vi.fn();
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await expect(client.call("receiptsAdd", { type: "invoice inbound" })).rejects.toThrow(
      /counterparty/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces the endpoint path's trailing placeholder segment with idSuffix", async () => {
    // BuchhaltungsButler's spec renders these endpoints' path parameter as a
    // literal path segment ("id_by_customer") instead of a real templated
    // parameter. The live API confirms the real route substitutes the id for
    // that segment (e.g. POST /receipts/get/16) — appending after it
    // (/receipts/get/id_by_customer/16) 404s. Confirmed live for both
    // receipts/get and transactions/get.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: {} }));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await client.call("receiptsGetIdByCustomer", {}, { idSuffix: 42 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://webapp.buchhaltungsbutler.de/api/v1/receipts/get/42",
      expect.anything()
    );
  });

  it("throws BuchhaltungsButlerRateLimitError on HTTP 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429, { success: false, message: "rate limited" }));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await expect(client.call("accountsGet", {})).rejects.toBeInstanceOf(
      BuchhaltungsButlerRateLimitError
    );
  });

  it("throws BuchhaltungsButlerApiError on other non-2xx responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(401, { success: false, message: "invalid credentials" })
    );
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    const error = await client.call("accountsGet", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BuchhaltungsButlerApiError);
    expect((error as InstanceType<typeof BuchhaltungsButlerApiError>).statusCode).toBe(401);
    expect((error as InstanceType<typeof BuchhaltungsButlerApiError>).endpoint).toBe("/accounts/get");
  });

  it("surfaces BuchhaltungsButler's own error message in the thrown error's message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(400, { success: false, message: "invalid counterparty specified" })
    );
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    const error = await client.call("accountsGet", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BuchhaltungsButlerApiError);
    expect((error as Error).message).toContain("invalid counterparty specified");
  });

  it("throws a BuchhaltungsButlerApiError (not a raw SyntaxError) when the error body is non-JSON text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500, headers: { "Content-Type": "text/plain" } })
    );
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    const error = await client.call("accountsGet", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BuchhaltungsButlerApiError);
    expect((error as InstanceType<typeof BuchhaltungsButlerApiError>).responseBody).toBe("Internal Server Error");
  });

  it("throws a BuchhaltungsButlerApiError (not a raw SyntaxError) when the error body is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    const error = await client.call("accountsGet", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BuchhaltungsButlerApiError);
    expect((error as InstanceType<typeof BuchhaltungsButlerApiError>).responseBody).toBeUndefined();
  });

  it("throws synchronously for an unknown endpoint key", async () => {
    const fetchMock = vi.fn();
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await expect(
      client.call("doesNotExist" as Parameters<typeof client.call>[0], {})
    ).rejects.toThrow(/doesNotExist/);
  });

  it("sends receiptsUpload as multipart/form-data with a real boundary", async () => {
    let receivedContentType: string | undefined;
    let receivedBody = "";
    const server = createServer((req, res) => {
      receivedContentType = req.headers["content-type"];
      req.on("data", (chunk: Buffer) => {
        receivedBody += chunk.toString("utf-8");
      });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: "" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected the test server to bind a TCP port");
    }

    const localConfig: Config = { ...config, baseUrl: `http://127.0.0.1:${address.port}` };
    const client = createClient(localConfig); // no fetchImpl override — uses the real global fetch

    await client.call("receiptsUpload", { file: "ZmFrZQ==", type: "invoice inbound", file_name: "test.pdf" });

    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(receivedContentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(receivedBody).toContain('name="file"');
    expect(receivedBody).toContain("ZmFrZQ==");
    expect(receivedBody).toContain('name="type"');
  });
});
