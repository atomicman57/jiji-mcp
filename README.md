# Jiji MCP

An independent, MIT-licensed MCP for Jiji, with **no browser extension required**. Sign in directly on Jiji in the companion's dedicated Chrome window. Codex, Claude, ChatGPT and Grokbot can share your companion through local MCP or an authenticated HTTPS relay.

This project is not affiliated with Jiji. Undocumented endpoints and page selectors can change. Version 0.3 adds a platform catalog with 73 read resources, 35 locally approved changes and 42 browser workflows. Coverage includes direct tools and owner handoffs; opening a workflow does not automate its final steps. Not every endpoint or write has been live-tested. See [FEATURES.md](FEATURES.md) and [VALIDATION.md](VALIDATION.md).

## Capabilities

| Tools                                                                              | Function                                                                                                                           |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `jiji_open_sign_in`, `jiji_connection_status`                                      | Extension-free browser login and connection status                                                                                 |
| `jiji_search`, `jiji_next_page`, `jiji_listing_details`                            | Search, filters, authoritative pagination and full listing details                                                                 |
| `jiji_compare_listings`, `jiji_market_prices`                                      | Compare shortlisted sellers and advertised asking prices for buying/resale research                                                |
| `jiji_seller_contact`, `jiji_whatsapp_handoff`                                     | One selected seller's contacts and a WhatsApp handoff package; no automatic outreach                                               |
| `jiji_list_conversations`, `jiji_read_conversation`                                | Your inbox previews and recent conversation messages                                                                               |
| `jiji_saved_listings`                                                              | Read your existing saved listings                                                                                                  |
| `jiji_prepare_message`, `jiji_prepare_conversation_message`, `jiji_send_prepared`, `jiji_message_status` | Prepare an exact message/native price offer, optionally release it, and check its outcome |
| `jiji_capabilities`                                                                | Discover every mapped resource, action schema and browser workflow                                                                 |
| `jiji_account_data`                                                                | Read profile/business settings, adverts/forms, saved searches, notifications, feedback, orders, statistics and billing information |
| `jiji_prepare_action`, `jiji_prepare_advert`, `jiji_action_status`                 | Prepare exact account changes or advert submissions for local approval and inspect their outcomes                                  |
| `jiji_open_workflow`, `jiji_inspect_workflow`                                      | Open mapped Jiji workflows and inspect ordinary forms; sensitive workflows remain owner handoffs                                   |

There are 23 MCP tools. By default, `jiji_prepare_message` returns a local approval page showing the exact seller, listing and message, and sends nothing. `jiji_prepare_conversation_message` takes an inbox `key` and exact `message` to prepare a reply to that existing conversation through the same approval page. Expired or ambiguous references fail without sending; list conversations again. Only the owner can submit that page, unless the companion opt-in below is on. Each plan expires after ten minutes. Releasing an id sends at most once. An uncertain result is not retried automatically. `jiji_send_prepared` does that only when `JIJI_AUTO_APPROVE` is true. When it is false, the tool refuses and the approval page is the only release. Payments, media uploads, identity verification and credential changes are completed directly on Jiji through owner workflows. Account changes keep the local approval page and are not auto-approved.

Listing preparation resolves existing chat rooms by the exact advert URL returned by Jiji’s room inventory, including listings whose `message_url` opens a message form. Conversation replies and approved sends use the active room’s advert header, so appended prices and links quoted inside messages cannot change the listing target. Ambiguous or unavailable targets still fail without sending.

## Native category filters

For used/new, brand or type filters, first call `jiji_account_data` with `resource: "listing_filters"` and the category `slug`. Use the returned exact `filter_name` and values; attribute identifiers vary by category. Supply that category as `category_slug` when searching. Unscoped attribute filters are rejected because Jiji can silently ignore them.

For example, the verified solar-panel category supports:

```json
{
  "query": "450w solar panel",
  "category_slug": "solar-energy-products",
  "filters": {
    "filter_attr_1484_condition": "Used",
    "filter_attr_1483_type": "Solar Panels"
  },
  "limit": 8
}
```

Both `jiji_search` and `jiji_market_prices` accept category/region slugs, prices and these native filters. Values can be a string or an array for multiple selections. Pagination serves any remaining same-page results first, then follows Jiji’s returned next-page URL, retaining filters. A small limit no longer hides results from the final page. Market prices remain a one-page asking-price sample; query words such as “used” alone are not condition filters. Clients may need a tool refresh to discover the added optional inputs.

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
3. Enter that one-time code on the MCP server's connection page and approve the displayed access. To use the account catalog, explicitly enable the separate account-features checkbox. Older grants retain their earlier access until reconnected.
4. Follow **Continue to your agent**. Repeat with a fresh code for each agent.

OAuth connects an agent to your companion; Jiji sign-in happens only in the dedicated Jiji browser. Each companion/server origin has a separate random 256-bit identity. Pairing codes expire in ten minutes and are consumed once. The relay isolates users and stores no Jiji passwords or cookies. A cloud agent cannot approve an account change through an MCP call. Message release is described under Message release settings. Expanded private account access is recorded in the OAuth grant; a client cannot enable it with a request header.

