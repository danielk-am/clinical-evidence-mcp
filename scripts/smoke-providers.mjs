import { loadConfig } from "../dist/config.js";
import { searchClinicalTrials } from "../dist/providers/clinical-trials.js";
import { searchLiterature } from "../dist/providers/literature.js";
import { searchDrugLabels } from "../dist/providers/openfda.js";

const config = loadConfig({
  MCP_PUBLIC_URL: "http://127.0.0.1:3946",
  UPSTREAM_TIMEOUT_MS: "30000",
  ...(process.env.NCBI_EMAIL ? { NCBI_EMAIL: process.env.NCBI_EMAIL } : {}),
  ...(process.env.NCBI_API_KEY ? { NCBI_API_KEY: process.env.NCBI_API_KEY } : {}),
});

const [literature, trials, labels] = await Promise.all([
  searchLiterature(config, { query: "heart failure SGLT2", limit: 2, sort: "newest" }),
  searchClinicalTrials(config, { condition: "heart failure", limit: 2 }),
  searchDrugLabels(config, { drug: "dapagliflozin", limit: 1 }),
]);

if (literature.returned < 1 || trials.returned < 1 || labels.returned < 1) {
  throw new Error("At least one live provider returned no smoke-test records.");
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    literature: literature.returned,
    trials: trials.returned,
    labels: labels.returned,
  })}\n`,
);
