import { resolve } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  publicUrl: string;
  mcpUrl: string;
  allowedOrigins: ReadonlySet<string>;
  requestsPerMinute: number;
  upstreamTimeoutMs: number;
  ncbiEmail?: string;
  ncbiApiKey?: string;
  syndicatedSource?: SyndicatedSourceConfig;
}

export interface SyndicatedSourceConfig {
  name: string;
  baseUrl: string;
  token: string;
  allowedAccountIds: ReadonlySet<string>;
  timeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const publicUrl = normalizePublicUrl(
    env.MCP_PUBLIC_URL ?? `http://127.0.0.1:${positiveInteger(env.PORT, 3946)}`,
  );
  const ncbiEmail = cleanOptional(env.NCBI_EMAIL);
  const ncbiApiKey = cleanOptional(env.NCBI_API_KEY);
  const syndicatedSource = loadSyndicatedSourceConfig(env);

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: positiveInteger(env.PORT, 3946),
    dataDir: resolve(env.DATA_DIR?.trim() || "./data"),
    publicUrl,
    mcpUrl: `${publicUrl}/mcp`,
    allowedOrigins: new Set(
      (env.MCP_ALLOWED_ORIGINS ?? "https://claude.ai")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    requestsPerMinute: positiveInteger(env.REQUESTS_PER_MINUTE, 60),
    upstreamTimeoutMs: positiveInteger(env.UPSTREAM_TIMEOUT_MS, 20_000),
    ...(ncbiEmail ? { ncbiEmail } : {}),
    ...(ncbiApiKey ? { ncbiApiKey } : {}),
    ...(syndicatedSource ? { syndicatedSource } : {}),
  };
}

function loadSyndicatedSourceConfig(
  env: NodeJS.ProcessEnv,
): SyndicatedSourceConfig | undefined {
  const baseUrlValue = cleanOptional(env.SYNDICATED_SOURCE_URL);
  const token = cleanOptional(env.SYNDICATED_SOURCE_TOKEN);
  const accountIds = new Set(
    (env.SYNDICATED_SOURCE_ALLOWED_ACCOUNT_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  if (!baseUrlValue && !token && accountIds.size === 0) {
    return undefined;
  }
  if (!baseUrlValue || !token || accountIds.size === 0) {
    throw new Error(
      "SYNDICATED_SOURCE_URL, SYNDICATED_SOURCE_TOKEN, and SYNDICATED_SOURCE_ALLOWED_ACCOUNT_IDS must be configured together.",
    );
  }
  if (token.length < 32) {
    throw new Error("SYNDICATED_SOURCE_TOKEN must contain at least 32 characters.");
  }

  const url = new URL(baseUrlValue);
  if (url.protocol !== "https:" && !isPrivateServiceHost(url.hostname)) {
    throw new Error("SYNDICATED_SOURCE_URL must use HTTPS outside a private service hostname.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";

  return {
    name: cleanOptional(env.SYNDICATED_SOURCE_NAME) ?? "Private syndicated source",
    baseUrl: url.toString().replace(/\/$/, ""),
    token,
    allowedAccountIds: accountIds,
    timeoutMs: positiveInteger(env.SYNDICATED_SOURCE_TIMEOUT_MS, 200_000),
  };
}

function normalizePublicUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw new Error("MCP_PUBLIC_URL must use HTTPS outside localhost.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isPrivateServiceHost(hostname: string): boolean {
  return isLoopback(hostname) || (!hostname.includes(".") && !hostname.includes(":"));
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}
