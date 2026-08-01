# Clinical Evidence MCP

**Search medical literature, trial registrations, drug labels, and adverse-event reports from any compatible MCP client.**

Clinical Evidence MCP is a source-first Model Context Protocol server. It queries official public APIs at request time and returns structured records with stable identifiers, direct source URLs, and retrieval timestamps.

Hosted endpoint: `https://clinical-evidence-mcp.danielk.am/mcp`

A bearer token is required. Tokens are issued by the operator, bound to one email account, and never accepted in URLs.

## Tools

| Tool | Source | Result |
| --- | --- | --- |
| `literature_search` | NCBI PubMed and Europe PMC | Deduplicated citations and abstracts when available |
| `literature_article_get` | Europe PMC | One record by PMID, PMCID, or DOI |
| `clinical_trials_search` | ClinicalTrials.gov | Trial registrations matching terms and filters |
| `clinical_trial_get` | ClinicalTrials.gov | One study by NCT identifier |
| `drug_label_search` | openFDA | Current label records matching a drug name |
| `drug_adverse_event_summary` | openFDA FAERS | Reported reaction counts with safety warnings |

The server also exposes `clinical-evidence://sources`, a resource describing upstream datasets and their limits.

An optional private source can add four allowlisted tools: `syndicated_source_status`, `syndicated_research_ask`, `syndicated_article_get`, and `syndicated_article_wait`. This integration is disabled by default. Creating a syndicated research question creates one record in that private upstream account, and the MCP annotation states this side effect.

## Connect LibreChat

Add this to `librechat.yaml`:

```yaml
mcpServers:
  clinical-evidence:
    type: streamable-http
    url: https://clinical-evidence-mcp.danielk.am/mcp
    requiresOAuth: false
    startup: false
    initTimeout: 15000
    timeout: 180000
    serverInstructions: true
    headers:
      Authorization: 'Bearer {{CLINICAL_EVIDENCE_TOKEN}}'
    customUserVars:
      CLINICAL_EVIDENCE_TOKEN:
        title: Clinical Evidence token
        description: Enter the personal token issued for your email account.
        sensitive: true
```

Restart LibreChat, save the token under MCP Settings, then reinitialise the connector. Each LibreChat user can have a separate token. See [LibreChat's MCP documentation](https://www.librechat.ai/docs/features/mcp) for UI and YAML setup.

## Connect Claude

Claude's static request-header support for custom connectors has staged availability. If Request headers is available for your account:

1. Open Settings, then Connectors, and add a custom connector.
2. Enter `https://clinical-evidence-mcp.danielk.am/mcp`.
3. Add the request header `Authorization` with the full value `Bearer cemcp_...`.

If Request headers is absent, use LibreChat or another bearer-header client. Per-user Claude sign-in requires an OAuth 2.1 authorization service, which is outside this release.

## Run locally

Requirements: Node.js 22 or later.

```bash
npm ci
npm run build
cp .env.example .env
DATA_DIR=./data npm run cli -- token create --email clinician@example.com --label local
DATA_DIR=./data npm start
```

The token creation command prints the secret once. Store it in a password manager.

Test an initialisation request from a terminal:

```bash
curl -sS http://127.0.0.1:3946/mcp \
  -H 'Authorization: Bearer cemcp_REPLACE_ME' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

## Manage tokens from the terminal

```bash
npm run cli -- token create --email clinician@example.com --label librechat
npm run cli -- token list
npm run cli -- token revoke tok_REPLACE_ME
```

With Docker Compose, prefix those commands with:

```bash
docker compose exec clinical-evidence-mcp node dist/cli.js
```

The registry stores SHA-256 token digests, immutable account IDs, normalised email addresses, labels, and revocation timestamps in `/data/tokens.json`. Raw secrets are not stored. Protect `/data`, backups, and terminal output as sensitive operator data.

## Deploy

The included Compose file expects:

1. A Traefik proxy on an external Docker network named `coolify`.
2. DNS for `clinical-evidence-mcp.danielk.am` pointing at the host.
3. A server-only `.env` file in `/srv/clinical-evidence-mcp`.

The deployment helper copies the working tree to `dk-sin1`, builds the pinned container, and checks the public health endpoint:

```bash
scripts/deploy-dk-sin1.sh
```

No host port is published. Traefik terminates HTTPS and forwards traffic over the Docker network.

## Optional private source bridge

The public server contains a vendor-neutral bridge contract. Configure every `SYNDICATED_SOURCE_*` variable together to enable it for specific account IDs.

The private bridge must:

- remain on an internal Docker network with no host port or Traefik route;
- accept a separate bearer secret;
- return privacy-reduced JSON from `/v1/auth-status`, `/v1/ask`, `/v1/article/:id`, and `/v1/article/:id/wait`;
- avoid exposing history, account data, raw payloads, cookies, browser profiles, or patient identifiers;
- label question creation as a remote side effect.

Vendor terms and API permission still apply. Private deployment does not override them.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `3946` | Internal HTTP port |
| `DATA_DIR` | `./data` | Token registry directory |
| `MCP_PUBLIC_URL` | local URL | Public origin, HTTPS required outside loopback |
| `MCP_ALLOWED_ORIGINS` | `https://claude.ai` | Comma-separated browser Origin allowlist |
| `REQUESTS_PER_MINUTE` | `60` | Per-account request limit |
| `UPSTREAM_TIMEOUT_MS` | `20000` | Public provider request timeout |
| `NCBI_EMAIL` | unset | Optional NCBI client contact |
| `NCBI_API_KEY` | unset | Optional NCBI API key |
| `SYNDICATED_SOURCE_NAME` | unset | Private provider label |
| `SYNDICATED_SOURCE_URL` | unset | Internal bridge URL |
| `SYNDICATED_SOURCE_TOKEN` | unset | Bridge bearer secret |
| `SYNDICATED_SOURCE_ALLOWED_ACCOUNT_IDS` | unset | Comma-separated MCP account allowlist |
| `SYNDICATED_SOURCE_TIMEOUT_MS` | `200000` | Private provider request timeout |

## Safety and data limits

Do not submit names, contact details, medical record numbers, dates of birth, or other patient identifiers. The input check catches common identifier patterns, but it is not a substitute for deidentification at the source.

This service does not diagnose, prescribe, provide emergency advice, or replace clinical judgement. Source records can be incomplete, delayed, corrected, or withdrawn.

ClinicalTrials.gov records are submitted by sponsors and investigators. Registration does not mean a study has been evaluated or approved by the U.S. government.

FAERS reports are voluntary and incomplete. Counts do not establish causation, incidence, prevalence, or comparative risk. openFDA notes that its FAERS dataset is updated quarterly and may lag by three months or more.

Publication abstracts can remain subject to publisher or author copyright. This server fetches them on demand and does not build a persistent publication corpus.

## Upstream documentation

1. [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25499/)
2. [Europe PMC REST API](https://europepmc.org/RestfulWebService)
3. [ClinicalTrials.gov API](https://clinicaltrials.gov/data-api/api)
4. [openFDA drug labels](https://open.fda.gov/apis/drug/label/)
5. [openFDA drug adverse events](https://open.fda.gov/apis/drug/event/)
6. [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

## Verify

```bash
npm run verify
npm run smoke:providers
npm audit --omit=dev
docker compose --env-file .env.example config --quiet
git diff --check
```

## Licence

[MIT](LICENSE)
