#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApplication } from "../dist/server.js";
import { TokenRegistry } from "../dist/token-registry.js";

const dataDir = await mkdtemp(join(tmpdir(), "clinical-evidence-smoke-"));
const config = {
  host: "127.0.0.1",
  port: 3946,
  dataDir,
  publicUrl: "http://127.0.0.1:3946",
  mcpUrl: "http://127.0.0.1:3946/mcp",
  allowedOrigins: new Set(["https://claude.ai"]),
  requestsPerMinute: 100,
  upstreamTimeoutMs: 2_000,
};
const registry = new TokenRegistry(dataDir);
const credential = await registry.createToken("smoke@example.com", "smoke");
const app = await createApplication(config, { registry });
const httpServer = createServer(app);
await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

try {
  const address = httpServer.address();
  assert(address && typeof address === "object");
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${credential.token}` } } },
  );
  const client = new Client({ name: "clinical-evidence-smoke", version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      "clinical_trial_get",
      "clinical_trials_search",
      "drug_adverse_event_summary",
      "drug_label_search",
      "literature_article_get",
      "literature_search",
    ],
  );
  const resource = await client.readResource({ uri: "clinical-evidence://sources" });
  assert.equal(resource.contents.length, 1);
  await client.close();
  process.stdout.write("MCP smoke test passed with six tools and one source resource.\n");
} finally {
  await new Promise((resolve) => httpServer.close(resolve));
}
