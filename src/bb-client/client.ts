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
