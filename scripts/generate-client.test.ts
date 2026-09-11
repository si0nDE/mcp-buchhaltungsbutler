import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractEndpoints, pathToKey, type SwaggerSpec } from "./generate-client.js";

const spec: SwaggerSpec = JSON.parse(
  readFileSync(new URL("../spec/buchhaltungsbutler-v1.json", import.meta.url), "utf-8")
);

describe("pathToKey", () => {
  it("camelCases simple paths", () => {
    expect(pathToKey("/accounts/get")).toBe("accountsGet");
  });

  it("camelCases snake_case segments", () => {
    expect(pathToKey("/receipts/get/id_by_customer")).toBe("receiptsGetIdByCustomer");
  });

  it("camelCases kebab-case segments", () => {
    expect(pathToKey("/invoices/create/e-invoice")).toBe("invoicesCreateEInvoice");
  });

  it("camelCases multi-word kebab segments", () => {
    expect(pathToKey("/postings/assign/receipt-to-free-posting")).toBe(
      "postingsAssignReceiptToFreePosting"
    );
  });
});

describe("extractEndpoints", () => {
  const endpoints = extractEndpoints(spec);

  it("extracts exactly 48 endpoints with unique keys", () => {
    expect(endpoints).toHaveLength(48);
    expect(new Set(endpoints.map((e) => e.key)).size).toBe(48);
  });

  it("sorts endpoints by path", () => {
    const paths = endpoints.map((e) => e.path);
    expect(paths).toEqual([...paths].sort());
  });

  it("extracts params with correct required/type for receipts/get", () => {
    const receiptsGet = endpoints.find((e) => e.path === "/receipts/get")!;
    expect(receiptsGet.params).toContainEqual({ name: "api_key", required: true, type: "string" });
    expect(receiptsGet.params).toContainEqual({ name: "limit", required: false, type: "integer" });
  });

  it("sets bodyFormat: multipart on receiptsUpload only", () => {
    const receiptsUpload = endpoints.find((e) => e.key === "receiptsUpload")!;
    expect(receiptsUpload.bodyFormat).toBe("multipart");

    const withoutOverride = endpoints.filter((e) => e.key !== "receiptsUpload");
    expect(withoutOverride.every((e) => e.bodyFormat === undefined)).toBe(true);
  });
});
