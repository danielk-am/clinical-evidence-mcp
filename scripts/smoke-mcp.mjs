import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApplication } from "../dist/server.js";
import { TokenRegistry } from "../dist/token-registry.js";

const dataDir = await mkdtemp(join(tmpdir(), "clinical-evidence-smoke-"));
const registry = new TokenRegistry(dataDir);
const issued = await registry.createToken("smoke@example.test", "smoke");
const config = {
  host: "127.0.0.1",
  port: 3946,
  dataDir,
  publicUrl: "http://127.0.0.1:3946",
  mcpUrl: "http://127.0.0.1:3946/mcp",
  allowedOrigins: new Set(["https://claude.ai"]),
  requestsPerMinute: 100,
  upstreamTimeoutMs: 1_000,
};

const app = await createApplication(config, { registry });
const httpServer = createServer(app);
await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const address = httpServer.address();
if (!address || typeof address === "string") throw new Error("Could not resolve smoke server port.");

const transport = new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${address.port}/mcp`),
  { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } },
);
const client = new Client({ name: "clinical-evidence-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const expected = [
    "clinical_trial_get",
    "clinical_trials_search",
    "drug_adverse_event_summary",
    "drug_label_search",
    "literature_article_get",
    "literature_search",
  ];
  const names = tools.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected tool catalogue: ${names.join(", ")}`);
  }
  const resource = await client.readResource({ uri: "clinical-evidence://sources" });
  if (resource.contents.length !== 1) throw new Error("Source catalogue was not returned.");
  process.stdout.write(`${JSON.stringify({ ok: true, tools: names.length })}\n`);
} finally {
  await client.close().catch(() => undefined);
  await new Promise((resolve) => httpServer.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
