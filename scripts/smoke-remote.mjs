#!/usr/bin/env node
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.CLINICAL_EVIDENCE_URL;
const token = process.env.CLINICAL_EVIDENCE_TOKEN;
if (!endpoint || !token) {
  throw new Error("Set CLINICAL_EVIDENCE_URL and CLINICAL_EVIDENCE_TOKEN.");
}

const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "clinical-evidence-remote-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length >= 6, true);
  const result = await client.callTool({
    name: "clinical_trials_search",
    arguments: { condition: "hypertension", limit: 1 },
  });
  assert.equal(result.isError, undefined);
  assert.equal(typeof result.structuredContent, "object");
  process.stdout.write(
    `Remote MCP smoke test passed with ${tools.tools.length} tools and a live ClinicalTrials.gov result.\n`,
  );
} finally {
  await client.close();
}