The optional credential-helper CLI reads/writes a document named `jiji-mcp-companion` in an encrypted store. It must support `list-documents --prefix NAME` and `get-document NAME` with JSON on stdout, plus `put-document NAME` with JSON on stdin. The document contains an `identities` object keyed by HTTPS origin. The application pipes these values internally and never logs them. Local MCP tools do not need a credential helper or cloud identity.

## Self-host the relay

```sh
npx wrangler login
npx wrangler d1 create jiji-browser-mcp-storage
```

Copy `wrangler.jsonc` to `wrangler.local.jsonc`, replace its D1 database ID and initialize it with `npx wrangler d1 execute MCP_STORAGE --remote --config wrangler.local.jsonc --file cloud/d1-schema.sql`, then run:

```sh
npx wrangler deploy --config wrangler.local.jsonc --durable-objects-code-update-mode immediate
```

The Worker uses Cloudflare D1 and per-user Durable Objects, plus `@cloudflare/workers-oauth-provider`. Configure `PUBLIC_ORIGIN` for a custom domain. Companions use hibernating WebSockets; hosting usage costs and limits apply to the operator. Never commit credentials, browser profiles or personal deployment configuration.

## Message release settings

Set these in the companion application-data `config.json`, or as environment variables. An environment variable wins when it is set. The defaults keep today’s approval page.

| Setting | Default | Effect |
| --- | --- | --- |
| `JIJI_AUTO_APPROVE` | `false` | When `true`, the prepare tools send immediately and `jiji_send_prepared` may release a pending message, both through the same function as the local Approve button. When `false`, prepare stays pending and `jiji_send_prepared` refuses. The Approve page is then the only release. |
| `JIJI_HOURLY_SEND_CAP` | unset | Optional. When unset, message sends are not limited by the hour. When set to a number, the attempt that would exceed it returns state `capped` with `blocked` and `limited`, and sends nothing. `0` blocks every send. |
| `JIJI_SEND_DEDUPE_MS` | `600000` | Identical message text, including the same native offer amount, is not sent again to the same chat inside this window. The new id returns state `duplicate` and sends nothing. |
| `JIJI_SEND_LOG_TEXT` | `false` | When `false`, `send-log.jsonl` stores a SHA-256 of the message and its length. When `true`, the log also stores the message text. |

`jiji_send_prepared` takes a pending message id and calls that same approval function only when `JIJI_AUTO_APPROVE` is true. When it is false, the tool returns an error and sends nothing. Calling it again for an id that is already `sending`, `sent`, `failed`, `uncertain`, `expired`, `capped`, or `duplicate` does not send. A timeout or any other ambiguous failure after the request may have left the machine is `uncertain` and is never retried. A failure that is known not to have sent is `failed`, and that same id is still not retried. `jiji_message_status` reports these states.

Every release attempt is appended to `send-log.jsonl` in the companion application-data directory, mode `0600`. By default the log stores the target, outcome, message length, and a SHA-256 of the message, not the message text. Set `JIJI_SEND_LOG_TEXT=true` to store the text as well. Restart the companion after changing these settings. Auto-approve of the existing prepare tools runs in the companion, so a companion restart is enough for that behavior. `jiji_send_prepared` is a new tool: a local MCP client sees it on its next process start, and agents that connect through the hosted relay see it only after that relay worker is redeployed. D1 and Durable Object bindings do not change.

## Linux server

The companion can run headless on Linux and dial out to the same relay. No tunnel is required. The approve page stays on `127.0.0.1`. Sign-in is a separate one-time unit. See [deploy/README.md](deploy/README.md) for the container, systemd units, and cutover checklist. Do not copy the Mac browser profile.

## Development and tests

```sh
npm run cloud:build
npm test
npm audit
```

Tests cover catalog schemas, credential/payment-field rejection, per-user OAuth routing, expanded-access consent, request/approval ID separation, the local HTTP/Unix-socket boundary, and one-time approval state. Live sign-in and each client connection must be verified separately. The tests never contact a real seller or initiate payment.

See [SECURITY.md](SECURITY.md) for trust boundaries and [FEATURES.md](FEATURES.md) for explicit coverage and gaps.

## Idle cloud transport

The companion uses an authenticated WebSocket to `/bridge/socket`. The relay accepts it through the Durable Object Hibernation API, and native protocol ping/pong keeps the connection healthy without an application heartbeat. Idle polling is retired: `/bridge/poll` returns HTTP 426 so an old companion cannot silently consume continuous runtime. Update the companion and restart its local service when deploying this relay version. Existing OAuth grants and browser sign-in are retained. Reconnect never replays an uncertain operation. Search pagination is saved in the existing Durable Object storage so it survives hibernation. No new cron, KV namespace, database, or paid plan is required.

## ChatGPT compatibility

On 2026-10-27, the web verification chat rendered Jiji tool results correctly with GPT-5.6 Sol Medium. GPT-6 returned successful connector calls but its final response displayed “This response couldn’t load.” If affected, select GPT-5.6 Sol in that Jiji chat and send a fresh request. This is an observed client workaround; it does not establish that every model has the issue. Tool results include both JSON text and a matching `structuredContent.data` payload with an output schema.
