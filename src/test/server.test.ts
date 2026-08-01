import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppConfig } from "../config.js";
import { createApplication } from "../server.js";
import { TokenRegistry } from "../token-registry.js";

test("protects MCP while serving a public health check", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "clinical-evidence-server-test-"));
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 3946,
    dataDir,
    publicUrl: "http://127.0.0.1:3946",
    mcpUrl: "http://127.0.0.1:3946/mcp",
    allowedOrigins: new Set(["https://claude.ai"]),
    requestsPerMinute: 100,
    upstreamTimeoutMs: 1_000,
  };
  const registry = new TokenRegistry(dataDir);
  const created = await registry.createToken("clinician@example.com", "test");
  const app = await createApplication(config, { registry });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { status: string }).status, "ok");

  const unauthorised = await postInitialize(baseUrl);
  assert.equal(unauthorised.status, 401);
  assert.match(unauthorised.headers.get("www-authenticate") ?? "", /^Bearer /);

  const wrongOrigin = await postInitialize(baseUrl, created.token, "https://evil.example");
  assert.equal(wrongOrigin.status, 403);

  const authorised = await postInitialize(baseUrl, created.token, "https://claude.ai");
  assert.equal(authorised.status, 200);
  const payload = await authorised.json() as { result?: { serverInfo?: { name?: string } } };
  assert.equal(payload.result?.serverInfo?.name, "clinical-evidence-mcp");

  const nullOrigin = await postInitialize(baseUrl, created.token, "null");
  assert.equal(nullOrigin.status, 403);

  const unsupported = await fetch(`${baseUrl}/mcp`, {
    headers: { authorization: `Bearer ${created.token}` },
  });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get("allow"), "POST");
});

test("gates login tools by account and returns stateless URL elicitation", async (context) => {
  const bridgeCalls: string[] = [];
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const bridge = createServer((request, response) => {
    bridgeCalls.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/login/start") {
      response.end(JSON.stringify({
        session_id: sessionId,
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      }));
      return;
    }
    if (request.url === "/v1/login/finish") {
      response.end(JSON.stringify({ authenticated: false, statusCode: 401 }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await listen(bridge);
  context.after(() => close(bridge));
  const bridgePort = (bridge.address() as AddressInfo).port;

  const dataDir = await mkdtemp(join(tmpdir(), "clinical-evidence-login-test-"));
  const registry = new TokenRegistry(dataDir);
  const allowed = await registry.createToken("allowed@example.com", "allowed");
  const denied = await registry.createToken("denied@example.com", "denied");
  const bridgeToken = "b".repeat(32);
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 3946,
    dataDir,
    publicUrl: "https://clinical.example.test",
    mcpUrl: "https://clinical.example.test/mcp",
    allowedOrigins: new Set(["https://claude.ai"]),
    requestsPerMinute: 100,
    upstreamTimeoutMs: 1_000,
    syndicatedSource: {
      name: "Private evidence source",
      baseUrl: `http://127.0.0.1:${bridgePort}`,
      token: bridgeToken,
      allowedAccountIds: new Set([allowed.accountId]),
      timeoutMs: 2_000,
      loginProxyUrl: `http://127.0.0.1:${bridgePort}`,
    },
  };
  const app = await createApplication(config, { registry });
  const server = createServer(app);
  await listen(server);
  context.after(() => close(server));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const allowedTools = await postMcp(baseUrl, allowed.token, 1, "tools/list");
  const allowedPayload = await allowedTools.json() as {
    result?: { tools?: Array<{ name: string }> };
  };
  const allowedNames = allowedPayload.result?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(allowedNames.includes("syndicated_source_login_start"));
  assert.ok(allowedNames.includes("syndicated_source_login_finish"));

  const deniedTools = await postMcp(baseUrl, denied.token, 2, "tools/list");
  const deniedPayload = await deniedTools.json() as {
    result?: { tools?: Array<{ name: string }> };
  };
  const deniedNames = deniedPayload.result?.tools?.map((tool) => tool.name) ?? [];
  assert.equal(deniedNames.includes("syndicated_source_login_start"), false);

  const initialised = await postInitialize(baseUrl, allowed.token, undefined, {
    elicitation: { url: {} },
  });
  assert.equal(initialised.status, 200);
  assert.equal(initialised.headers.get("mcp-session-id"), null);

  const called = await postMcp(
    baseUrl,
    allowed.token,
    3,
    "tools/call",
    { name: "syndicated_source_login_start", arguments: { delivery: "auto" } },
  );
  assert.equal(called.status, 200);
  assert.equal(called.headers.get("mcp-session-id"), null);
  const callPayload = await called.json() as {
    error?: { code?: number; data?: { elicitations?: Array<Record<string, unknown>> } };
  };
  assert.equal(callPayload.error?.code, -32042);
  const elicitation = callPayload.error?.data?.elicitations?.[0];
  assert.equal(elicitation?.mode, "url");
  assert.equal(typeof elicitation?.elicitationId, "string");
  const loginUrl = new URL(String(elicitation?.url));
  assert.equal(loginUrl.origin, "https://clinical.example.test");
  assert.equal(loginUrl.pathname, "/oe-login/");
  assert.ok(loginUrl.hash.length > 40);
  assert.equal(bridgeCalls.some((value) => value.includes(`Bearer ${bridgeToken}`)), true);

  const link = await postMcp(
    baseUrl,
    allowed.token,
    4,
    "tools/call",
    { name: "syndicated_source_login_start", arguments: { delivery: "link" } },
  );
  const linkPayload = await link.json() as {
    result?: { structuredContent?: { login_url?: string } };
  };
  assert.match(linkPayload.result?.structuredContent?.login_url ?? "", /^https:\/\/clinical\.example\.test\/oe-login\/#/);
});

function postInitialize(
  baseUrl: string,
  token?: string,
  origin?: string,
  capabilities: Record<string, unknown> = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities,
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }),
  });
}

function postMcp(
  baseUrl: string,
  token: string,
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    }),
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
