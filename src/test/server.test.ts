import assert from "node:assert/strict";
import { createServer } from "node:http";
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

function postInitialize(baseUrl: string, token?: string, origin?: string): Promise<Response> {
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
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }),
  });
}
