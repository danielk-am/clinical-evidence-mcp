# Changelog

## Unreleased

1. Added read-only Singapore HSA therapeutic-product and MOH Healthier SG drug searches backed by openly licensed data.gov.sg datasets.
2. Added dataset freshness, attribution, no-endorsement, and evidence-boundary warnings to Singapore results.
3. Documented the separation between clinical evidence, registration, subsidy, retail availability, price, and affiliate ranking.
4. Added one-hour metadata caching and process-local data.gov.sg request-window limiting.
5. Updated the transitive Hono dependency to include its CORS ReDoS fix.

## 0.1.0, 2026-08-01

Initial public release.

1. Added six read-only evidence tools backed by NCBI PubMed, Europe PMC, ClinicalTrials.gov, and openFDA.
2. Added stateless Streamable HTTP transport.
3. Added per-account opaque bearer tokens with digest-only storage and revocation.
4. Added origin and Host validation, per-account rate limiting, and patient-identifier checks.
5. Added Docker Compose deployment for `dk-sin1` behind Traefik HTTPS.
6. Added an optional account-gated contract for private syndicated evidence sources.
7. Added account-gated MCP URL elicitation for private-source sign-in, with a one-time fragment nonce, HttpOnly session cookie, and internal HTTP/WebSocket proxy.
