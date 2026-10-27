# Jiji MCP

An independent, MIT-licensed MCP for Jiji, with **no browser extension required**. Sign in directly on Jiji in the companion's dedicated Chrome window. Codex, Claude, ChatGPT and Grokbot can share your companion through local MCP or an authenticated HTTPS relay.

This project is not affiliated with Jiji. Undocumented endpoints and page selectors can change. It reproduces the verified buying/research workflow; it does not implement every Jiji account, advertising, billing or listing-management feature. See [FEATURES.md](FEATURES.md) and [VALIDATION.md](VALIDATION.md).

## Capabilities

| Tools                                                   | Function                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `jiji_open_sign_in`, `jiji_connection_status`           | Extension-free browser login and connection status                                   |
| `jiji_search`, `jiji_next_page`, `jiji_listing_details` | Search, filters, authoritative pagination and full listing details                   |
| `jiji_compare_listings`, `jiji_market_prices`           | Compare shortlisted sellers and advertised asking prices for buying/resale research  |
| `jiji_seller_contact`, `jiji_whatsapp_handoff`          | One selected seller's contacts and a WhatsApp handoff package; no automatic outreach |
| `jiji_list_conversations`, `jiji_read_conversation`     | Your inbox previews and recent conversation messages                                 |
| `jiji_saved_listings`                                   | Read your existing saved listings                                                    |
| `jiji_prepare_message`, `jiji_message_status`           | Prepare an exact message, review it locally, and check its outcome                   |

There is no MCP send/approve tool. `jiji_prepare_message` returns a local approval page showing the exact seller, listing and message. Only the owner can submit that page. Each plan expires after ten minutes and can be used once. An uncertain result is not retried automatically. No payments or automatic binding offers are implemented.

## Install (macOS)

Requires Node.js 22+ and Google Chrome.

```sh
git clone https://github.com/atomicman57/jiji-mcp.git
cd jiji-mcp
npm ci
npm run install:companion
npm run companion
```

Open **http://127.0.0.1:38473**, choose **Open Jiji sign-in**, and log in directly on Jiji in the companion's Chrome window. Passwords, verification codes and cookies are never accepted by MCP tools or exported from the browser. The profile lives in a private application-data directory outside the repository. Complete any Jiji challenge manually; there is no bypass or automatic restriction retry.

The companion is a local service; keep it running during use. A browser extension, native-messaging host and exported cookie file are not needed.

## Local agents

Use the absolute paths printed by `install:companion`:

```json
{
  "mcpServers": {
    "jiji": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/jiji-mcp/src/server.mjs"]
    }
  }
}
```

For Codex:

```toml
[mcp_servers.jiji]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/jiji-mcp/src/server.mjs"]
```

The stdio server talks to the companion through a mode-0600 Unix socket inside a mode-0700 directory. Multiple agents can share one companion. Reload MCP discovery or restart the client after updates.

## ChatGPT, Claude and Grokbot over HTTPS

Enable the cloud relay in the application-data `config.json` printed by the installer. Set `cloudEnabled: true`, `cloudOrigin` to a trusted HTTPS server origin, and `credentialHelper` to an executable compatible with the encrypted credential-helper interface below. Restart the companion.

1. Add the hosted `/mcp` URL as a custom MCP app/connector in your agent, using OAuth.
2. On the companion control page choose **Generate pairing code**.
3. Enter that one-time code on the MCP server's connection page and approve the displayed access.
4. Follow **Continue to your agent**. Repeat with a fresh code for each agent.

OAuth connects an agent to your companion; Jiji sign-in happens only in the dedicated Jiji browser. Each companion/server origin has a separate random 256-bit identity. Pairing codes expire in ten minutes and are consumed once. The relay isolates users and stores no Jiji passwords or cookies. A cloud agent cannot approve a seller message through an MCP call.

The optional credential-helper CLI reads/writes a document named `jiji-mcp-companion` in an encrypted store. It must support `list-documents --prefix NAME` and `get-document NAME` with JSON on stdout, plus `put-document NAME` with JSON on stdin. The document contains an `identities` object keyed by HTTPS origin. The application pipes these values internally and never logs them. Local MCP tools do not need a credential helper or cloud identity.

## Self-host the relay

```sh
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```

Copy `wrangler.jsonc` to `wrangler.local.jsonc`, replace its KV namespace ID, then run:

```sh
npx wrangler deploy --config wrangler.local.jsonc
```

The Worker uses Cloudflare KV and per-user Durable Objects, plus `@cloudflare/workers-oauth-provider`. Configure `PUBLIC_ORIGIN` for a custom domain. Active companions maintain long polls; hosting usage costs and limits apply to the operator. Never commit credentials, browser profiles or personal deployment configuration.

## Development and tests

```sh
npm run cloud:build
npm test
npm audit
```

Tests cover tools, per-user OAuth routing, the local HTTP/Unix-socket boundary, and exact-message approval state. Live sign-in and each client connection must be verified separately. The tests never contact a real seller or initiate payment.

See [SECURITY.md](SECURITY.md) for trust boundaries and [FEATURES.md](FEATURES.md) for explicit coverage and gaps.
