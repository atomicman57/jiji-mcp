# Security and privacy

This is an unofficial, read-only integration for genuine purchase research. Use only with a Jiji account and endpoint access you are authorized to use. This project does not imply Jiji authorization for other users.

## Boundaries

- Jiji authentication stays on Jiji. Neither the MCP nor the relay reads or exports browser cookies, passwords, OTPs, or profile databases.
- The extension has required host access only to `https://jiji.ng/*`. Cloud host access is optional and requested for the exact configured origin. Native messaging is restricted to the extension ID in the generated host manifest.
- Only listing search and item detail GET endpoints are allowlisted. URLs, paths and query names are validated. Cross-origin requests, phone endpoints, redirects, posting and messaging are rejected.
- Listing text is untrusted. MCP consumers must never interpret it as instructions or as verified seller claims.
- The local Unix socket is private to the operating-system user. Other software running as that user can access its public-listing tools; this is not isolation from a compromised account.
- Remote clients use OAuth through the Cloudflare provider. One-time pairing codes bind an agent to one installation. Codes are short-lived, consumed atomically, and stored hashed; authorization attempts are rate-limited and browser consent is CSRF-bound.
- The relay routes requests by authenticated grant identity, never by an agent-supplied user ID. An installation's random bearer token identifies only its own bridge.
- Extension-local installation tokens are never included in MCP responses or committed. Keep them private. Each server origin must use a separate token.

## Data

The relay sees queries and selected public listing/seller fields. It does not receive Jiji session credentials. Seller phone fields and account-specific UI data are excluded before a response leaves Chrome. Listing descriptions may themselves contain seller-written contact information.

OAuth clients, tokens/grants and hashed pairing lookups use KV. Per-user pairing records and rate limits use Durable Object storage. Pending browser requests and results are transient in memory, expire after 25 seconds, and are not logged. The server does not maintain purchase history or message sellers. Platform-level request metadata follows your hosting provider's policies.

## Disconnect and recovery

Disconnect in the extension stops routing. Remove connectors from agents to remove their saved access. Remove the extension to delete its local installation identity. A service operator can revoke OAuth grants through the provider's administration API and delete its KV/DO data. Never post secrets, pairing codes or session data in a GitHub issue.

Report vulnerabilities through the repository's private security reporting feature if available; otherwise contact the maintainer before publishing exploit details.
