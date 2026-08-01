import assert from "node:assert/strict";
import test from "node:test";
import type { SyndicatedSourceConfig } from "../config.js";
import { InputError } from "../errors.js";
import {
  askSyndicatedSource,
  getSyndicatedArticle,
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
