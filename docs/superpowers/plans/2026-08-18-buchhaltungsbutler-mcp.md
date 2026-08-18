# BuchhaltungsButler MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local (stdio) MCP server that exposes the full BuchhaltungsButler API (48 endpoints) as ~30 curated, token-efficient MCP tools, backed by a spec-generated client layer.

**Architecture:** Two layers. A generated client layer (`src/bb-client/`) derives endpoint metadata (path + required/optional fields per BuchhaltungsButler's official Swagger spec, vendored at `spec/buchhaltungsbutler-v1.json`) via a codegen script, and exposes one generic, typed `call(endpointKey, params)` function that handles Basic Auth, `api_key` injection, and error/rate-limit mapping. A hand-written tool layer (`src/tools/*.ts`) registers curated MCP tools on top — consolidating batch/singular variants, related actions, and parallel-array API quirks into clean, LLM-friendly schemas — and trims list responses to essential fields by default.

**Tech Stack:** TypeScript (Node ≥20, ESM/NodeNext), `@modelcontextprotocol/sdk` ^1.30.0, `zod` ^4 for schema validation, `vitest` for tests, `tsx` for running the codegen script and dev server.

**Spec:** `docs/superpowers/specs/2026-08-18-buchhaltungsbutler-mcp-design.md`

## Global Constraints

- All request bodies to the BuchhaltungsButler API are sent as JSON with `api_key` injected automatically from config — no tool ever exposes `api_key`, `BB_API_CLIENT`, or `BB_API_SECRET` as a parameter.
- Every list-returning tool defaults to trimmed output fields and a `limit` default of 20 (never the BB API's own default), with a `full: boolean` parameter (default `false`) to request untrimmed records, and an explicit `limit`/`offset` passthrough for pagination.
- Every tool that creates records accepts an array natively (batch-first) — even for a single record, callers pass a one-element array. No tool exposes both a singular and a batch variant of the same action.
- Endpoint base path (from the vendored spec): `https://webapp.buchhaltungsbutler.de/api/v1`, overridable via `BB_API_BASE_URL`.
- The BuchhaltungsButler API's four `.../id_by_customer` endpoints (`/receipts/get/id_by_customer`, `/receipts/delete/id_by_customer`, `/receipts/restore/id_by_customer`, `/transactions/get/id_by_customer`) document no formal path parameter for the id in the Swagger spec, only `api_key` in the body. Following REST convention and the endpoints' naming (and consistent with how the vendor's own docs describe "get it by id_by_customer"), this plan appends the id as an additional URL path segment (e.g. `POST /receipts/get/id_by_customer/42`). This is the most likely correct interpretation but is unverified against a live account (no API credentials available yet, see design spec's testing strategy) — Task 4 unit-tests the URL construction against the mock, and this must be confirmed against the real API once credentials exist.
- No comments in code unless documenting a non-obvious constraint (e.g. the id-suffix behavior above). Endpoint field names, enum values, and required/optional flags in this plan are taken verbatim from the vendored Swagger spec (`spec/buchhaltungsbutler-v1.json`, version 1.9.1, 48 paths) — do not rename or "clean up" API field names inside request payload construction.

**User decisions (already made):** Deployment is local stdio only, no remote/HTTP hosting in this phase. Single-tenant — one set of BuchhaltungsButler credentials via env vars, no multi-tenant support. Tool surface is curated/high-level, not a 1:1 endpoint wrapper. No live API credentials are available yet — build and test against mocked HTTP responses; live integration testing is explicitly deferred, not a blocker for any task in this plan.

---

## Task 1: Project Scaffold & MCP Server Bootstrap

**Goal:** A minimal, installable TypeScript project that boots an MCP server over stdio with zero tools registered, verified by a smoke test.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/server.ts`
- Create: `src/index.ts`
- Test: `src/server.test.ts`
- Modify: `spec/buchhaltungsbutler-v1.json` (already vendored, verify present)

**Acceptance Criteria:**
- [ ] `npm install` succeeds
- [ ] `npm test` runs vitest and passes
- [ ] `npm run build` compiles `src/` to `dist/` with no TypeScript errors
- [ ] `createServer()` returns an `McpServer` instance with name `buchhaltungsbutler` and no tools registered yet

**Verify:** `npm test` → all tests pass; `npm run build` → exits 0

**Steps:**

- [ ] **Step 1: Project files**

`package.json`:

```json
{
  "name": "mcp-buchhaltungsbutler",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "generate": "tsx scripts/generate-client.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^4.1.10"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

`.gitignore`:

```
node_modules/
dist/
.env
```

`.env.example`:

```
BB_API_CLIENT=
BB_API_SECRET=
BB_API_KEY=
BB_API_BASE_URL=https://webapp.buchhaltungsbutler.de/api/v1
```

- [ ] **Step 2: Write the failing test**

`src/server.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createServer } from "./server.js";

describe("createServer", () => {
  it("creates an McpServer with the expected name and no tools", () => {
    const server = createServer();
    expect(server.server.getClientVersion()).toBeUndefined();
    const registeredTools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registeredTools ?? {})).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './server.js'`

- [ ] **Step 4: Write minimal implementation**

`src/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createServer(): McpServer {
  return new McpServer({
    name: "buchhaltungsbutler",
    version: "0.1.0",
  });
}
```

`src/index.ts`:

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore .env.example src/server.ts src/index.ts src/server.test.ts spec/
git commit -m "feat: scaffold MCP server project with stdio bootstrap"
```

---

## Task 2: Config & Env Validation

**Goal:** Load and validate the required BuchhaltungsButler credentials from environment variables, failing fast with a clear message if any are missing.

**Files:**
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Acceptance Criteria:**
- [ ] `loadConfig({BB_API_CLIENT, BB_API_SECRET, BB_API_KEY})` returns `{apiClient, apiSecret, apiKey, baseUrl}` with the given values and the default `baseUrl`
- [ ] `loadConfig` uses `BB_API_BASE_URL` when set, overriding the default
- [ ] `loadConfig` throws an `Error` listing every missing required variable by name when one or more of `BB_API_CLIENT`/`BB_API_SECRET`/`BB_API_KEY` are absent

**Verify:** `npm test -- src/config.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/config.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/config.test.ts`
Expected: FAIL — `Cannot find module './config.js'`

- [ ] **Step 3: Write minimal implementation**

`src/config.ts`:

```ts
export interface Config {
  apiClient: string;
  apiSecret: string;
  apiKey: string;
  baseUrl: string;
}

const DEFAULT_BASE_URL = "https://webapp.buchhaltungsbutler.de/api/v1";

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Config {
  const apiClient = env.BB_API_CLIENT;
  const apiSecret = env.BB_API_SECRET;
  const apiKey = env.BB_API_KEY;

  const missing: string[] = [];
  if (!apiClient) missing.push("BB_API_CLIENT");
  if (!apiSecret) missing.push("BB_API_SECRET");
  if (!apiKey) missing.push("BB_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. Set them before starting the server (see .env.example).`
    );
  }

  return {
    apiClient: apiClient!,
    apiSecret: apiSecret!,
    apiKey: apiKey!,
    baseUrl: env.BB_API_BASE_URL || DEFAULT_BASE_URL,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add env-based config loader with fail-fast validation"
```

---

## Task 3: Codegen Script for Endpoint Metadata

**Goal:** A script that parses the vendored Swagger spec into a single source-of-truth TypeScript file listing all 48 endpoints (key, path, params with name/required/type), regenerable on spec updates.

**Files:**
- Create: `scripts/generate-client.ts`
- Create: `src/bb-client/generated/endpoints.ts` (generated output, committed)
- Test: `scripts/generate-client.test.ts`

**Acceptance Criteria:**
- [ ] `pathToKey("/receipts/get/id_by_customer")` returns `"receiptsGetIdByCustomer"`; `pathToKey("/invoices/create/e-invoice")` returns `"invoicesCreateEInvoice"`
- [ ] `extractEndpoints(spec)` returns exactly 48 entries, sorted by `path`, with no duplicate `key`
- [ ] `extractEndpoints(spec)` for `/receipts/get` includes a `limit` param with `required: false, type: "integer"` and an `api_key` param with `required: true, type: "string"`
- [ ] Running `npm run generate` regenerates `src/bb-client/generated/endpoints.ts` deterministically (byte-identical on repeated runs against the same spec)
- [ ] `src/bb-client/generated/endpoints.ts` exports `ENDPOINTS` (readonly array of 48 `EndpointDef`) and `EndpointKey` (union of all 48 keys)

**Verify:** `npm test -- scripts/generate-client.test.ts` → all pass; `npm run generate && git diff --exit-code src/bb-client/generated/endpoints.ts` → no diff

**Steps:**

- [ ] **Step 1: Write the failing test**

`scripts/generate-client.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- scripts/generate-client.test.ts`
Expected: FAIL — `Cannot find module './generate-client.js'`

- [ ] **Step 3: Write minimal implementation**

`scripts/generate-client.ts`:

```ts
import { readFileSync, writeFileSync } from "node:fs";

export interface SwaggerParam {
  name: string;
  in: string;
  required?: boolean;
  type?: string;
}

export interface SwaggerOperation {
  parameters?: SwaggerParam[];
}

export interface SwaggerSpec {
  paths: Record<string, { post?: SwaggerOperation }>;
}

export interface EndpointParam {
  name: string;
  required: boolean;
  type: string;
}

export interface EndpointDef {
  key: string;
  path: string;
  params: EndpointParam[];
}

function toCamelSegment(segment: string): string {
  return segment
    .split(/[_-]/)
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

export function pathToKey(apiPath: string): string {
  const segments = apiPath.replace(/^\//, "").split("/");
  return segments
    .map((segment, i) => {
      const camel = toCamelSegment(segment);
      return i === 0
        ? camel.charAt(0).toLowerCase() + camel.slice(1)
        : camel.charAt(0).toUpperCase() + camel.slice(1);
    })
    .join("");
}

export function extractEndpoints(spec: SwaggerSpec): EndpointDef[] {
  const paths = Object.keys(spec.paths).sort();
  return paths
    .filter((apiPath) => spec.paths[apiPath].post)
    .map((apiPath) => {
      const params = (spec.paths[apiPath].post!.parameters ?? []).map((p) => ({
        name: p.name,
        required: p.required ?? false,
        type: p.type ?? "object",
      }));
      return { key: pathToKey(apiPath), path: apiPath, params };
    });
}

function render(endpoints: EndpointDef[]): string {
  const entries = endpoints
    .map((e) => {
      const params = e.params
        .map((p) => `{ name: ${JSON.stringify(p.name)}, required: ${p.required}, type: ${JSON.stringify(p.type)} }`)
        .join(", ");
      return `  { key: ${JSON.stringify(e.key)}, path: ${JSON.stringify(e.path)}, params: [${params}] },`;
    })
    .join("\n");

  return `// AUTO-GENERATED by scripts/generate-client.ts — do not edit by hand.
// Regenerate with: npm run generate

export interface EndpointParam {
  name: string;
  required: boolean;
  type: string;
}

export interface EndpointDef {
  key: string;
  path: string;
  params: EndpointParam[];
}

export const ENDPOINTS: readonly EndpointDef[] = [
${entries}
] as const;

export type EndpointKey = (typeof ENDPOINTS)[number]["key"];
`;
}

function main(): void {
  const specPath = new URL("../spec/buchhaltungsbutler-v1.json", import.meta.url);
  const spec: SwaggerSpec = JSON.parse(readFileSync(specPath, "utf-8"));
  const endpoints = extractEndpoints(spec);
  const outPath = new URL("../src/bb-client/generated/endpoints.ts", import.meta.url);
  writeFileSync(outPath, render(endpoints));
  console.log(`Generated ${endpoints.length} endpoints to src/bb-client/generated/endpoints.ts`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- scripts/generate-client.test.ts`
Expected: PASS

- [ ] **Step 5: Generate the committed output and commit**

```bash
mkdir -p src/bb-client/generated
npm run generate
npm test -- scripts/generate-client.test.ts
git add scripts/generate-client.ts scripts/generate-client.test.ts src/bb-client/generated/endpoints.ts
git commit -m "feat: add spec-driven codegen for BB API endpoint metadata"
```

---

## Task 4: Generic BuchhaltungsButler HTTP Client

**Goal:** A typed, generic client that calls any of the 48 generated endpoints with Basic Auth, `api_key` injection, id-suffix support, required-field validation, and structured error mapping (including rate-limit errors).

**Files:**
- Create: `src/bb-client/errors.ts`
- Create: `src/bb-client/client.ts`
- Test: `src/bb-client/client.test.ts`

**Acceptance Criteria:**
- [ ] `client.call("accountsGet", {})` sends `POST {baseUrl}/accounts/get` with header `Authorization: Basic <base64(client:secret)>`, JSON body `{"api_key":"<key>"}`, and returns the parsed JSON response
- [ ] `client.call("receiptsAdd", {type: "..."})` throws before making any HTTP request when a required field (e.g. `counterparty`) is missing, listing the missing field name(s)
- [ ] `client.call("receiptsGetIdByCustomer", {}, {idSuffix: 42})` sends `POST {baseUrl}/receipts/get/id_by_customer/42`
- [ ] On HTTP 429, `client.call(...)` rejects with a `BuchhaltungsButlerRateLimitError`
- [ ] On any other non-2xx response, `client.call(...)` rejects with a `BuchhaltungsButlerApiError` carrying `statusCode`, `endpoint`, and the parsed error response body
- [ ] `client.call("unknownKey" as EndpointKey, {})` throws synchronously with a message naming the unknown key

**Verify:** `npm test -- src/bb-client/client.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/bb-client/client.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/bb-client/client.test.ts`
Expected: FAIL — `Cannot find module './client.js'`

- [ ] **Step 3: Write minimal implementation**

`src/bb-client/errors.ts`:

```ts
export class BuchhaltungsButlerApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly endpoint: string,
    public readonly responseBody: unknown
  ) {
    super(message);
    this.name = "BuchhaltungsButlerApiError";
  }
}

export class BuchhaltungsButlerRateLimitError extends BuchhaltungsButlerApiError {
  constructor(endpoint: string, responseBody: unknown) {
    super(
      `BuchhaltungsButler API rate limit exceeded on ${endpoint} (max 100 requests/min per customer)`,
      429,
      endpoint,
      responseBody
    );
    this.name = "BuchhaltungsButlerRateLimitError";
  }
}
```

`src/bb-client/client.ts`:

```ts
import type { Config } from "../config.js";
import { ENDPOINTS, type EndpointKey } from "./generated/endpoints.js";
import { BuchhaltungsButlerApiError, BuchhaltungsButlerRateLimitError } from "./errors.js";

export interface BBListResult<T = Record<string, unknown>> {
  success: boolean;
  message: string;
  rows: number;
  data: T[];
}

export interface BBActionResult {
  success: boolean;
  message: string;
  [key: string]: unknown;
}

export interface CallOptions {
  idSuffix?: string | number;
}

export interface BBClient {
  call<T = unknown>(
    endpointKey: EndpointKey,
    params: Record<string, unknown>,
    options?: CallOptions
  ): Promise<T>;
}

const endpointByKey = new Map(ENDPOINTS.map((e) => [e.key, e]));

export function createClient(config: Config, fetchImpl: typeof fetch = fetch): BBClient {
  return {
    async call<T>(endpointKey: EndpointKey, params: Record<string, unknown>, options?: CallOptions) {
      const endpoint = endpointByKey.get(endpointKey);
      if (!endpoint) {
        throw new Error(`Unknown BuchhaltungsButler endpoint key: ${endpointKey}`);
      }

      const missing = endpoint.params
        .filter((p) => p.required && p.name !== "api_key" && params[p.name] === undefined)
        .map((p) => p.name);
      if (missing.length > 0) {
        throw new Error(`Missing required field(s) for ${endpointKey}: ${missing.join(", ")}`);
      }

      const url = `${config.baseUrl}${endpoint.path}${options?.idSuffix !== undefined ? `/${options.idSuffix}` : ""}`;
      const auth = Buffer.from(`${config.apiClient}:${config.apiSecret}`).toString("base64");

      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...params, api_key: config.apiKey }),
      });

      const json = await response.json();

      if (response.status === 429) {
        throw new BuchhaltungsButlerRateLimitError(endpoint.path, json);
      }

      if (!response.ok) {
        throw new BuchhaltungsButlerApiError(
          `BuchhaltungsButler API error on ${endpointKey}: HTTP ${response.status}`,
          response.status,
          endpoint.path,
          json
        );
      }

      return json as T;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/bb-client/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bb-client/errors.ts src/bb-client/client.ts src/bb-client/client.test.ts
git commit -m "feat: add generic BB API client with auth, validation, and error mapping"
```

---

## Task 5: Response Trimming Utility

**Goal:** A shared helper that trims list responses to a default field set unless the caller requests the full record, used by every list-returning tool.

**Files:**
- Create: `src/formatting/trim.ts`
- Test: `src/formatting/trim.test.ts`

**Acceptance Criteria:**
- [ ] `trimList(records, fields, false)` returns each record reduced to only the given `fields`, preserving order and omitting keys not present in the source record
- [ ] `trimList(records, fields, true)` returns each record unchanged (shallow copy)
- [ ] `trimList([], fields, false)` returns `[]`

**Verify:** `npm test -- src/formatting/trim.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/formatting/trim.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { trimList } from "./trim.js";

describe("trimList", () => {
  const records = [
    { id_by_customer: "1", date: "2026-01-01", amount: "10.00", counterparty: "ACME", internal_note: "x" },
    { id_by_customer: "2", date: "2026-01-02", amount: "20.00", counterparty: "Foo GmbH", internal_note: "y" },
  ];
  const fields = ["id_by_customer", "date", "amount", "counterparty"] as const;

  it("trims to the given fields when full is false", () => {
    expect(trimList(records, fields, false)).toEqual([
      { id_by_customer: "1", date: "2026-01-01", amount: "10.00", counterparty: "ACME" },
      { id_by_customer: "2", date: "2026-01-02", amount: "20.00", counterparty: "Foo GmbH" },
    ]);
  });

  it("returns records unchanged when full is true", () => {
    expect(trimList(records, fields, true)).toEqual(records);
  });

  it("returns an empty array for an empty input", () => {
    expect(trimList([], fields, false)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/formatting/trim.test.ts`
Expected: FAIL — `Cannot find module './trim.js'`

- [ ] **Step 3: Write minimal implementation**

`src/formatting/trim.ts`:

```ts
export function trimList<T extends Record<string, unknown>>(
  records: readonly T[],
  fields: readonly string[],
  full: boolean
): Array<Partial<T>> {
  if (full) {
    return records.map((record) => ({ ...record }));
  }
  return records.map((record) => {
    const out: Partial<T> = {};
    for (const field of fields) {
      if (field in record) {
        out[field as keyof T] = record[field as keyof T];
      }
    }
    return out;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/formatting/trim.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/formatting/trim.ts src/formatting/trim.test.ts
git commit -m "feat: add response-trimming utility for token-efficient list output"
```

---

## Task 6: Accounts Tools

**Goal:** MCP tools for the 2 Accounts endpoints — list existing accounts and create a new basic account.

**Files:**
- Create: `src/tools/types.ts`
- Create: `src/tools/accounts.ts`
- Test: `src/tools/accounts.test.ts`

**Acceptance Criteria:**
- [ ] `list_accounts` calls `accountsGet` and returns `data` as JSON text content
- [ ] `create_account` calls `accountsAdd` with `type`, `name`, `postingaccount_number`, and optional `receipt_creates_transaction`/`is_revision_safe`, rejecting `type` values outside `"cash" | "bank/institution" | "other"` via Zod before calling the client
- [ ] Both tools' `handler` returns `{content: [{type: "text", text: "<JSON>"}]}`

**Verify:** `npm test -- src/tools/accounts.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/tools/types.ts`:

```ts
import type { z, ZodRawShape } from "zod";

export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>;
}

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function defineTool<Shape extends ZodRawShape>(tool: ToolDef<Shape>): ToolDef {
  return tool as unknown as ToolDef;
}
```

`defineTool` exists because TypeScript's structural typing won't let a `ToolDef<SpecificShape>` stand in for the default `ToolDef` (function parameters are checked contravariantly, so a handler that only accepts `SpecificShape`'s inferred args isn't assignable to "accepts any shape's args"). Passing the object literal through `defineTool(...)` still gives the handler full, precise argument typing from `Shape` (TypeScript infers `Shape` from the argument you pass in), while the return value is the type-erased `ToolDef` every tool array actually needs — the erasure is safe in practice because the MCP SDK always calls a tool's handler with arguments already validated against that same tool's own `inputSchema`. Every tool constant below is defined via `defineTool({...})`, not a bare object literal, for this reason.

`src/tools/accounts.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createAccountsTools } from "./accounts.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("accounts tools", () => {
  it("list_accounts calls accountsGet and returns the data array", async () => {
    const client = mockClient({ success: true, rows: 1, data: [{ name: "Kasse", postingaccount_number: "1000" }] });
    const [listAccounts] = createAccountsTools(client);

    const result = await listAccounts.handler({});

    expect(client.call).toHaveBeenCalledWith("accountsGet", {});
    expect(JSON.parse(result.content[0].text)).toEqual([{ name: "Kasse", postingaccount_number: "1000" }]);
  });

  it("create_account calls accountsAdd with the given fields", async () => {
    const client = mockClient({ success: true, message: "ok" });
    const [, createAccount] = createAccountsTools(client);

    await createAccount.handler({
      type: "bank/institution",
      name: "Geschäftskonto",
      postingaccount_number: 1200,
    });

    expect(client.call).toHaveBeenCalledWith("accountsAdd", {
      type: "bank/institution",
      name: "Geschäftskonto",
      postingaccount_number: 1200,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/tools/accounts.test.ts`
Expected: FAIL — `Cannot find module './accounts.js'`

- [ ] **Step 3: Write minimal implementation**

`src/tools/accounts.ts`:

```ts
import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import type { BBListResult } from "../bb-client/client.js";
import { defineTool, ok, type ToolDef } from "./types.js";

export function createAccountsTools(client: BBClient): [ToolDef, ToolDef] {
  const listAccounts = defineTool({
    name: "list_accounts",
    description: "List all basic accounts (cash, bank, other) configured in BuchhaltungsButler.",
    inputSchema: {},
    async handler() {
      const result = await client.call<BBListResult>("accountsGet", {});
      return ok(result.data);
    },
  });

  const createAccountShape = {
    type: z.enum(["cash", "bank/institution", "other"]),
    name: z.string(),
    postingaccount_number: z.number().int(),
    receipt_creates_transaction: z.boolean().optional(),
    is_revision_safe: z.boolean().optional(),
  };

  const createAccount = defineTool({
    name: "create_account",
    description: "Create a new basic account (cash register, bank account, or other).",
    inputSchema: createAccountShape,
    async handler(args) {
      const result = await client.call("accountsAdd", args);
      return ok(result);
    },
  });

  return [listAccounts, createAccount];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/tools/accounts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/types.ts src/tools/accounts.ts src/tools/accounts.test.ts
git commit -m "feat: add list_accounts and create_account MCP tools"
```

---

## Task 7: Comments Tool

**Goal:** An MCP tool for the single Comments endpoint — attach a comment to a transaction or receipt.

**Files:**
- Create: `src/tools/comments.ts`
- Test: `src/tools/comments.test.ts`

**Acceptance Criteria:**
- [ ] `add_comment` requires `comment_text` and accepts optional `transaction_id_by_customer` and `receipt_id_by_customer`
- [ ] `add_comment` calls `commentsAdd` with exactly the provided fields

**Verify:** `npm test -- src/tools/comments.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/tools/comments.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createCommentsTools } from "./comments.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("comments tools", () => {
  it("add_comment calls commentsAdd with the given fields", async () => {
    const client = mockClient({ success: true, message: "ok" });
    const [addComment] = createCommentsTools(client);

    await addComment.handler({ comment_text: "geprüft", receipt_id_by_customer: 7 });

    expect(client.call).toHaveBeenCalledWith("commentsAdd", {
      comment_text: "geprüft",
      receipt_id_by_customer: 7,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/tools/comments.test.ts`
Expected: FAIL — `Cannot find module './comments.js'`

- [ ] **Step 3: Write minimal implementation**

`src/tools/comments.ts`:

```ts
import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { defineTool, ok, type ToolDef } from "./types.js";

export function createCommentsTools(client: BBClient): [ToolDef] {
  const addCommentShape = {
    comment_text: z.string(),
    transaction_id_by_customer: z.number().int().optional(),
    receipt_id_by_customer: z.number().int().optional(),
  };

  const addComment = defineTool({
    name: "add_comment",
    description: "Add a comment to a transaction or a receipt (provide the matching id).",
    inputSchema: addCommentShape,
    async handler(args) {
      const result = await client.call("commentsAdd", args);
      return ok(result);
    },
  });

  return [addComment];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/tools/comments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/comments.ts src/tools/comments.test.ts
git commit -m "feat: add add_comment MCP tool"
```

---

## Task 8: Cost Locations Tools

**Goal:** MCP tools for the 4 Cost Locations endpoints, consolidated into a list tool and one action-parameterized manage tool.

**Files:**
- Create: `src/tools/cost-locations.ts`
- Test: `src/tools/cost-locations.test.ts`

**Acceptance Criteria:**
- [ ] `list_cost_locations` calls `costLocationsGet` and returns trimmed `{code, name}` records by default, full records when `full: true`
- [ ] `manage_cost_location` with `action: "create"` calls `costLocationsAdd` with `{code, name}`
- [ ] `manage_cost_location` with `action: "update"` calls `costLocationsUpdate` with `{code, name}`
- [ ] `manage_cost_location` with `action: "delete"` calls `costLocationsDelete` with `{code}` only (rejects `name` via Zod discriminated union if provided for delete)

**Verify:** `npm test -- src/tools/cost-locations.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/tools/cost-locations.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createCostLocationsTools } from "./cost-locations.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("cost locations tools", () => {
  it("list_cost_locations trims to code/name by default", async () => {
    const client = mockClient({
      success: true,
      rows: 1,
      data: [{ code: "CL1", name: "Marketing", internal: "x" }],
    });
    const [listCostLocations] = createCostLocationsTools(client);

    const result = await listCostLocations.handler({ full: false });

    expect(JSON.parse(result.content[0].text)).toEqual([{ code: "CL1", name: "Marketing" }]);
  });

  it("manage_cost_location create calls costLocationsAdd", async () => {
    const client = mockClient({ success: true });
    const [, manageCostLocation] = createCostLocationsTools(client);

    await manageCostLocation.handler({ action: "create", code: "CL1", name: "Marketing" });

    expect(client.call).toHaveBeenCalledWith("costLocationsAdd", { code: "CL1", name: "Marketing" });
  });

  it("manage_cost_location update calls costLocationsUpdate", async () => {
    const client = mockClient({ success: true });
    const [, manageCostLocation] = createCostLocationsTools(client);

    await manageCostLocation.handler({ action: "update", code: "CL1", name: "Vertrieb" });

    expect(client.call).toHaveBeenCalledWith("costLocationsUpdate", { code: "CL1", name: "Vertrieb" });
  });

  it("manage_cost_location delete calls costLocationsDelete with only code", async () => {
    const client = mockClient({ success: true });
    const [, manageCostLocation] = createCostLocationsTools(client);

    await manageCostLocation.handler({ action: "delete", code: "CL1" });

    expect(client.call).toHaveBeenCalledWith("costLocationsDelete", { code: "CL1" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/tools/cost-locations.test.ts`
Expected: FAIL — `Cannot find module './cost-locations.js'`

- [ ] **Step 3: Write minimal implementation**

`src/tools/cost-locations.ts`:

```ts
import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { defineTool, ok, type ToolDef } from "./types.js";

const SUMMARY_FIELDS = ["code", "name"] as const;

export function createCostLocationsTools(client: BBClient): [ToolDef, ToolDef] {
  const listShape = {
    full: z.boolean().default(false),
  };

  const listCostLocations = defineTool({
    name: "list_cost_locations",
    description: "List all cost locations (Kostenstellen).",
    inputSchema: listShape,
    async handler(args) {
      const result = await client.call<BBListResult>("costLocationsGet", {});
      return ok(trimList(result.data, SUMMARY_FIELDS, args.full));
    },
  });

  const manageShape = {
    action: z.enum(["create", "update", "delete"]),
    code: z.string(),
    name: z.string().optional(),
  };

  const manageCostLocation = defineTool({
    name: "manage_cost_location",
    description:
      "Create, update, or delete a cost location. 'name' is required for create/update and ignored for delete.",
    inputSchema: manageShape,
    async handler(args) {
      if (args.action === "delete") {
        const result = await client.call("costLocationsDelete", { code: args.code });
        return ok(result);
      }
      if (!args.name) {
        throw new Error(`"name" is required for action "${args.action}"`);
      }
      const endpointKey = args.action === "create" ? "costLocationsAdd" : "costLocationsUpdate";
      const result = await client.call(endpointKey, { code: args.code, name: args.name });
      return ok(result);
    },
  });

  return [listCostLocations, manageCostLocation];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/tools/cost-locations.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/cost-locations.ts src/tools/cost-locations.test.ts
git commit -m "feat: add list_cost_locations and manage_cost_location MCP tools"
```

---

## Task 9: Contacts Tools (Debtors & Creditors)

**Goal:** MCP tools for the 8 debtor/creditor Settings endpoints, consolidated by a `contact_type` parameter into 3 tools instead of 6.

**Files:**
- Create: `src/tools/contacts.ts`
- Test: `src/tools/contacts.test.ts`

**Acceptance Criteria:**
- [ ] `list_contacts` with `contact_type: "debtor"` calls `settingsGetDebtors`; with `"creditor"` calls `settingsGetCreditors`; both pass through `limit`/`offset` and default `limit` to 20
- [ ] `create_contacts` with `contact_type: "debtor"` calls `settingsAddBatchDebtors` with `{debtors: [...]}`; with `"creditor"` calls `settingsAddBatchCreditors` with `{creditors: [...]}`; both require a non-empty array of `{name, postingaccount_number?, contact_person_name?, street?, additional_address_line?, zip?, city?, country?, sales_tax_id?, email?, iban?, bic?, customer_number?, due_in_days?}` entries
- [ ] `update_contact` with `contact_type: "debtor"` calls `settingsUpdateDebtor`; with `"creditor"` calls `settingsUpdateCreditor`; both require `postingaccount_number`

**Verify:** `npm test -- src/tools/contacts.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/tools/contacts.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createContactsTools } from "./contacts.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("contacts tools", () => {
  it("list_contacts routes debtor to settingsGetDebtors with limit/offset defaults", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [listContacts] = createContactsTools(client);

    await listContacts.handler({ contact_type: "debtor" });

    expect(client.call).toHaveBeenCalledWith("settingsGetDebtors", { limit: 20, offset: 0 });
  });

  it("list_contacts routes creditor to settingsGetCreditors", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [listContacts] = createContactsTools(client);

    await listContacts.handler({ contact_type: "creditor", limit: 5, offset: 10 });

    expect(client.call).toHaveBeenCalledWith("settingsGetCreditors", { limit: 5, offset: 10 });
  });

  it("create_contacts routes debtor batch to settingsAddBatchDebtors", async () => {
    const client = mockClient({ success: true });
    const [, createContacts] = createContactsTools(client);

    await createContacts.handler({
      contact_type: "debtor",
      contacts: [{ name: "Kunde GmbH" }],
    });

    expect(client.call).toHaveBeenCalledWith("settingsAddBatchDebtors", {
      debtors: [{ name: "Kunde GmbH" }],
    });
  });

  it("create_contacts routes creditor batch to settingsAddBatchCreditors", async () => {
    const client = mockClient({ success: true });
    const [, createContacts] = createContactsTools(client);

    await createContacts.handler({
      contact_type: "creditor",
      contacts: [{ name: "Lieferant AG", due_in_days: 14 }],
    });

    expect(client.call).toHaveBeenCalledWith("settingsAddBatchCreditors", {
      creditors: [{ name: "Lieferant AG", due_in_days: 14 }],
    });
  });

  it("update_contact routes debtor to settingsUpdateDebtor", async () => {
    const client = mockClient({ success: true });
    const [, , updateContact] = createContactsTools(client);

    await updateContact.handler({
      contact_type: "debtor",
      postingaccount_number: 10001,
      city: "Berlin",
    });

    expect(client.call).toHaveBeenCalledWith("settingsUpdateDebtor", {
      postingaccount_number: 10001,
      city: "Berlin",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/tools/contacts.test.ts`
Expected: FAIL — `Cannot find module './contacts.js'`

- [ ] **Step 3: Write minimal implementation**

`src/tools/contacts.ts`:

```ts
import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { defineTool, ok, type ToolDef } from "./types.js";

const SUMMARY_FIELDS = ["postingaccount_number", "name", "email", "city"] as const;

const contactFieldsShape = {
  name: z.string(),
  postingaccount_number: z.string().optional(),
  contact_person_name: z.string().optional(),
  street: z.string().optional(),
  additional_address_line: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  sales_tax_id: z.string().optional(),
  email: z.string().optional(),
  iban: z.string().optional(),
  bic: z.string().optional(),
  customer_number: z.string().optional(),
  due_in_days: z.number().int().optional(),
};

export function createContactsTools(client: BBClient): [ToolDef, ToolDef, ToolDef] {
  const listShape = {
    contact_type: z.enum(["debtor", "creditor"]),
    limit: z.number().int().max(25).default(20),
    offset: z.number().int().default(0),
    full: z.boolean().default(false),
  };

  const listContacts = defineTool({
    name: "list_contacts",
    description: "List debtors (Debitoren) or creditors (Kreditoren).",
    inputSchema: listShape,
    async handler(args) {
      const endpointKey = args.contact_type === "debtor" ? "settingsGetDebtors" : "settingsGetCreditors";
      const result = await client.call<BBListResult>(endpointKey, {
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
      });
      return ok(trimList(result.data, SUMMARY_FIELDS, args.full ?? false));
    },
  });

  const createShape = {
    contact_type: z.enum(["debtor", "creditor"]),
    contacts: z.array(z.object(contactFieldsShape)).min(1),
  };

  const createContacts = defineTool({
    name: "create_contacts",
    description: "Create one or more debtors or creditors in a single batch call.",
    inputSchema: createShape,
    async handler(args) {
      const endpointKey = args.contact_type === "debtor" ? "settingsAddBatchDebtors" : "settingsAddBatchCreditors";
      const payloadKey = args.contact_type === "debtor" ? "debtors" : "creditors";
      const result = await client.call(endpointKey, { [payloadKey]: args.contacts });
      return ok(result);
    },
  });

  const updateShape = {
    contact_type: z.enum(["debtor", "creditor"]),
    postingaccount_number: z.number().int(),
    name: z.string().optional(),
    contact_person_name: z.string().optional(),
    street: z.string().optional(),
    additional_address_line: z.string().optional(),
    zip: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    sales_tax_id: z.string().optional(),
    email: z.string().optional(),
    iban: z.string().optional(),
    bic: z.string().optional(),
    due_in_days: z.number().int().optional(),
  };

  const updateContact = defineTool({
    name: "update_contact",
    description: "Update an existing debtor or creditor, identified by postingaccount_number.",
    inputSchema: updateShape,
    async handler(args) {
      const { contact_type, ...fields } = args;
      const endpointKey = contact_type === "debtor" ? "settingsUpdateDebtor" : "settingsUpdateCreditor";
      const result = await client.call(endpointKey, fields);
      return ok(result);
    },
  });

  return [listContacts, createContacts, updateContact];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/tools/contacts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/contacts.ts src/tools/contacts.test.ts
git commit -m "feat: add list_contacts, create_contacts, update_contact MCP tools"
```

---

## Task 10: Posting Accounts Tools

**Goal:** MCP tools for the 3 posting-account Settings endpoints (no delete endpoint exists for these).

**Files:**
- Create: `src/tools/posting-accounts.ts`
- Test: `src/tools/posting-accounts.test.ts`

**Acceptance Criteria:**
- [ ] `list_posting_accounts` calls `settingsGetPostingaccounts`, passing through `limit`/`offset`/`exclude_postingaccounts`/`exclude_accounts`/`exclude_creditors`/`exclude_debtors`
- [ ] `manage_posting_account` with `action: "create"` calls `settingsAddPostingaccount` with `{name, postingaccount_number, parent_postingaccount_number}`
- [ ] `manage_posting_account` with `action: "update"` calls `settingsUpdatePostingaccount` with `{name, postingaccount_number}`

**Verify:** `npm test -- src/tools/posting-accounts.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/tools/posting-accounts.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createPostingAccountsTools } from "./posting-accounts.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("posting accounts tools", () => {
  it("list_posting_accounts calls settingsGetPostingaccounts with filters", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [listPostingAccounts] = createPostingAccountsTools(client);

    await listPostingAccounts.handler({ limit: 20, offset: 0, exclude_debtors: true });

    expect(client.call).toHaveBeenCalledWith("settingsGetPostingaccounts", {
      limit: 20,
      offset: 0,
      exclude_debtors: true,
    });
  });

  it("manage_posting_account create calls settingsAddPostingaccount", async () => {
    const client = mockClient({ success: true });
    const [, managePostingAccount] = createPostingAccountsTools(client);

    await managePostingAccount.handler({
      action: "create",
      name: "Büromaterial",
      postingaccount_number: 6815,
      parent_postingaccount_number: 6800,
    });

    expect(client.call).toHaveBeenCalledWith("settingsAddPostingaccount", {
      name: "Büromaterial",
      postingaccount_number: 6815,
      parent_postingaccount_number: 6800,
    });
  });

  it("manage_posting_account update calls settingsUpdatePostingaccount", async () => {
    const client = mockClient({ success: true });
    const [, managePostingAccount] = createPostingAccountsTools(client);

    await managePostingAccount.handler({ action: "update", name: "Büromaterial neu", postingaccount_number: 6815 });

    expect(client.call).toHaveBeenCalledWith("settingsUpdatePostingaccount", {
      name: "Büromaterial neu",
      postingaccount_number: 6815,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/tools/posting-accounts.test.ts`
Expected: FAIL — `Cannot find module './posting-accounts.js'`

- [ ] **Step 3: Write minimal implementation**

`src/tools/posting-accounts.ts`:

```ts
import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { defineTool, ok, type ToolDef } from "./types.js";

export function createPostingAccountsTools(client: BBClient): [ToolDef, ToolDef] {
  const listShape = {
    limit: z.number().int().default(20),
    offset: z.number().int().default(0),
    exclude_postingaccounts: z.boolean().optional(),
    exclude_accounts: z.boolean().optional(),
    exclude_creditors: z.boolean().optional(),
    exclude_debtors: z.boolean().optional(),
  };

  const listPostingAccounts = defineTool({
    name: "list_posting_accounts",
    description: "List posting accounts (Buchungskonten / SKR chart of accounts entries).",
    inputSchema: listShape,
    async handler(args) {
      const result = await client.call("settingsGetPostingaccounts", args);
      return ok(result);
    },
  });

  const manageShape = {
    action: z.enum(["create", "update"]),
    name: z.string(),
    postingaccount_number: z.number().int(),
    parent_postingaccount_number: z.number().int().optional(),
  };

  const managePostingAccount = defineTool({
    name: "manage_posting_account",
    description:
      "Create or update a posting account. parent_postingaccount_number is required for create, ignored for update.",
    inputSchema: manageShape,
    async handler(args) {
      if (args.action === "create") {
        if (args.parent_postingaccount_number === undefined) {
          throw new Error(`"parent_postingaccount_number" is required for action "create"`);
        }
        const result = await client.call("settingsAddPostingaccount", {
          name: args.name,
          postingaccount_number: args.postingaccount_number,
          parent_postingaccount_number: args.parent_postingaccount_number,
        });
        return ok(result);
      }
      const result = await client.call("settingsUpdatePostingaccount", {
        name: args.name,
        postingaccount_number: args.postingaccount_number,
      });
      return ok(result);
    },
  });

  return [listPostingAccounts, managePostingAccount];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/tools/posting-accounts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/posting-accounts.ts src/tools/posting-accounts.test.ts
git commit -m "feat: add list_posting_accounts and manage_posting_account MCP tools"
```

---

## Task 11: Receipts Tools

**Goal:** MCP tools for the 8 Receipts endpoints, consolidated into 6 tools.

**Files:**
- Create: `src/tools/receipts.ts`
- Test: `src/tools/receipts.test.ts`

**Acceptance Criteria:**
- [ ] `list_receipts` requires `list_direction` (`"inbound" | "outbound"`), defaults `limit` to 20, trims to `{id_by_customer, type, date, counterparty, amount, invoicenumber, due_date, deleted}` unless `full: true`
- [ ] `get_receipt` calls `receiptsGetIdByCustomer` with `idSuffix` set to the given `id_by_customer`
- [ ] `create_receipts` calls `receiptsAddBatch` with `{receipts: [...]}`, each entry requiring `type` (one of the 4 documented enum values), `counterparty`, `invoice_number`, `date`, `amount`, `currency`, limited to at most 50 entries
- [ ] `upload_receipt` calls `receiptsUpload` with `file`, `type`, and optional metadata fields
- [ ] `set_receipt_deleted` with `deleted: true` calls `receiptsDeleteIdByCustomer` with `idSuffix`; with `deleted: false` calls `receiptsRestoreIdByCustomer` with `idSuffix`
- [ ] `get_receipt_transactions` calls `receiptsAssignedTransactionsGet` with `receipt_id_by_customer` and optional `confirmed_only`

**Verify:** `npm test -- src/tools/receipts.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/tools/receipts.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createReceiptsTools } from "./receipts.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("receipts tools", () => {
  it("list_receipts trims fields and defaults limit to 20", async () => {
    const client = mockClient({
      success: true,
      rows: 1,
      data: [
        {
          id_by_customer: "1",
          type: "invoice inbound",
          date: "2026-01-01",
          counterparty: "ACME",
          amount: "10.00",
          invoicenumber: "R-1",
          due_date: "2026-01-15",
          deleted: "0",
          filename: "x.pdf",
        },
      ],
    });
    const [listReceipts] = createReceiptsTools(client);

    const result = await listReceipts.handler({ list_direction: "inbound" });

    expect(client.call).toHaveBeenCalledWith("receiptsGet", {
      list_direction: "inbound",
      limit: 20,
      offset: 0,
    });
    expect(JSON.parse(result.content[0].text)).toEqual([
      {
        id_by_customer: "1",
        type: "invoice inbound",
        date: "2026-01-01",
        counterparty: "ACME",
        amount: "10.00",
        invoicenumber: "R-1",
        due_date: "2026-01-15",
        deleted: "0",
      },
    ]);
  });

  it("get_receipt calls receiptsGetIdByCustomer with idSuffix", async () => {
    const client = mockClient({ success: true, data: { id_by_customer: "42" } });
    const [, getReceipt] = createReceiptsTools(client);

    await getReceipt.handler({ id_by_customer: 42 });

    expect(client.call).toHaveBeenCalledWith("receiptsGetIdByCustomer", {}, { idSuffix: 42 });
  });

  it("create_receipts calls receiptsAddBatch with a receipts array", async () => {
    const client = mockClient({ success: true });
    const [, , createReceipts] = createReceiptsTools(client);

    await createReceipts.handler({
      receipts: [
        {
          type: "invoice inbound",
          counterparty: "ACME",
          invoice_number: "R-1",
          date: "2026-01-01",
          amount: 10,
          currency: "EUR",
        },
      ],
    });

    expect(client.call).toHaveBeenCalledWith("receiptsAddBatch", {
      receipts: [
        {
          type: "invoice inbound",
          counterparty: "ACME",
          invoice_number: "R-1",
          date: "2026-01-01",
          amount: 10,
          currency: "EUR",
        },
      ],
    });
  });

  it("upload_receipt calls receiptsUpload", async () => {
    const client = mockClient({ success: true, id_by_customer: "9" });
    const [, , , uploadReceipt] = createReceiptsTools(client);

    await uploadReceipt.handler({ file: "base64...", type: "invoice inbound" });

    expect(client.call).toHaveBeenCalledWith("receiptsUpload", { file: "base64...", type: "invoice inbound" });
  });

  it("set_receipt_deleted true calls receiptsDeleteIdByCustomer", async () => {
    const client = mockClient({ success: true });
    const [, , , , setReceiptDeleted] = createReceiptsTools(client);

    await setReceiptDeleted.handler({ id_by_customer: 42, deleted: true });

    expect(client.call).toHaveBeenCalledWith("receiptsDeleteIdByCustomer", {}, { idSuffix: 42 });
  });

  it("set_receipt_deleted false calls receiptsRestoreIdByCustomer", async () => {
    const client = mockClient({ success: true });
    const [, , , , setReceiptDeleted] = createReceiptsTools(client);

    await setReceiptDeleted.handler({ id_by_customer: 42, deleted: false });

    expect(client.call).toHaveBeenCalledWith("receiptsRestoreIdByCustomer", {}, { idSuffix: 42 });
  });

  it("get_receipt_transactions calls receiptsAssignedTransactionsGet", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [, , , , , getReceiptTransactions] = createReceiptsTools(client);

    await getReceiptTransactions.handler({ receipt_id_by_customer: 42, confirmed_only: true });

    expect(client.call).toHaveBeenCalledWith("receiptsAssignedTransactionsGet", {
      receipt_id_by_customer: 42,
      confirmed_only: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/tools/receipts.test.ts`
Expected: FAIL — `Cannot find module './receipts.js'`

- [ ] **Step 3: Write minimal implementation**

`src/tools/receipts.ts`:

```ts
import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { defineTool, ok, type ToolDef } from "./types.js";

const SUMMARY_FIELDS = [
  "id_by_customer",
  "type",
  "date",
  "counterparty",
  "amount",
  "invoicenumber",
  "due_date",
  "deleted",
] as const;

const RECEIPT_TYPE = z.enum(["invoice inbound", "invoice outbound", "credit inbound", "credit outbound"]);

export function createReceiptsTools(client: BBClient): [ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef] {
  const listShape = {
    list_direction: z.enum(["inbound", "outbound"]),
    payment_status: z.enum(["paid", "unpaid"]).optional(),
    counterparty: z.string().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    limit: z.number().int().max(500).default(20),
    offset: z.number().int().default(0),
    deleted: z.boolean().optional(),
    full: z.boolean().default(false),
  };

  const listReceipts = defineTool({
    name: "list_receipts",
    description: "List receipts (Belege), inbound or outbound, with optional filters.",
    inputSchema: listShape,
    async handler(args) {
      const { full, limit, offset, ...filters } = args;
      const result = await client.call<BBListResult>("receiptsGet", {
        ...filters,
        limit: limit ?? 20,
        offset: offset ?? 0,
      });
      return ok(trimList(result.data, SUMMARY_FIELDS, full ?? false));
    },
  });

  const getShape = {
    id_by_customer: z.number().int(),
    get_file: z.boolean().optional(),
  };

  const getReceipt = defineTool({
    name: "get_receipt",
    description: "Get a single receipt by its id_by_customer.",
    inputSchema: getShape,
    async handler(args) {
      const { id_by_customer, ...rest } = args;
      const result = await client.call("receiptsGetIdByCustomer", rest, { idSuffix: id_by_customer });
      return ok(result);
    },
  });

  const receiptEntryShape = z.object({
    type: RECEIPT_TYPE,
    counterparty: z.string(),
    invoice_number: z.string(),
    date: z.string(),
    amount: z.number(),
    currency: z.string(),
    vat_rate: z.number().optional(),
    account: z.number().int().optional(),
    creditor_debtor: z.number().int().optional(),
    payment_reference: z.string().optional(),
    date_delivery: z.string().optional(),
    date_payment_due: z.string().optional(),
    link_to_receipt_id_by_customer: z.number().int().optional(),
  });

  const createShape = {
    receipts: z.array(receiptEntryShape).min(1).max(50),
  };

  const createReceipts = defineTool({
    name: "create_receipts",
    description: "Create one or more receipts in a single batch call (up to 50).",
    inputSchema: createShape,
    async handler(args) {
      const result = await client.call("receiptsAddBatch", { receipts: args.receipts });
      return ok(result);
    },
  });

  const uploadShape = {
    file: z.string(),
    type: z.enum(["invoice inbound", "invoice outbound", "credit inbound", "credit outbound"]),
    file_name: z.string().optional(),
    account: z.number().int().optional(),
    creditor_debtor: z.number().int().optional(),
    counterparty: z.string().optional(),
    invoice_number: z.string().optional(),
    date: z.string().optional(),
    amount: z.number().optional(),
    currency: z.string().optional(),
    vat_rate: z.number().optional(),
    payment_reference: z.string().optional(),
    date_delivery: z.string().optional(),
    date_payment_due: z.string().optional(),
    link_to_receipt_id_by_customer: z.number().int().optional(),
  };

  const uploadReceipt = defineTool({
    name: "upload_receipt",
    description:
      "Upload a receipt file (base64-encoded PDF/XML/image) for OCR-assisted processing, with optional known metadata.",
    inputSchema: uploadShape,
    async handler(args) {
      const result = await client.call("receiptsUpload", args);
      return ok(result);
    },
  });

  const setDeletedShape = {
    id_by_customer: z.number().int(),
    deleted: z.boolean(),
  };

  const setReceiptDeleted = defineTool({
    name: "set_receipt_deleted",
    description: "Mark a receipt as deleted (deleted: true) or restore it (deleted: false).",
    inputSchema: setDeletedShape,
    async handler(args) {
      const endpointKey = args.deleted ? "receiptsDeleteIdByCustomer" : "receiptsRestoreIdByCustomer";
      const result = await client.call(endpointKey, {}, { idSuffix: args.id_by_customer });
      return ok(result);
    },
  });

  const assignedShape = {
    receipt_id_by_customer: z.number().int(),
    confirmed_only: z.boolean().optional(),
  };

  const getReceiptTransactions = defineTool({
    name: "get_receipt_transactions",
    description: "Get all transactions assigned to a specific receipt.",
    inputSchema: assignedShape,
    async handler(args) {
      const result = await client.call("receiptsAssignedTransactionsGet", args);
      return ok(result);
    },
  });

  return [listReceipts, getReceipt, createReceipts, uploadReceipt, setReceiptDeleted, getReceiptTransactions];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/tools/receipts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/receipts.ts src/tools/receipts.test.ts
git commit -m "feat: add receipts MCP tools (list, get, create, upload, delete/restore, transactions)"
```

---

## Task 12: Transactions Tools

**Goal:** MCP tools for the 8 Transactions endpoints, consolidated into 6 tools.

**Files:**
- Create: `src/tools/transactions.ts`
- Test: `src/tools/transactions.test.ts`

**Acceptance Criteria:**
- [ ] `list_transactions` defaults `limit` to 20, trims to `{id_by_customer, to_from, amount, booking_date, purpose}` unless `full: true`
- [ ] `get_transaction` calls `transactionsGetIdByCustomer` with `idSuffix`
- [ ] `create_transactions` calls `transactionsAddBatch` with `{transactions: [...]}`, each entry requiring `account`, `to_from`, `amount`, `booking_date`, limited to at most 50 entries
- [ ] `assign_receipts_to_transactions` calls `transactionsAssignBatchReceipt` with `{transactions_to_receipts: [...]}`, each entry requiring `transaction_id_by_customer` and `receipt_id_by_customer`, limited to at most 50 entries
- [ ] `unassign_receipt` calls `transactionsUnassignReceipt` with `transaction_id_by_customer` and `receipt_id_by_customer`
- [ ] `get_transaction_receipts` calls `transactionsAssignedReceiptsGet` with `transaction_id_by_customer` and optional `confirmed_only`

**Verify:** `npm test -- src/tools/transactions.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/tools/transactions.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createTransactionsTools } from "./transactions.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("transactions tools", () => {
  it("list_transactions trims fields and defaults limit to 20", async () => {
    const client = mockClient({
      success: true,
      rows: 1,
      data: [
        { id_by_customer: "1", to_from: "ACME", amount: "-10.00", booking_date: "2026-01-01", value_date: "2026-01-01", purpose: "Miete" },
      ],
    });
    const [listTransactions] = createTransactionsTools(client);

    const result = await listTransactions.handler({});

    expect(client.call).toHaveBeenCalledWith("transactionsGet", { limit: 20, offset: 0 });
    expect(JSON.parse(result.content[0].text)).toEqual([
      { id_by_customer: "1", to_from: "ACME", amount: "-10.00", booking_date: "2026-01-01", purpose: "Miete" },
    ]);
  });

  it("get_transaction calls transactionsGetIdByCustomer with idSuffix", async () => {
    const client = mockClient({ success: true, data: {} });
    const [, getTransaction] = createTransactionsTools(client);

    await getTransaction.handler({ id_by_customer: 7 });

    expect(client.call).toHaveBeenCalledWith("transactionsGetIdByCustomer", {}, { idSuffix: 7 });
  });

  it("create_transactions calls transactionsAddBatch", async () => {
    const client = mockClient({ success: true });
    const [, , createTransactions] = createTransactionsTools(client);

    await createTransactions.handler({
      transactions: [{ account: 1200, to_from: "ACME", amount: -10, booking_date: "2026-01-01 00:00:00" }],
    });

    expect(client.call).toHaveBeenCalledWith("transactionsAddBatch", {
      transactions: [{ account: 1200, to_from: "ACME", amount: -10, booking_date: "2026-01-01 00:00:00" }],
    });
  });

  it("assign_receipts_to_transactions calls transactionsAssignBatchReceipt", async () => {
    const client = mockClient({ success: true });
    const [, , , assignReceiptsToTransactions] = createTransactionsTools(client);

    await assignReceiptsToTransactions.handler({
      assignments: [{ transaction_id_by_customer: 7, receipt_id_by_customer: 42 }],
    });

    expect(client.call).toHaveBeenCalledWith("transactionsAssignBatchReceipt", {
      transactions_to_receipts: [{ transaction_id_by_customer: 7, receipt_id_by_customer: 42 }],
    });
  });

  it("unassign_receipt calls transactionsUnassignReceipt", async () => {
    const client = mockClient({ success: true });
    const [, , , , unassignReceipt] = createTransactionsTools(client);

    await unassignReceipt.handler({ transaction_id_by_customer: 7, receipt_id_by_customer: 42 });

    expect(client.call).toHaveBeenCalledWith("transactionsUnassignReceipt", {
      transaction_id_by_customer: 7,
      receipt_id_by_customer: 42,
    });
  });

  it("get_transaction_receipts calls transactionsAssignedReceiptsGet", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [, , , , , getTransactionReceipts] = createTransactionsTools(client);

    await getTransactionReceipts.handler({ transaction_id_by_customer: 7 });

    expect(client.call).toHaveBeenCalledWith("transactionsAssignedReceiptsGet", {
      transaction_id_by_customer: 7,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/tools/transactions.test.ts`
Expected: FAIL — `Cannot find module './transactions.js'`

- [ ] **Step 3: Write minimal implementation**

`src/tools/transactions.ts`:

```ts
import { z } from "zod";
import type { BBClient, BBListResult } from "../bb-client/client.js";
import { trimList } from "../formatting/trim.js";
import { defineTool, ok, type ToolDef } from "./types.js";

const SUMMARY_FIELDS = ["id_by_customer", "to_from", "amount", "booking_date", "purpose"] as const;

export function createTransactionsTools(
  client: BBClient
): [ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef] {
  const listShape = {
    id_by_customer_from: z.number().int().optional(),
    id_by_customer_to: z.number().int().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    account: z.number().int().optional(),
    to_from: z.string().optional(),
    limit: z.number().int().max(500).default(20),
    offset: z.number().int().default(0),
    full: z.boolean().default(false),
  };

  const listTransactions = defineTool({
    name: "list_transactions",
    description: "List bank/cash transactions, with optional filters.",
    inputSchema: listShape,
    async handler(args) {
      const { full, limit, offset, ...filters } = args;
      const result = await client.call<BBListResult>("transactionsGet", {
        ...filters,
        limit: limit ?? 20,
        offset: offset ?? 0,
      });
      return ok(trimList(result.data, SUMMARY_FIELDS, full ?? false));
    },
  });

  const getShape = { id_by_customer: z.number().int() };

  const getTransaction = defineTool({
    name: "get_transaction",
    description: "Get a single transaction by its id_by_customer.",
    inputSchema: getShape,
    async handler(args) {
      const result = await client.call("transactionsGetIdByCustomer", {}, { idSuffix: args.id_by_customer });
      return ok(result);
    },
  });

  const transactionEntryShape = z.object({
    account: z.number().int(),
    to_from: z.string(),
    amount: z.number(),
    booking_date: z.string(),
    value_date: z.string().optional(),
    account_number: z.string().optional(),
    bank_code: z.string().optional(),
    bank_name: z.string().optional(),
    purpose: z.string().optional(),
    type: z.string().optional(),
    booking_text: z.string().optional(),
    payment_reference: z.string().optional(),
    currency: z.string().optional(),
  });

  const createShape = {
    transactions: z.array(transactionEntryShape).min(1).max(50),
  };

  const createTransactions = defineTool({
    name: "create_transactions",
    description: "Add one or more transactions to a payment account in a single batch call (up to 50).",
    inputSchema: createShape,
    async handler(args) {
      const result = await client.call("transactionsAddBatch", { transactions: args.transactions });
      return ok(result);
    },
  });

  const assignmentShape = z.object({
    transaction_id_by_customer: z.number().int(),
    receipt_id_by_customer: z.number().int(),
  });

  const assignShape = {
    assignments: z.array(assignmentShape).min(1).max(50),
  };

  const assignReceiptsToTransactions = defineTool({
    name: "assign_receipts_to_transactions",
    description: "Assign one or more receipts to transactions in a single batch call (up to 50).",
    inputSchema: assignShape,
    async handler(args) {
      const result = await client.call("transactionsAssignBatchReceipt", {
        transactions_to_receipts: args.assignments,
      });
      return ok(result);
    },
  });

  const unassignShape = {
    transaction_id_by_customer: z.number().int(),
    receipt_id_by_customer: z.number().int(),
  };

  const unassignReceipt = defineTool({
    name: "unassign_receipt",
    description: "Remove the assignment of a specific receipt from a transaction.",
    inputSchema: unassignShape,
    async handler(args) {
      const result = await client.call("transactionsUnassignReceipt", args);
      return ok(result);
    },
  });

  const assignedShape = {
    transaction_id_by_customer: z.number().int(),
    confirmed_only: z.boolean().optional(),
  };

  const getTransactionReceipts = defineTool({
    name: "get_transaction_receipts",
    description: "Get all receipts assigned to a specific transaction.",
    inputSchema: assignedShape,
    async handler(args) {
      const result = await client.call("transactionsAssignedReceiptsGet", args);
      return ok(result);
    },
  });

  return [
    listTransactions,
    getTransaction,
    createTransactions,
    assignReceiptsToTransactions,
    unassignReceipt,
    getTransactionReceipts,
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/tools/transactions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/transactions.ts src/tools/transactions.test.ts
git commit -m "feat: add transactions MCP tools (list, get, create, assign/unassign receipts)"
```

---

## Task 13: Postings Tools

**Goal:** MCP tools for the 11 Postings endpoints, consolidated into 6 tools, normalizing the API's parallel-array posting-splits into an object array.

**Files:**
- Create: `src/tools/postings.ts`
- Test: `src/tools/postings.test.ts`

**Acceptance Criteria:**
- [ ] `list_postings` requires `date_from`/`date_to`, defaults `limit` to 20 (max 1000 per BB API), calls `postingsGet`
- [ ] `add_receipt_postings` calls `postingsAddBatchReceipts` with `{receipts: [...]}`, each entry requiring `receipt_id_by_customer`, `creditor`, `debtor`, and `splits: [{postingaccount, postingtext, vat, amount, cost_location?, cost_location_two?}]` which is flattened into the API's parallel `postingaccounts`/`postingtexts`/`vats`/`amounts`/`cost_locations`/`cost_locations_two` arrays
- [ ] `add_transaction_postings` calls `postingsAddBatchTransactions` with `{transactions: [...]}`, each entry requiring `transaction_id_by_customer`, `oi_receipts_ids_by_customer`, and `splits` flattened the same way
- [ ] `add_free_postings` calls `postingsAddBatchFree` with `{free_postings: [...]}`, each entry requiring `date`, `postingtext`, `amount`, `postingaccount_debit`, `postingaccount_credit`, `vat`
- [ ] `unconfirm_posting` with `type: "transaction" | "receipt" | "free"` calls the matching `postingsUnconfirmTransaction`/`postingsUnconfirmReceipt`/`postingsUnconfirmFree` with the correct id field name
- [ ] `assign_receipt_to_free_posting` calls `postingsAssignReceiptToFreePosting` with `receipt_id_by_customer` and `posting_id_by_customer`

**Verify:** `npm test -- src/tools/postings.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/tools/postings.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createPostingsTools } from "./postings.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("postings tools", () => {
  it("list_postings calls postingsGet with required date range and default limit", async () => {
    const client = mockClient({ success: true, rows: 0, data: [] });
    const [listPostings] = createPostingsTools(client);

    await listPostings.handler({ date_from: "2026-01-01", date_to: "2026-01-31" });

    expect(client.call).toHaveBeenCalledWith("postingsGet", {
      date_from: "2026-01-01",
      date_to: "2026-01-31",
      limit: 20,
      offset: 0,
    });
  });

  it("add_receipt_postings flattens splits into parallel arrays", async () => {
    const client = mockClient({ success: true });
    const [, addReceiptPostings] = createPostingsTools(client);

    await addReceiptPostings.handler({
      receipts: [
        {
          receipt_id_by_customer: 42,
          creditor: 70001,
          debtor: 10001,
          splits: [
            { postingaccount: 6815, postingtext: "Büromaterial", vat: "19", amount: "100.00", cost_location: "CL1" },
          ],
        },
      ],
    });

    expect(client.call).toHaveBeenCalledWith("postingsAddBatchReceipts", {
      receipts: [
        {
          receipt_id_by_customer: 42,
          creditor: 70001,
          debtor: 10001,
          postingaccounts: [6815],
          postingtexts: ["Büromaterial"],
          vats: ["19"],
          amounts: ["100.00"],
          cost_locations: ["CL1"],
        },
      ],
    });
  });

  it("add_transaction_postings flattens splits into parallel arrays", async () => {
    const client = mockClient({ success: true });
    const [, , addTransactionPostings] = createPostingsTools(client);

    await addTransactionPostings.handler({
      transactions: [
        {
          transaction_id_by_customer: 7,
          oi_receipts_ids_by_customer: [42],
          splits: [{ postingaccount: 6815, postingtext: "Miete", vat: "0", amount: "500.00" }],
        },
      ],
    });

    expect(client.call).toHaveBeenCalledWith("postingsAddBatchTransactions", {
      transactions: [
        {
          transaction_id_by_customer: 7,
          oi_receipts_ids_by_customer: [42],
          postingaccounts: [6815],
          postingtexts: ["Miete"],
          vats: ["0"],
          amounts: ["500.00"],
        },
      ],
    });
  });

  it("add_free_postings calls postingsAddBatchFree", async () => {
    const client = mockClient({ success: true });
    const [, , , addFreePostings] = createPostingsTools(client);

    await addFreePostings.handler({
      free_postings: [
        {
          date: "2026-01-01",
          postingtext: "Privatentnahme",
          amount: "50.00",
          postingaccount_debit: 1800,
          postingaccount_credit: 1000,
          vat: "0",
        },
      ],
    });

    expect(client.call).toHaveBeenCalledWith("postingsAddBatchFree", {
      free_postings: [
        {
          date: "2026-01-01",
          postingtext: "Privatentnahme",
          amount: "50.00",
          postingaccount_debit: 1800,
          postingaccount_credit: 1000,
          vat: "0",
        },
      ],
    });
  });

  it("unconfirm_posting routes by type to the matching endpoint and id field", async () => {
    const client = mockClient({ success: true });
    const [, , , , unconfirmPosting] = createPostingsTools(client);

    await unconfirmPosting.handler({ type: "transaction", id_by_customer: 7 });
    expect(client.call).toHaveBeenCalledWith("postingsUnconfirmTransaction", {
      transaction_id_by_customer: 7,
    });

    await unconfirmPosting.handler({ type: "receipt", id_by_customer: 42 });
    expect(client.call).toHaveBeenCalledWith("postingsUnconfirmReceipt", { receipt_id_by_customer: 42 });

    await unconfirmPosting.handler({ type: "free", id_by_customer: 99 });
    expect(client.call).toHaveBeenCalledWith("postingsUnconfirmFree", { posting_id_by_customer: 99 });
  });

  it("assign_receipt_to_free_posting calls postingsAssignReceiptToFreePosting", async () => {
    const client = mockClient({ success: true });
    const [, , , , , assignReceiptToFreePosting] = createPostingsTools(client);

    await assignReceiptToFreePosting.handler({ receipt_id_by_customer: 42, posting_id_by_customer: 99 });

    expect(client.call).toHaveBeenCalledWith("postingsAssignReceiptToFreePosting", {
      receipt_id_by_customer: 42,
      posting_id_by_customer: 99,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/tools/postings.test.ts`
Expected: FAIL — `Cannot find module './postings.js'`

- [ ] **Step 3: Write minimal implementation**

`src/tools/postings.ts`:

```ts
import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { defineTool, ok, type ToolDef } from "./types.js";

const splitShape = z.object({
  postingaccount: z.number().int(),
  postingtext: z.string(),
  vat: z.string(),
  amount: z.string(),
  cost_location: z.string().optional(),
  cost_location_two: z.string().optional(),
});

type Split = z.infer<typeof splitShape>;

function flattenSplits(splits: Split[]): {
  postingaccounts: number[];
  postingtexts: string[];
  vats: string[];
  amounts: string[];
  cost_locations?: string[];
  cost_locations_two?: string[];
} {
  const costLocations = splits.map((s) => s.cost_location);
  const costLocationsTwo = splits.map((s) => s.cost_location_two);
  return {
    postingaccounts: splits.map((s) => s.postingaccount),
    postingtexts: splits.map((s) => s.postingtext),
    vats: splits.map((s) => s.vat),
    amounts: splits.map((s) => s.amount),
    ...(costLocations.some((c) => c !== undefined) ? { cost_locations: costLocations as string[] } : {}),
    ...(costLocationsTwo.some((c) => c !== undefined) ? { cost_locations_two: costLocationsTwo as string[] } : {}),
  };
}

export function createPostingsTools(
  client: BBClient
): [ToolDef, ToolDef, ToolDef, ToolDef, ToolDef, ToolDef] {
  const listShape = {
    date_from: z.string(),
    date_to: z.string(),
    date_last_action_from: z.string().optional(),
    date_last_action_to: z.string().optional(),
    account: z.string().optional(),
    postingaccount: z.string().optional(),
    posting_status: z.enum(["all", "fixed", "unfixed"]).optional(),
    cost_location: z.string().optional(),
    order: z.string().optional(),
    limit: z.number().int().max(1000).default(20),
    offset: z.number().int().default(0),
  };

  const listPostings = defineTool({
    name: "list_postings",
    description: "List postings (Buchungen) within a required date range, with optional filters.",
    inputSchema: listShape,
    async handler(args) {
      const result = await client.call("postingsGet", {
        ...args,
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
      });
      return ok(result);
    },
  });

  const receiptPostingEntryShape = z.object({
    receipt_id_by_customer: z.number().int(),
    creditor: z.number().int(),
    debtor: z.number().int(),
    splits: z.array(splitShape).min(1),
  });

  const addReceiptPostingsShape = {
    receipts: z.array(receiptPostingEntryShape).min(1),
  };

  const addReceiptPostings = defineTool({
    name: "add_receipt_postings",
    description: "Book one or more receipts onto posting accounts in a single batch call.",
    inputSchema: addReceiptPostingsShape,
    async handler(args) {
      const receipts = args.receipts.map(({ splits, ...rest }) => ({ ...rest, ...flattenSplits(splits) }));
      const result = await client.call("postingsAddBatchReceipts", { receipts });
      return ok(result);
    },
  });

  const transactionPostingEntryShape = z.object({
    transaction_id_by_customer: z.number().int(),
    oi_receipts_ids_by_customer: z.array(z.number().int()),
    splits: z.array(splitShape).min(1),
  });

  const addTransactionPostingsShape = {
    transactions: z.array(transactionPostingEntryShape).min(1),
  };

  const addTransactionPostings = defineTool({
    name: "add_transaction_postings",
    description: "Book one or more transactions onto posting accounts in a single batch call.",
    inputSchema: addTransactionPostingsShape,
    async handler(args) {
      const transactions = args.transactions.map(({ splits, ...rest }) => ({ ...rest, ...flattenSplits(splits) }));
      const result = await client.call("postingsAddBatchTransactions", { transactions });
      return ok(result);
    },
  });

  const freePostingEntryShape = z.object({
    date: z.string(),
    postingtext: z.string(),
    amount: z.string(),
    postingaccount_debit: z.number().int(),
    postingaccount_credit: z.number().int(),
    vat: z.string(),
    cost_location: z.string().optional(),
    cost_location_two: z.string().optional(),
  });

  const addFreePostingsShape = {
    free_postings: z.array(freePostingEntryShape).min(1),
  };

  const addFreePostings = defineTool({
    name: "add_free_postings",
    description: "Add one or more free-form postings (not tied to a receipt or transaction) in a single batch call.",
    inputSchema: addFreePostingsShape,
    async handler(args) {
      const result = await client.call("postingsAddBatchFree", { free_postings: args.free_postings });
      return ok(result);
    },
  });

  const unconfirmShape = {
    type: z.enum(["transaction", "receipt", "free"]),
    id_by_customer: z.number().int(),
  };

  const unconfirmPosting = defineTool({
    name: "unconfirm_posting",
    description: "Unconfirm a fixed posting so it can be edited again. type selects which kind of posting.",
    inputSchema: unconfirmShape,
    async handler(args) {
      if (args.type === "transaction") {
        const result = await client.call("postingsUnconfirmTransaction", {
          transaction_id_by_customer: args.id_by_customer,
        });
        return ok(result);
      }
      if (args.type === "receipt") {
        const result = await client.call("postingsUnconfirmReceipt", {
          receipt_id_by_customer: args.id_by_customer,
        });
        return ok(result);
      }
      const result = await client.call("postingsUnconfirmFree", { posting_id_by_customer: args.id_by_customer });
      return ok(result);
    },
  });

  const assignShape = {
    receipt_id_by_customer: z.number().int(),
    posting_id_by_customer: z.number().int(),
  };

  const assignReceiptToFreePosting = defineTool({
    name: "assign_receipt_to_free_posting",
    description: "Assign a receipt to an existing free posting.",
    inputSchema: assignShape,
    async handler(args) {
      const result = await client.call("postingsAssignReceiptToFreePosting", args);
      return ok(result);
    },
  });

  return [
    listPostings,
    addReceiptPostings,
    addTransactionPostings,
    addFreePostings,
    unconfirmPosting,
    assignReceiptToFreePosting,
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/tools/postings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/postings.ts src/tools/postings.test.ts
git commit -m "feat: add postings MCP tools with split-array normalization"
```

---

## Task 14: Invoices Tools

**Goal:** MCP tools for the 3 Invoices endpoints, consolidated into 2 tools, normalizing the API's parallel item-arrays into an object array.

**Files:**
- Create: `src/tools/invoices.ts`
- Test: `src/tools/invoices.test.ts`

**Acceptance Criteria:**
- [ ] `create_invoice` with `draft: false` (default) calls `invoicesCreate`; with `draft: true` calls `invoicesCreateDraft`; both flatten `items: [{name, amount, unit, vat, single_price, description?}]` into the API's parallel `item_name`/`item_amount`/`item_unit`/`item_vat`/`item_single_price`/`item_description` arrays
- [ ] `create_invoice` requires `type` (`"invoice" | "credit" | "offer"`), `show_prices_type` (`"net" | "gross"`), `company_name`, `date`, and at least one item
- [ ] `create_einvoice` calls `invoicesCreateEInvoice`, requiring the same base fields plus `e_invoice_id`, `street`, `zip`, `city`, `country`, `email`, and items with `tax_type`/`tax_amount` instead of `vat`

**Verify:** `npm test -- src/tools/invoices.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/tools/invoices.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { BBClient } from "../bb-client/client.js";
import { createInvoicesTools } from "./invoices.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("invoices tools", () => {
  it("create_invoice flattens items and calls invoicesCreate by default", async () => {
    const client = mockClient({ success: true, id_by_customer: "1" });
    const [createInvoice] = createInvoicesTools(client);

    await createInvoice.handler({
      type: "invoice",
      show_prices_type: "net",
      company_name: "ACME GmbH",
      date: "2026-01-01",
      items: [{ name: "Beratung", amount: "10", unit: "Std.", vat: "19", single_price: "100.00" }],
    });

    expect(client.call).toHaveBeenCalledWith("invoicesCreate", {
      type: "invoice",
      show_prices_type: "net",
      company_name: "ACME GmbH",
      date: "2026-01-01",
      item_name: ["Beratung"],
      item_amount: ["10"],
      item_unit: ["Std."],
      item_vat: ["19"],
      item_single_price: ["100.00"],
    });
  });

  it("create_invoice routes to invoicesCreateDraft when draft is true", async () => {
    const client = mockClient({ success: true });
    const [createInvoice] = createInvoicesTools(client);

    await createInvoice.handler({
      type: "offer",
      show_prices_type: "gross",
      company_name: "ACME GmbH",
      date: "2026-01-01",
      draft: true,
      items: [{ name: "Beratung", amount: "1", unit: "Std.", vat: "19", single_price: "50.00" }],
    });

    expect(client.call).toHaveBeenCalledWith(
      "invoicesCreateDraft",
      expect.objectContaining({ type: "offer" })
    );
  });

  it("create_einvoice calls invoicesCreateEInvoice with tax fields flattened", async () => {
    const client = mockClient({ success: true });
    const [, createEInvoice] = createInvoicesTools(client);

    await createEInvoice.handler({
      type: "invoice",
      show_prices_type: "net",
      company_name: "ACME GmbH",
      date: "2026-01-01",
      e_invoice_id: "XR-1",
      street: "Hauptstr. 1",
      zip: "10115",
      city: "Berlin",
      country: "Deutschland",
      email: "buchhaltung@acme.example",
      items: [{ name: "Beratung", amount: "1", unit: "Std.", tax_type: "19", tax_amount: "19.00", single_price: "100.00" }],
    });

    expect(client.call).toHaveBeenCalledWith("invoicesCreateEInvoice", {
      type: "invoice",
      show_prices_type: "net",
      company_name: "ACME GmbH",
      date: "2026-01-01",
      e_invoice_id: "XR-1",
      street: "Hauptstr. 1",
      zip: "10115",
      city: "Berlin",
      country: "Deutschland",
      email: "buchhaltung@acme.example",
      item_name: ["Beratung"],
      item_amount: ["1"],
      item_unit: ["Std."],
      item_tax_type: ["19"],
      item_tax_amount: ["19.00"],
      item_single_price: ["100.00"],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/tools/invoices.test.ts`
Expected: FAIL — `Cannot find module './invoices.js'`

- [ ] **Step 3: Write minimal implementation**

`src/tools/invoices.ts`:

```ts
import { z } from "zod";
import type { BBClient } from "../bb-client/client.js";
import { defineTool, ok, type ToolDef } from "./types.js";

const invoiceItemShape = z.object({
  name: z.string(),
  amount: z.string(),
  unit: z.string(),
  vat: z.string(),
  single_price: z.string(),
  description: z.string().optional(),
});

const eInvoiceItemShape = z.object({
  name: z.string(),
  amount: z.string(),
  unit: z.string(),
  tax_type: z.string(),
  tax_amount: z.string(),
  single_price: z.string(),
  description: z.string().optional(),
});

function flattenItems<T extends { name: string; amount: string; unit: string; single_price: string; description?: string }>(
  items: T[],
  extra: Array<{ key: string; get: (item: T) => string }>
): Record<string, string[]> {
  const base: Record<string, string[]> = {
    item_name: items.map((i) => i.name),
    item_amount: items.map((i) => i.amount),
    item_unit: items.map((i) => i.unit),
    item_single_price: items.map((i) => i.single_price),
  };
  for (const { key, get } of extra) {
    base[key] = items.map(get);
  }
  if (items.some((i) => i.description !== undefined)) {
    base.item_description = items.map((i) => i.description ?? "");
  }
  return base;
}

const baseInvoiceFields = {
  type: z.enum(["invoice", "credit", "offer"]),
  show_prices_type: z.enum(["net", "gross"]),
  company_name: z.string(),
  date: z.string(),
  contact_person_name: z.string().optional(),
  street: z.string().optional(),
  additional_addressline: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  email: z.string().optional(),
  invoicenumber: z.string().optional(),
  correspondence: z.string().optional(),
  due_days: z.string().optional(),
  payment_reference: z.string().optional(),
  language: z.enum(["de_DE", "en_US"]).optional(),
};

export function createInvoicesTools(client: BBClient): [ToolDef, ToolDef] {
  const createInvoiceShape = {
    ...baseInvoiceFields,
    draft: z.boolean().default(false),
    items: z.array(invoiceItemShape).min(1),
  };

  const createInvoice = defineTool({
    name: "create_invoice",
    description:
      "Create an invoice, credit note, or offer (type selects which). draft: true saves it as a draft instead of finalizing it.",
    inputSchema: createInvoiceShape,
    async handler(args) {
      const { draft, items, ...fields } = args;
      const payload = { ...fields, ...flattenItems(items, [{ key: "item_vat", get: (i) => i.vat }]) };
      const endpointKey = draft ? "invoicesCreateDraft" : "invoicesCreate";
      const result = await client.call(endpointKey, payload);
      return ok(result);
    },
  });

  const createEInvoiceShape = {
    ...baseInvoiceFields,
    e_invoice_id: z.string(),
    street: z.string(),
    zip: z.string(),
    city: z.string(),
    country: z.string(),
    email: z.string(),
    items: z.array(eInvoiceItemShape).min(1),
  };

  const createEInvoice = defineTool({
    name: "create_einvoice",
    description: "Create a structured e-invoice (e.g. XRechnung/ZUGFeRD) with tax-type/tax-amount line items.",
    inputSchema: createEInvoiceShape,
    async handler(args) {
      const { items, ...fields } = args;
      const payload = {
        ...fields,
        ...flattenItems(items, [
          { key: "item_tax_type", get: (i) => i.tax_type },
          { key: "item_tax_amount", get: (i) => i.tax_amount },
        ]),
      };
      const result = await client.call("invoicesCreateEInvoice", payload);
      return ok(result);
    },
  });

  return [createInvoice, createEInvoice];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/tools/invoices.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/invoices.ts src/tools/invoices.test.ts
git commit -m "feat: add create_invoice and create_einvoice MCP tools with item-array normalization"
```

---

## Task 15: Wire All Tools Into the Server

**Goal:** Register every tool from Tasks 6–14 on the MCP server, validate config at startup, and document setup — verified by an end-to-end smoke test that lists all tools and calls one of them against a mocked client.

**Files:**
- Create: `src/tools/index.ts`
- Create: `README.md`
- Modify: `src/server.ts`
- Modify: `src/index.ts`
- Test: `src/server.test.ts`

**Acceptance Criteria:**
- [ ] `createServer(client)` registers exactly 30 tools (2 accounts + 1 comments + 2 cost-locations + 3 contacts + 2 posting-accounts + 6 receipts + 6 transactions + 6 postings + 2 invoices)
- [ ] Calling the registered `list_accounts` tool through the server's tool registry (not by importing `accounts.ts` directly) returns the mocked client's data
- [ ] `src/index.ts` calls `loadConfig(process.env)`, exits with a non-zero code and the config error's message on `stderr` if it throws, and otherwise creates the real `BBClient` and connects the stdio transport
- [ ] `README.md` documents required env vars, `npm run generate`, `npm test`, `npm run build`, `npm start`, and lists all 30 tools grouped by category

**Verify:** `npm test` → all tests across the whole project pass; `npm run build` → exits 0

**Steps:**

- [ ] **Step 1: Write the failing test**

`src/tools/index.ts`:

```ts
import type { BBClient } from "../bb-client/client.js";
import { createAccountsTools } from "./accounts.js";
import { createCommentsTools } from "./comments.js";
import { createContactsTools } from "./contacts.js";
import { createCostLocationsTools } from "./cost-locations.js";
import { createInvoicesTools } from "./invoices.js";
import { createPostingAccountsTools } from "./posting-accounts.js";
import { createPostingsTools } from "./postings.js";
import { createReceiptsTools } from "./receipts.js";
import { createTransactionsTools } from "./transactions.js";
import type { ToolDef } from "./types.js";

export function createAllTools(client: BBClient): ToolDef[] {
  return [
    ...createAccountsTools(client),
    ...createCommentsTools(client),
    ...createCostLocationsTools(client),
    ...createContactsTools(client),
    ...createPostingAccountsTools(client),
    ...createReceiptsTools(client),
    ...createTransactionsTools(client),
    ...createPostingsTools(client),
    ...createInvoicesTools(client),
  ];
}
```

Extend `src/server.test.ts` (replace the whole file):

```ts
import { describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";
import type { BBClient } from "./bb-client/client.js";

function mockClient(result: unknown): BBClient {
  return { call: vi.fn().mockResolvedValue(result) };
}

describe("createServer", () => {
  it("registers exactly 30 tools", () => {
    const server = createServer(mockClient({}));
    const registeredTools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registeredTools)).toHaveLength(30);
  });

  it("wires list_accounts through to the given client", async () => {
    const client = mockClient({ success: true, rows: 1, data: [{ name: "Kasse", postingaccount_number: "1000" }] });
    const server = createServer(client);
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<string, { callback: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
      }
    )._registeredTools;

    const result = await registeredTools.list_accounts.callback({});

    expect(client.call).toHaveBeenCalledWith("accountsGet", {});
    expect(JSON.parse(result.content[0].text)).toEqual([{ name: "Kasse", postingaccount_number: "1000" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `createServer` still takes no arguments and registers zero tools

- [ ] **Step 3: Write minimal implementation**

`src/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BBClient } from "./bb-client/client.js";
import { createAllTools } from "./tools/index.js";

export function createServer(client: BBClient): McpServer {
  const server = new McpServer({
    name: "buchhaltungsbutler",
    version: "0.1.0",
  });

  for (const tool of createAllTools(client)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      tool.handler
    );
  }

  return server;
}
```

`src/index.ts`:

```ts
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
```

`README.md`:

```markdown
# mcp-buchhaltungsbutler

MCP server exposing the BuchhaltungsButler API (v1) as curated, token-efficient tools for LLM agents.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `BB_API_CLIENT`, `BB_API_SECRET`, `BB_API_KEY` (see BuchhaltungsButler's account settings for API access).
3. `npm run generate` (regenerates `src/bb-client/generated/endpoints.ts` from `spec/buchhaltungsbutler-v1.json`; only needed after updating the vendored spec).
4. `npm test`
5. `npm run build && npm start` — or `npm run dev` for a quick local run without building.

## Tools

**Accounts:** `list_accounts`, `create_account`
**Comments:** `add_comment`
**Cost Locations:** `list_cost_locations`, `manage_cost_location`
**Contacts (Debtors/Creditors):** `list_contacts`, `create_contacts`, `update_contact`
**Posting Accounts:** `list_posting_accounts`, `manage_posting_account`
**Receipts:** `list_receipts`, `get_receipt`, `create_receipts`, `upload_receipt`, `set_receipt_deleted`, `get_receipt_transactions`
**Transactions:** `list_transactions`, `get_transaction`, `create_transactions`, `assign_receipts_to_transactions`, `unassign_receipt`, `get_transaction_receipts`
**Postings:** `list_postings`, `add_receipt_postings`, `add_transaction_postings`, `add_free_postings`, `unconfirm_posting`, `assign_receipt_to_free_posting`
**Invoices:** `create_invoice`, `create_einvoice`

## Design

See `docs/superpowers/specs/2026-08-18-buchhaltungsbutler-mcp-design.md`.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests across the project)

Run: `npm run build`
Expected: exits 0

- [ ] **Step 5: Commit**

```bash
git add src/tools/index.ts src/server.ts src/index.ts src/server.test.ts README.md
git commit -m "feat: wire all 30 tools into the MCP server and add README"
```

---

## Self-Review Notes

- **Spec coverage:** every design-doc requirement is covered — Task 1 (stdio bootstrap), Task 2 (single-tenant env config, fail-fast), Task 3 (spec-driven codegen), Task 4 (client with auth/rate-limit/error mapping), Task 5 (output trimming), Tasks 6–14 (all 48 endpoints via curated tools, batch-native, parallel-array normalization for postings/invoices), Task 15 (wiring + README). Testing strategy (mocked HTTP, no live credentials) applies to every task.
- **Tool count vs. design doc's "~20–25" estimate:** the actual curated count came out to 30 tools (from 48 endpoints) once every endpoint was mapped concretely — still a ~37% reduction and fully batch-native/consolidated per the stated principles, just a higher number than the design doc's rough estimate. Noted here rather than silently forcing further merges that would have hurt tool clarity (e.g. merging semantically distinct list/create/update actions).
- **Type consistency check:** `ToolDef`/`ok()` (Task 6) is reused unchanged by every subsequent tool task. `BBListResult`/`BBActionResult`/`CallOptions` (Task 4) are the only types tool files import from the client. `EndpointKey` values used across tool files (e.g. `"receiptsGetIdByCustomer"`, `"transactionsAssignBatchReceipt"`, `"postingsUnconfirmFree"`) all match the deterministic `pathToKey` algorithm verified in Task 3 against the real vendored spec.
