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

// BuchhaltungsButler's backend reads the request body as classic PHP $_POST,
// not JSON, despite the Swagger spec modeling every field as "in: body" —
// confirmed by the spec's own error code 23 ("no post and files content
// received or declined"), which is the exact symptom of an empty $_POST
// caused by a non-form-encoded body.
function encodeFormBody(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    encodeFormValue(key, value, parts);
  }
  return parts.join("&");
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

      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: encodeFormBody({ ...params, api_key: config.apiKey }),
      });

      const responseText = await response.text();
      let body: unknown;
      try {
        body = responseText ? JSON.parse(responseText) : undefined;
      } catch {
        body = responseText;
      }

      if (response.status === 429) {
        throw new BuchhaltungsButlerRateLimitError(endpoint.path, body);
      }

      if (!response.ok) {
        const bbMessage =
          body !== null && typeof body === "object" && "message" in body && typeof (body as { message: unknown }).message === "string"
            ? (body as { message: string }).message
            : undefined;
        throw new BuchhaltungsButlerApiError(
          `BuchhaltungsButler API error on ${endpointKey}: HTTP ${response.status}${bbMessage ? ` — ${bbMessage}` : ""}`,
          response.status,
          endpoint.path,
          body
        );
      }

      return body as T;
    },
  };
}
