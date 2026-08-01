import type { AppConfig, SyndicatedSourceConfig } from "../config.js";
import { InputError } from "../errors.js";
import { assertDeidentified } from "../privacy.js";
import { fetchJson, retrievedAt, type FetchImplementation } from "../upstream.js";

export interface SyndicatedResult {
  provider: string;
  result: Record<string, unknown>;
  retrievedAt: string;
}

export interface SyndicatedLoginSession {
  sessionId: string;
  expiresAt: string;
}

export function syndicatedSourceForAccount(
  config: AppConfig,
  accountId: string,
): SyndicatedSourceConfig | null {
  const source = config.syndicatedSource;
  return source?.allowedAccountIds.has(accountId) ? source : null;
}

export async function getSyndicatedStatus(
  source: SyndicatedSourceConfig,
  fetchImpl?: FetchImplementation,
): Promise<SyndicatedResult> {
  return callSyndicated(source, "/v1/auth-status", undefined, fetchImpl);
}

export async function startSyndicatedLogin(
  source: SyndicatedSourceConfig,
  fetchImpl?: FetchImplementation,
): Promise<SyndicatedLoginSession> {
  const response = await callSyndicated(source, "/v1/login/start", {}, fetchImpl);
  const sessionId = validateArticleId(response.result.session_id);
  const expiresAt = requiredIsoDate(response.result.expires_at, "expires_at");
  return { sessionId, expiresAt };
}

export async function finishSyndicatedLogin(
  source: SyndicatedSourceConfig,
  sessionId?: string,
  fetchImpl?: FetchImplementation,
): Promise<SyndicatedResult> {
  return callSyndicated(
    source,
    "/v1/login/finish",
    sessionId ? { session_id: validateArticleId(sessionId) } : {},
    fetchImpl,
  );
}

export async function askSyndicatedSource(
  source: SyndicatedSourceConfig,
  input: { question: string; originalArticleId?: string | undefined },
  fetchImpl?: FetchImplementation,
): Promise<SyndicatedResult> {
  const question = assertDeidentified(input.question);
  return callSyndicated(
    source,
    "/v1/ask",
    {
      question,
      ...(input.originalArticleId ? { original_article_id: input.originalArticleId } : {}),
      wait_for_completion: false,
    },
    fetchImpl,
  );
}

export async function getSyndicatedArticle(
  source: SyndicatedSourceConfig,
  articleId: string,
  fetchImpl?: FetchImplementation,
): Promise<SyndicatedResult> {
  return callSyndicated(
    source,
    `/v1/article/${encodeURIComponent(validateArticleId(articleId))}`,
    undefined,
    fetchImpl,
  );
}

export async function waitForSyndicatedArticle(
  source: SyndicatedSourceConfig,
  input: { articleId: string; timeoutSeconds: number },
  fetchImpl?: FetchImplementation,
): Promise<SyndicatedResult> {
  const articleId = validateArticleId(input.articleId);
  return callSyndicated(
    source,
    `/v1/article/${encodeURIComponent(articleId)}/wait`,
    { timeout_sec: input.timeoutSeconds },
    fetchImpl,
  );
}

async function callSyndicated(
  source: SyndicatedSourceConfig,
  path: string,
  body: unknown,
  fetchImpl?: FetchImplementation,
): Promise<SyndicatedResult> {
  const result = await fetchJson<Record<string, unknown>>(
    new URL(path, `${source.baseUrl}/`),
    {
      source: source.name,
      timeoutMs: source.timeoutMs,
      headers: { authorization: `Bearer ${source.token}` },
      ...(body === undefined ? {} : { method: "POST" as const, body }),
      ...(fetchImpl ? { fetchImpl } : {}),
    },
  );
  return { provider: source.name, result, retrievedAt: retrievedAt() };
}

function validateArticleId(value: unknown): string {
  const articleId = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(articleId)) {
    throw new InputError("Article identifier must be a UUID.");
  }
  return articleId;
}

function requiredIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new InputError(`Private source returned an invalid ${field}.`);
  }
  return new Date(value).toISOString();
}
