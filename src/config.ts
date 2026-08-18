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
