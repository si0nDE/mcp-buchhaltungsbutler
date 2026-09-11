import type { Config } from "../config.js";
import { ENDPOINTS, type EndpointDef, type EndpointKey } from "./generated/endpoints.js";
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

// Typed explicitly as EndpointDef (rather than inferred from the `as const
// satisfies` literal union in generated/endpoints.ts) so that accessing the
// optional `bodyFormat` field below type-checks for every endpoint, not just
// the ones whose literal type happens to include it.
const endpointByKey = new Map<string, EndpointDef>(ENDPOINTS.map((e) => [e.key, e]));

// Only used for bodyFormat: "form" — no endpoint currently selects it, but
// it's kept live (not dead code) for the one BuchhaltungsButler endpoint
// that might one day prove to need PHP-style $_POST bracket notation for
// nested arrays/objects instead of JSON.
function encodeFormValue(key: string, value: unknown, parts: string[]): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      if (item !== null && typeof item === "object") {
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
          encodeFormValue(`${key}[${i}][${k}]`, v, parts);
        }
      } else {
        encodeFormValue(`${key}[${i}]`, item, parts);
      }
    });
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      encodeFormValue(`${key}[${k}]`, v, parts);
    }
    return;
  }
  parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
}

function encodeFormBody(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    encodeFormValue(key, value, parts);
  }
  return parts.join("&");
}

// receiptsUpload is the only endpoint expected to need multipart (it
// transmits a file). Its params are flat (file, type, file_name, ...), so a
// one-level FormData append is sufficient — this isn't a general nested-array
// multipart encoder.
function buildMultipartBody(payload: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return form;
}

function buildRequestBody(
  bodyFormat: "json" | "form" | "multipart",
  payload: Record<string, unknown>
): { body: BodyInit; headers?: Record<string, string> } {
  if (bodyFormat === "multipart") {
    // No explicit Content-Type here — fetch sets it (with the boundary) from
    // the FormData instance itself; setting it manually would drop the
    // boundary parameter and break parsing on the receiving end.
    return { body: buildMultipartBody(payload) };
  }
  if (bodyFormat === "form") {
    return { body: encodeFormBody(payload), headers: { "Content-Type": "application/x-www-form-urlencoded" } };
  }
  return { body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } };
}

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
      const { body, headers } = buildRequestBody(endpoint.bodyFormat ?? "json", { ...params, api_key: config.apiKey });

      const response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, ...headers },
        body,
      });

      const responseText = await response.text();
      let responseBody: unknown;
      try {
        responseBody = responseText ? JSON.parse(responseText) : undefined;
      } catch {
        responseBody = responseText;
      }

      if (response.status === 429) {
        throw new BuchhaltungsButlerRateLimitError(endpoint.path, responseBody);
      }

      if (!response.ok) {
        const bbMessage =
          responseBody !== null &&
          typeof responseBody === "object" &&
          "message" in responseBody &&
          typeof (responseBody as { message: unknown }).message === "string"
            ? (responseBody as { message: string }).message
            : undefined;
        throw new BuchhaltungsButlerApiError(
          `BuchhaltungsButler API error on ${endpointKey}: HTTP ${response.status}${bbMessage ? ` — ${bbMessage}` : ""}`,
          response.status,
          endpoint.path,
          responseBody
        );
      }

      return responseBody as T;
    },
  };
}
