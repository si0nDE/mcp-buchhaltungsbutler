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
  it("sends Basic Auth and injects api_key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, rows: 0, data: [] }));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await client.call("accountsGet", {});

    expect(fetchMock).toHaveBeenCalledWith(
      "https://webapp.buchhaltungsbutler.de/api/v1/accounts/get",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("app-client:app-secret").toString("base64")}`,
        }),
        body: JSON.stringify({ api_key: "customer-key" }),
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

  it("appends the id as a URL path suffix when idSuffix is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: {} }));
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await client.call("receiptsGetIdByCustomer", {}, { idSuffix: 42 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://webapp.buchhaltungsbutler.de/api/v1/receipts/get/id_by_customer/42",
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

  it("throws synchronously for an unknown endpoint key", async () => {
    const fetchMock = vi.fn();
    const client = createClient(config, fetchMock as unknown as typeof fetch);

    await expect(
      client.call("doesNotExist" as Parameters<typeof client.call>[0], {})
    ).rejects.toThrow(/doesNotExist/);
  });
});
