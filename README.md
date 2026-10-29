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
| `JIJI_SEND_DEDUPE_MS` | `600000` | Identical message text, including the same native offer amount, is not sent again to the same chat inside this window. The new id returns state `duplicate` and sends nothing. Up to `86400000` (24 hours). |
| `JIJI_SEND_LOG_TEXT` | `false` | When `false`, `send-log.jsonl` stores a SHA-256 of the message and its length. When `true`, the log also stores the message text. |

`jiji_send_prepared` takes a pending message id and calls that same approval function only when `JIJI_AUTO_APPROVE` is true. When it is false, the tool returns an error and sends nothing. Calling it again for an id that is already `sending`, `sent`, `failed`, `uncertain`, `expired`, `capped`, or `duplicate` does not send. A timeout or any other ambiguous failure after the request may have left the machine is `uncertain` and is never retried. A failure that is known not to have sent is `failed`, and that same id is still not retried. `jiji_message_status` reports these states.

Every release attempt is appended to `send-log.jsonl` in the companion application-data directory, mode `0600`. By default the log stores the target, outcome, message length, and a SHA-256 of the message, not the message text. Set `JIJI_SEND_LOG_TEXT=true` to store the text as well. Restart the companion after changing these settings. Auto-approve of the existing prepare tools runs in the companion, so a companion restart is enough for that behavior. `jiji_send_prepared` is a new tool: a local MCP client sees it on its next process start, and agents that connect through the hosted relay see it only after that relay worker is redeployed. D1 and Durable Object bindings do not change.

## Push notifications (notify-only)

The companion can poll Jiji and POST new events to one HTTPS webhook, such as a Grok Bot routine. It is off by default and stays off until both `JIJI_PUSH_WEBHOOK_URL` and `JIJI_PUSH_WEBHOOK_AUTH_VALUE` are set. It never replies, never sends a message or offer, never marks a chat or notification read, and never calls a Jiji action or workflow. The alert POST is its only outbound request.

Each poll reads three fixed account resources through the signed-in companion browser: `chat_rooms`, `notifications`, and `my_adverts` (each up to five pages, following only an explicit next page). It does not open conversations or read `chat_messages`, because opening a chat may mark it read. Events:

| Type | Source | When |
| --- | --- | --- |
| `chat_message` | `chat_rooms` | A room's last message changes, it is not marked as your own, and its unread count is known and at least `1`. |
| `offer` | `chat_rooms`, `notifications` | The same, when the last message carries a native offer (`offer: true`, a positive `offer`, `make_an_offer` or `offer_amount`, or an offer message type); or a new notification whose kind or text mentions an offer. `offer: false`, `0` or `""` is not an offer. |
| `ad_status` | `my_adverts`, `notifications` | An advert's status changes (for example `on_review` → `active` or `declined`); or a new notification whose kind or text mentions approval, rejection, decline, block or moderation. |

Jiji's web API is private and undocumented. Field names were inferred from the web client and mocked fixtures, and unknown fields are treated as unknown rather than guessed. A room with no unread count never alerts, so a reply you sent from another device is not reported as new; the cost is that a room whose payload lacks an unread count is silent. Chat and offer alerts from `chat_rooms` require a known unread count of at least `1`. One ad status change can arrive both as a `my_adverts` transition and as a notification. In the same poll only the `my_adverts` alert is sent. Across polls, whichever source alerts first wins and the matching alert from the other source is dropped, in either order, if it arrives within 48 hours. They match on advert id and outcome (approved, rejected or under review), so an approval never hides a later rejection. If the outcome can't be read from the advert status, they match on advert id alone, and only within 6 hours. Each recorded alert pairs once.

The first successful read of each source records everything as already seen and sends nothing. Later changes alert. A signed-out browser, a Jiji error, or a disconnected companion skips that poll and keeps the saved state. Alert body:

```json
{
  "source": "jiji",
  "type": "chat_message",
  "event_id": "jiji:chat_message:116980747:id:5521",
  "occurred_at": "2026-10-29T10:15:00.000Z",
  "summary": "New Jiji message from Buyer about \"iPhone 13\"",
  "data": { "via": "chat_rooms", "room_id": "116980747", "chat_url": "/profile-messages/116980747", "unread": 1, "preview": "Is it still available?" }
}
```

Previews are capped at 280 characters. Delivery is at least once with `Idempotency-Key: <event_id>`; the receiver should dedupe on `event_id`. Any 2xx is accepted. Network errors, timeouts, DNS failures, 5xx, 408 and 429 are retried. Any other status, including redirects (never followed) and 4xx such as 400, 401, 403 and 404, is logged with its code and event id and dropped without retry.

The webhook host is DNS-checked, failing closed, at startup and again before every POST, but the address is not pinned: `fetch` resolves the name again, so there is a check-then-fetch (DNS rebinding) window in which a host that changes its answer between the check and the request could be reached at a non-public address. Point the webhook only at a host you trust.

| Setting | Default | Effect |
| --- | --- | --- |
| `JIJI_PUSH_WEBHOOK_URL` | unset | `https://` URL with no credentials or fragment. Hosts that are localhost, loopback, private, link-local, CGNAT (`100.64.0.0/10`) or ULA are refused. The host is resolved at startup and again before every POST; any non-public or unresolved answer fails closed. A bad value logs a reason and leaves the feed off. |
| `JIJI_PUSH_WEBHOOK_AUTH_HEADER` | `Authorization` | Header name for the auth value. Letters, digits and hyphens. |
| `JIJI_PUSH_WEBHOOK_AUTH_VALUE` | unset | Secret header value, for example `Bearer <key>`. Never logged. |
| `JIJI_PUSH_POLL_INTERVAL_MS` | `60000` | Poll interval, clamped to 15 seconds through 15 minutes. |
| `JIJI_PUSH_STATE_DIR` | `<app data>/push-notifications` | Absolute path for `push-state.json` (mode `0600`, directory `0700`). |
| `JIJI_PUSH_WEBHOOK_OUTBOX_MAX` | `1000` | Most undelivered alerts kept, 1–100000. |

`push-state.json` holds the per-source baseline, the last message marker per room, the last status per advert, recent ad status alerts for cross-poll dedupe (kept 48 hours), delivered event ids (kept seven days), and the outbox. Retryable failures retry after `min(300, 2 ** min(attempts + 1, 9))` seconds and are dropped after seven days. When the outbox is full, a poll's new events are refused and that poll's state is not saved, so they are detected again once the outbox drains. An unreadable state file is set aside as `push-state.json.corrupt-<ms>`, and the feed baselines again without alerting. Log lines name the webhook host only, never its path, query or auth value. `status` reports `push_notifications` with `enabled`, the host, interval and outbox depth, or the reason it is off.

Set the variables on the companion and restart it. The relay worker does not change. Enabling this on the Linux server is a deploy step that needs the owner's go-ahead; it is not done by this change.

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
