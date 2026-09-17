import { UpstreamError } from "../errors.js";
import {
  fetchJson,
  type FetchImplementation,
  type FetchJsonOptions,
} from "../upstream.js";

const WINDOW_MS = 10_000;
const UNKEYED_REQUESTS_PER_WINDOW = 4;
const KEYED_REQUESTS_PER_WINDOW = 8;

class SlidingWindowLimiter {
  private requestStarts: number[] = [];

  reserve(requestsPerWindow: number, now: number): number {
    this.requestStarts = this.requestStarts.filter((startedAt) => now - startedAt < WINDOW_MS);
    if (this.requestStarts.length >= requestsPerWindow) {
      const oldestRequest = this.requestStarts[0] ?? now;
      return Math.max(1, oldestRequest + WINDOW_MS - now);
    }
    this.requestStarts.push(now);
    return 0;
  }
}

const rateLimiters = new WeakMap<FetchImplementation, SlidingWindowLimiter>();

export async function fetchDataGovSgJson<T>(
  url: URL,
  options: FetchJsonOptions,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestsPerWindow = options.headers?.["x-api-key"]
    ? KEYED_REQUESTS_PER_WINDOW
    : UNKEYED_REQUESTS_PER_WINDOW;
  let limiter = rateLimiters.get(fetchImpl);
  if (!limiter) {
    limiter = new SlidingWindowLimiter();
    rateLimiters.set(fetchImpl, limiter);
  }
  const retryAfterMs = limiter.reserve(requestsPerWindow, Date.now());
  if (retryAfterMs > 0) {
    throw new UpstreamError(
      options.source,
      429,
      `${options.source} reached local data.gov.sg request capacity. Retry in ${Math.ceil(retryAfterMs / 1_000)} seconds.`,
    );
  }
  return fetchJson<T>(url, { ...options, fetchImpl });
}
