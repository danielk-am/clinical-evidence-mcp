# Security policy

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/danielk-am/clinical-evidence-mcp/security/advisories/new).

Do not include bearer tokens, email addresses, browser profiles, cookies, patient information, private clinical questions, or raw upstream responses in an issue.

Supported releases are listed in the changelog. The service is designed for read-only public data access, except for an explicitly configured private source that may create one upstream research record and is marked accordingly.

Revoke a bearer token immediately if it may have been exposed.

Private-source browser login uses a separate, short-lived capability. Its raw nonce appears only in an MCP URL fragment, is exchanged once, and is stored as a digest in memory. Browser access then requires a random HttpOnly cookie and expires with the private login session. Login credentials, upstream cookies, WebSocket payloads, and browser profile data must never be logged or returned by MCP.
