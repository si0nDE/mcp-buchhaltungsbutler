import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("returns config from env with the default base URL", () => {
    const config = loadConfig({
      BB_API_CLIENT: "client-1",
      BB_API_SECRET: "secret-1",
      BB_API_KEY: "key-1",
    });
    expect(config).toEqual({
      apiClient: "client-1",
      apiSecret: "secret-1",
      apiKey: "key-1",
      baseUrl: "https://webapp.buchhaltungsbutler.de/api/v1",
    });
  });

  it("uses BB_API_BASE_URL when set", () => {
    const config = loadConfig({
      BB_API_CLIENT: "client-1",
      BB_API_SECRET: "secret-1",
      BB_API_KEY: "key-1",
      BB_API_BASE_URL: "https://staging.example.test/api/v1",
    });
    expect(config.baseUrl).toBe("https://staging.example.test/api/v1");
  });

  it("throws listing every missing required variable", () => {
    expect(() => loadConfig({ BB_API_CLIENT: "client-1" })).toThrow(
      /BB_API_SECRET, BB_API_KEY/
    );
  });
});
