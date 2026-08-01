import assert from "node:assert/strict";
import test from "node:test";
import type { SyndicatedSourceConfig } from "../config.js";
import { InputError } from "../errors.js";
import {
  askSyndicatedSource,
  finishSyndicatedLogin,
  getSyndicatedArticle,
  startSyndicatedLogin,
} from "../providers/syndicated.js";

const source: SyndicatedSourceConfig = {
  name: "Private evidence source",
  baseUrl: "http://private-source:4010",
  token: "s".repeat(32),
  allowedAccountIds: new Set(["acct_test"]),
  timeoutMs: 1_000,
};

test("sends a deidentified non-blocking research request with bridge authentication", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ article_id: "00000000-0000-4000-8000-000000000001" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const response = await askSyndicatedSource(
    source,
    { question: "What evidence compares intervention A with intervention B?" },
    fetchImpl,
  );

  assert.equal(capturedUrl, "http://private-source:4010/v1/ask");
  assert.equal(new Headers(capturedInit?.headers).get("authorization"), `Bearer ${source.token}`);
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    question: "What evidence compares intervention A with intervention B?",
    wait_for_completion: false,
  });
  assert.equal(response.provider, source.name);
});

test("rejects patient identifiers and malformed article identifiers before bridge calls", async () => {
  await assert.rejects(
    askSyndicatedSource(source, { question: "Patient email is jane@example.com" }),
    InputError,
  );
  await assert.rejects(getSyndicatedArticle(source, "not-an-id"), InputError);
});

test("starts and finishes a privacy-reduced login session through bridge authentication", async () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    const isStart = String(input).endsWith("/v1/login/start");
    return new Response(JSON.stringify(
      isStart
        ? { session_id: sessionId, expires_at: expiresAt, private: "discard" }
        : { authenticated: true },
    ), { status: 200, headers: { "content-type": "application/json" } });
  };

  const started = await startSyndicatedLogin(source, fetchImpl);
  assert.deepEqual(started, { sessionId, expiresAt });
  await finishSyndicatedLogin(source, sessionId, fetchImpl);
  assert.equal(calls[0]?.url, "http://private-source:4010/v1/login/start");
  assert.equal(calls[1]?.url, "http://private-source:4010/v1/login/finish");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {});
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { session_id: sessionId });
  assert.equal(
    new Headers(calls[0]?.init?.headers).get("authorization"),
    `Bearer ${source.token}`,
  );
});

test("rejects malformed private login session metadata", async () => {
  const fetchImpl: typeof fetch = async () => new Response(
    JSON.stringify({ session_id: "not-a-uuid", expires_at: "never" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  await assert.rejects(startSyndicatedLogin(source, fetchImpl), InputError);
});
