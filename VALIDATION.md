# Validation — version 0.3.3

Verified on 2026-10-27. The platform baseline is `f4b7755`; `f119ec6` adds closed-tab recovery. The latest local companion also removes embedded seller contact fields from account research while preserving owner profile contacts. Version 0.3.1 adds shared native-filter inputs for listing search and market-price samples. Persistent OAuth storage has also migrated from KV to D1; approval boundaries and existing grants are preserved.

## Automated checks

All **28 tests pass** after the browser lifecycle and contact-redaction fixes. They cover tool discovery, research/pagination, catalog schemas, credential and contact redaction inside the browser, owner profile preservation, advert identity, native-offer target validation, saved-search routing, one-time/concurrent/expired approvals, uncertain outcomes without retry, private socket/CSRF protections, and cloud OAuth/PKCE, isolation and expanded consent. `git diff --check` passes. The final cloud build passes. Version 0.3.3 includes the WebSocket relay, stable connection correlation and structured tool output changes described below. The earlier dependency audit applies to the platform baseline, not a new audit of this release.

## Authenticated live checks

The owner signed in directly in the dedicated extension-free browser. Sign-in survived a normal companion restart; browser and cloud relay report connected.

Of the **49 catalog resources accepting empty parameters**, 46 returned successful authenticated reads. This includes profile/business details, settings, saved adverts/searches, own adverts, notifications, follows, feedback, inspections, chat lists, balance, transaction history, statistics and Pro Sales. Transaction history explicitly returned `status: ok` without application errors.

Three resources returned HTTP 404: `orders`, `ad_sharing_pages` and `ad_sharing_active`. Their paths match Jiji's public web-client definitions. Both bought/sold order filters also returned 404, and the current account menu does not offer orders or advert sharing. They are unavailable on this account/site; the test does not prove why. Resources needing an existing order, inspection, advert or feedback identifier are not all live-tested.

Live saved-advert and chat-room responses now omit embedded seller phone fields. Tests through Codex, ChatGPT's connected app, Claude and Grokbot confirm this. Private message text is preserved and can include contact information typed by a seller; metadata redaction is not message-content redaction.

## Client evidence

| Client | Actual verification |
| --- | --- |
| Codex | The active local tool connection now runs the current implementation: signed in, 3 + 12 = 15 unique Used listings through its cursor, and four successful authenticated account reads. Earlier search/details and pending-plan checks also passed. No whole-app restart was needed. |
| ChatGPT | Fresh web verification visibly passes on GPT-5.6 Sol Medium: signed in, 3 + 12 = 15 unique Used listings, and four successful account reads. This chat was left on that working model. GPT-6 still displayed “This response couldn’t load” after tool calls; a plain-text control worked. Returning structured data alone did not resolve that GPT-6 issue. This is a verified compatibility workaround, not a claim that GPT-6 rendering was repaired. |
| Claude | Fresh actual chat verifies signed in, 3 + 12 = 15 unique Used listings and four successful private account reads. Earlier chat-list, contact-redaction and listing-detail checks passed. |
| Grokbot | Personal Jiji bot refreshed all 21 tools and passed signed-in status, 3 + 12 = 15 unique Used listings and four authenticated account reads. It confirmed the earlier missing-cursor problem is fixed and saved continued use of the connector. Earlier details and redaction checks also passed. |

The platform-baseline hosted deployment `efcb874d-e6e9-415f-81b0-efd2e843952e` passed live OAuth/PKCE, isolation and routing fixtures. An ephemeral in-memory grant bound to the real companion also verified research and pending approval/status routing. Pairing codes and tokens are not recorded here.

## Verification limits

No live test sends a seller message or native offer, publishes/deletes an advert, files feedback/reports, pays, changes credentials, uploads identity documents or permanently deletes data. Fixtures do not establish those real effects. The 42 owner workflows are handoffs, not claims of full automation. Account/site-specific feature availability still applies.

## Native condition-filter verification

A real uncategorized attribute-filter request was found to be silently ignored by Jiji. The implementation now requires `category_slug` with attribute filters. Fixed same-origin listing requests support the web client's category/region slugs and bounded native attribute keys, without allowing arbitrary URL parameters.

Live category-scoped 450 W solar-panel checks returned 8/8 Used listings and a price sample of 15/15 Used listings; Brand New checks returned 8/8 on the first page, 8/8 on the next page and 17/17 in the price sample. A multi-select Used/Refurbished search returned 20 results, all with a permitted condition. These are observed public asking-price listings, not completed-sales data. Tests verify forwarding, URL escaping, filtered pagination and rejection of unscoped/unsupported filters.

## D1 deployment verification

The central migration removed the live KV binding and populated the existing D1 database while retaining the bridge Durable Objects. A fresh hosted OAuth/PKCE grant now passes discovery of all 21 tools, the final catalog, real Used/Brand New filtered searches, signed-in status, public search/detail, private account reads and pending-plan/status routing without submission. An earlier pairing attempt failed during the KV-era transition and was not counted as passed.

A dedicated D1 persistence test exercises binary/Unicode/JSON data, metadata, expired-record exclusion, paginated prefix listing, deletion and migration tombstones preventing revoked credentials from reappearing. Deployment tooling preserves the existing D1/bridge bindings and no longer provisions KV. D1 and Worker/DO free-plan quotas remain applicable; no paid plan change was made by this migration.

## Same-page pagination recovery

Version 0.3.2 fixes the real Grokbot finding that a small limit could hide remaining results when Jiji supplied no next-page URL. Cursors now retain the unused normalized results from the current page before following the authoritative server URL. Live verification returned 3 plus 14 results: 17 distinct Used listings, with only one upstream Jiji request. Automated tests cover both final pages and pages followed by another server page, with no omissions, duplicates or extra upstream reads for the buffered remainder.

## WebSocket recovery and tool-result compatibility

The companion now uses an authenticated hibernating WebSocket. Correlation uses a serialized connection ID, rather than JavaScript wrapper identity, so results and close events match restored sockets. Tests exercise different wrappers for the same connection, reject other connections, and send a fresh browser job after forced hibernation. Live status and search also pass after an idle interval. An uncertain operation is never replayed. The old polling routes return HTTP 426. Existing D1 storage, OAuth grants and approval boundaries are preserved.

Successful tool results now retain the original JSON text and also expose the same canonical JSON payload under `structuredContent.data`, with a declared output schema. This is verified for search, pagination and details. The final live hosted OAuth regression passes Used and Brand New filters, same-page cursor completion, account reads and pending-plan/status routing without submission. The ChatGPT display workaround is the model selection documented above; structured output alone was not sufficient.
