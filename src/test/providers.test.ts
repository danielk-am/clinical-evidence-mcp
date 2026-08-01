import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../config.js";
import { searchClinicalTrials } from "../providers/clinical-trials.js";
import { searchDrugLabels } from "../providers/openfda.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 3946,
  dataDir: "/tmp/unused",
  publicUrl: "http://127.0.0.1:3946",
  mcpUrl: "http://127.0.0.1:3946/mcp",
  allowedOrigins: new Set(["https://claude.ai"]),
  requestsPerMinute: 60,
  upstreamTimeoutMs: 1_000,
};

test("maps ClinicalTrials.gov records with source metadata", async () => {
  const fetchImpl = mockFetch({
    totalCount: 1,
    studies: [
      {
        hasResults: true,
        protocolSection: {
          identificationModule: { nctId: "NCT12345678", briefTitle: "Example trial" },
          statusModule: { overallStatus: "COMPLETED" },
          designModule: { studyType: "INTERVENTIONAL", phases: ["PHASE3"] },
          conditionsModule: { conditions: ["Example condition"] },
        },
      },
    ],
  });
  const result = await searchClinicalTrials(config, { query: "example trial", limit: 1 }, fetchImpl);
  assert.equal(result.returned, 1);
  assert.equal(result.records[0]?.nctId, "NCT12345678");
  assert.equal(result.records[0]?.source.recordUrl, "https://clinicaltrials.gov/study/NCT12345678");
});

test("maps openFDA labels and preserves direct source attribution", async () => {
  const fetchImpl = mockFetch({
    meta: { results: { total: 1 } },
    results: [
      {
        id: "label-id",
        effective_time: "20250101",
        openfda: { brand_name: ["Example"], generic_name: ["example ingredient"] },
        boxed_warning: ["Example warning"],
      },
    ],
  });
  const result = await searchDrugLabels(config, { drug: "example", limit: 1 }, fetchImpl);
  assert.equal(result.totalFound, 1);
  assert.deepEqual(result.records[0]?.brandNames, ["Example"]);
  assert.equal(result.records[0]?.source.name, "openFDA drug labels");
});

function mockFetch(body: object): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}
