import type { AppConfig, SyndicatedSourceConfig } from "../config.js";
import { InputError } from "../errors.js";
import { assertDeidentified } from "../privacy.js";
import { fetchJson, retrievedAt, type FetchImplementation } from "../upstream.js";

export interface SyndicatedResult {
  provider: string;
  result: Record<string, unknown>;
  retrievedAt: string;
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

function validateArticleId(value: string): string {
  const articleId = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(articleId)) {
    throw new InputError("Article identifier must be a UUID.");
  }
  return articleId;
}
