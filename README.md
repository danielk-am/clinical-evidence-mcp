# Clinical Evidence MCP

Search cited medical literature, clinical trials, drug labels, and adverse-event reports from one HTTPS Model Context Protocol endpoint.

Included sources:

- NCBI PubMed
- Europe PMC
- ClinicalTrials.gov
- openFDA drug labels and FAERS report counts
- An optional private syndicated-source bridge, disabled by default and restricted to named MCP account IDs

The server returns source records and interpretation limits. It does not diagnose, prescribe, or replace clinical judgement. Do not submit protected health information or patient identifiers.

## MCP endpoint

Production shape:

```text
POST https://your-host.example/mcp
Authorization: Bearer cemcp_...
```

The maintained reference deployment is `https://clinical-evidence-mcp.danielk.am/mcp`. Ask the operator for a token bound to your email account.

`GET /healthz` is public. MCP requests require a bearer token. Tokens are stored as SHA-256 digests and bound to one normalised email account in the server-side registry.

## Run locally

Requirements: Node.js 22 or newer.

```bash
npm ci
cp .env.example .env
npm run build
DATA_DIR=./data npm run cli -- token create --email clinician@example.com --label local
npm start
```

The token command prints the secret once. Keep it outside Git.

Run checks:

```bash
npm run verify
npm run smoke:providers
npm audit --omit=dev
```

## LibreChat

Add this to `librechat.yaml`. Each user enters their own token in LibreChat's MCP settings.

```yaml
mcpServers:
  clinical-evidence:
    type: streamable-http
    url: https://your-host.example/mcp
    headers:
      Authorization: 'Bearer {{CLINICAL_EVIDENCE_TOKEN}}'
    customUserVars:
      CLINICAL_EVIDENCE_TOKEN:
        title: Clinical Evidence token
        description: Enter the token issued for your email account.
        sensitive: true
    requiresOAuth: false
    startup: false
    initTimeout: 15000
    timeout: 180000
    serverInstructions: true
```

See [LibreChat's MCP configuration](https://www.librechat.ai/docs/features/mcp) for UI and YAML setup.

## Docker and Traefik

Create `.env` from `.env.example`, set `MCP_DOMAIN`, then run:

```bash
docker compose up -d --build
```

The Compose service publishes no host port. It joins the external `coolify` network and exposes port `3946` to Traefik. Runtime tokens live in a Docker volume, not the repository.

Create a production token:

```bash
docker compose exec clinical-evidence-mcp node dist/cli.js token create \
  --email clinician@example.com \
  --label librechat
```

## Optional private source bridge

The public server contains a vendor-neutral bridge contract. Configure all `SYNDICATED_SOURCE_*` variables together to enable it for specific account IDs. The private bridge must:

- remain on an internal Docker network with no host port or Traefik route;
- accept a separate bearer secret;
- return privacy-reduced JSON from `/v1/auth-status`, `/v1/ask`, `/v1/article/:id`, and `/v1/article/:id/wait`;
- avoid history, raw account data, cookies, browser profiles, and patient identifiers;
- label question creation as a remote side effect.

Vendor terms and API permission still apply. A private deployment does not override them.

## Tool catalogue

- `literature_search`
- `literature_article_get`
- `clinical_trials_search`
- `clinical_trial_get`
- `drug_label_search`
- `drug_adverse_event_summary`
- `syndicated_source_status`, allowlisted private accounts only
- `syndicated_research_ask`, allowlisted private accounts only
- `syndicated_article_get`, allowlisted private accounts only
- `syndicated_article_wait`, allowlisted private accounts only

## Licence

MIT. Each upstream data source retains its own terms, notices, and data policies.
