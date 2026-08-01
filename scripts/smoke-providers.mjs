#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";
import { searchClinicalTrials } from "../dist/providers/clinical-trials.js";
import { searchLiterature } from "../dist/providers/literature.js";
import { searchDrugLabels } from "../dist/providers/openfda.js";

const config = loadConfig({
  HOST: "127.0.0.1",
  PORT: "3946",
  DATA_DIR: "./data",
  MCP_PUBLIC_URL: "http://127.0.0.1:3946",
});
const [literature, trials, labels] = await Promise.all([
  searchLiterature(config, { query: "hypertension", limit: 1, sort: "relevance" }),
  searchClinicalTrials(config, { condition: "hypertension", limit: 1 }),
  searchDrugLabels(config, { drug: "lisinopril", limit: 1 }),
]);
assert(literature.returned > 0);
assert(trials.returned > 0);
assert(labels.returned > 0);
process.stdout.write("Provider smoke test passed for literature, trials, and drug labels.\n");
