# Changelog

## 0.1.0, 2026-08-01

Initial public release.

1. Added six read-only evidence tools backed by NCBI PubMed, Europe PMC, ClinicalTrials.gov, and openFDA.
2. Added stateless Streamable HTTP transport.
3. Added per-account opaque bearer tokens with digest-only storage and revocation.
4. Added origin and Host validation, per-account rate limiting, and patient-identifier checks.
5. Added Docker Compose deployment for `dk-sin1` behind Traefik HTTPS.
6. Added an optional account-gated contract for private syndicated evidence sources.
