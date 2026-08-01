import { UpstreamError } from "./errors.js";

export type FetchImplementation = typeof fetch;

export interface FetchJsonOptions {
  source: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: unknown;
  fetchImpl?: FetchImplementation;
}

export async function fetchJson<T>(url: URL, options: FetchJsonOptions): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        "user-agent": "clinical-evidence-mcp/0.1 (+https://github.com/danielk-am/clinical-evidence-mcp)",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "was unavailable";
    throw new UpstreamError(options.source, null, `${options.source} ${reason}.`);
  }

  if (!response.ok) {
    throw new UpstreamError(
      options.source,
      response.status,
      `${options.source} returned HTTP ${response.status}.`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new UpstreamError(options.source, response.status, `${options.source} returned invalid JSON.`);
  }
}

export function retrievedAt(): string {
  return new Date().toISOString();
}
