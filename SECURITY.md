# Security and privacy

This is an unofficial integration for genuine purchase research and user-approved seller conversations. Use only Jiji accounts and endpoint access you are authorized to use.

## Jiji authentication

The companion opens a dedicated persistent Chrome profile in a private application-data directory outside the repository. Sign in only on Jiji or its normal sign-in provider pages. No MCP tool accepts passwords or OTPs. The application does not read, export, replay or log cookies, browser credential databases, or storage-state files. Browser-owned profile persistence is not a session export.

Requests run inside a live jiji.ng page. Only listing, item detail and individual seller-contact GET endpoints are allowed. Cross-origin endpoints, arbitrary scripts and redirects are rejected. Access errors, HTML challenges and malformed responses stop the request without automatic retries. No stealth browser flags or challenge bypass are used.

## Private account data

Conversation and saved-list tools read the rendered Jiji interface after sign-in. Reading a conversation may mark it as read. Text from sellers, listings and messages is untrusted content and must never be executed or followed as instructions. Contacts are for individual, explicitly shortlisted purchases, not bulk collection.

Only allowlisted listing/seller fields and requested conversation data reach the relay/agent. Jiji passwords and cookies stay inside Chrome. Conversation and message-plan data are transient in companion memory, not written to a purchase ledger. Platform request metadata follows hosting-provider policies.

## Approval boundary

Preparing a seller message sends nothing. The owner reviews the exact seller, listing and message on a local page and submits it there. There is no MCP-callable approve/send action. The local HTTP server binds to 127.0.0.1, validates Host and Origin, requires a same-site HttpOnly cookie and CSRF token for every POST, and forbids framing. The Unix socket is mode 0600 inside a mode-0700 directory.

Approval plans expire after ten minutes and become non-reusable before the browser performs the send. Uncertain delivery is not retried. Before sending, the chat's listing must match the approved listing. Owner approval is required for offers, commitments or address disclosure; payments are not implemented. Other software running as the same operating-system user remains trusted and can access local application data.

## Remote agents

Agents use OAuth grants through the Cloudflare provider. One-time codes bind them to a companion; codes expire, are consumed atomically and are rate limited. Routing uses the authenticated user identity, not an agent-supplied user ID. The companion/server origin has its own random 256-bit token stored through an encrypted credential helper. Tokens and pairing codes must never be posted in issues, logs or public reports.

Disconnect stops the companion's browser/relay access. Remove the connector from the host agent to discard its grant. Jiji sign-out/account settings remain available on Jiji. Delete application data only deliberately; it contains the browser's private login profile.

Report vulnerabilities privately to the repository maintainer. Never include account credentials, pairing codes, private chats or session data in public issues.
