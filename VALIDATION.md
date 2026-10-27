# Validation — version 0.3.0

Verified on 2026-10-27. The platform baseline is `f4b7755`; `f119ec6` adds closed-tab recovery. The latest local companion also removes embedded seller contact fields from account research while preserving owner profile contacts. The hosted relay implementation is unchanged.

## Automated checks

All **21 tests pass** after the browser lifecycle and contact-redaction fixes. They cover tool discovery, research/pagination, catalog schemas, credential and contact redaction inside the browser, owner profile preservation, advert identity, native-offer target validation, saved-search routing, one-time/concurrent/expired approvals, uncertain outcomes without retry, private socket/CSRF protections, and cloud OAuth/PKCE, isolation and expanded consent. `git diff --check` passes. Cloud build and dependency audit passed for the platform baseline; no dependency or Worker code changed in these local fixes.

## Authenticated live checks

The owner signed in directly in the dedicated extension-free browser. Sign-in survived a normal companion restart; browser and cloud relay report connected.

Of the **49 catalog resources accepting empty parameters**, 46 returned successful authenticated reads. This includes profile/business details, settings, saved adverts/searches, own adverts, notifications, follows, feedback, inspections, chat lists, balance, transaction history, statistics and Pro Sales. Transaction history explicitly returned `status: ok` without application errors.

Three resources returned HTTP 404: `orders`, `ad_sharing_pages` and `ad_sharing_active`. Their paths match Jiji's public web-client definitions. Both bought/sold order filters also returned 404, and the current account menu does not offer orders or advert sharing. They are unavailable on this account/site; the test does not prove why. Resources needing an existing order, inspection, advert or feedback identifier are not all live-tested.

Live saved-advert and chat-room responses now omit embedded seller phone fields. Tests through Codex, ChatGPT's connected app, Claude and Grokbot confirm this. Private message text is preserved and can include contact information typed by a seller; metadata redaction is not message-content redaction.

## Client evidence

| Client | Actual verification |
| --- | --- |
| Codex | 21 tools and final 73-read/35-action/42-workflow catalog; real search/detail and pending-plan routing; authenticated profile, saved adverts, own adverts and notifications. |
| ChatGPT | Connected app calls pass live research, catalog/status, expanded-grant account reads, and pending-plan/status checks. Authenticated profile, saved adverts, own adverts, notifications and contact-redaction checks pass. Its web verification chat still displays **“This response couldn’t load”**, including a fresh status-only request. Connector responses work; web response rendering remains unresolved. |
| Claude | Actual verification chat passes signed-in status and profile, saved adverts, own adverts, notifications and chat lists. A separate fresh check confirms saved-advert/chat-room contact fields are omitted. Earlier research and listing-detail checks passed. |
| Grokbot | Supported built-in custom connector tool registered Jiji; OAuth pairing completed and the native card shows **Connected · 1 Account**. Its actual Jiji bot discovered 21 tools and passed nine checks: capabilities, signed-in status, search, listing details and five account reads. It confirmed the metadata redaction and that it will use this connector for future Jiji work. |

The final hosted deployment `efcb874d-e6e9-415f-81b0-efd2e843952e` passed live OAuth/PKCE, isolation and routing fixtures. An ephemeral in-memory grant bound to the real companion also verified research and pending approval/status routing. Pairing codes and tokens are not recorded here.

## Verification limits

No live test sends a seller message or native offer, publishes/deletes an advert, files feedback/reports, pays, changes credentials, uploads identity documents or permanently deletes data. Fixtures do not establish those real effects. The 42 owner workflows are handoffs, not claims of full automation. Account/site-specific feature availability still applies.
