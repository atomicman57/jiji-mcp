# Validation — version 0.3.0

The platform runtime baseline was tested at commit `f4b7755` on 2026-10-27. A subsequent local browser lifecycle fix recovers a closed Jiji tab instead of retaining its unusable page reference. It preserves any surviving sign-in provider page. The hosted relay implementation is unchanged.

## Automated checks

`npm run cloud:build` and `npm audit` passed for the platform baseline. After the local lifecycle fix, `npm test` passed all 20 tests, including closed-tab sign-in recovery and preserving an existing sign-in provider page. The suite also covers tool discovery/research/pagination, catalog validation, credential/payment-field rejection and browser-side redaction, advert create/edit identity, native-offer target validation, saved-search routing, exact one-time/expired/concurrent approvals, uncertain outcomes without retry, private local socket/HTTP CSRF protections, and cloud OAuth/PKCE, user isolation, expanded consent and transport/approval ID separation.

Live OAuth fixtures establish a bridge heartbeat before issuing requests so network arrival order cannot create a false offline result. Remote HTTP requests have a 45-second timeout and the test has an overall 180-second limit. A prior live rerun hit a network timeout; its failure was not counted as a pass. Cloudflare deploys can temporarily mix Worker and Durable Object versions; the final relay deployment explicitly uses immediate object-code updates.

## Live product evidence

A fresh local stdio client and the running Codex tools discover all 21 tools and the final catalog of 73 read resources, 35 prepared actions and 42 workflows. Actual public search, item detail and search suggestions succeed through the extension-free companion.

The final hosted deployment `efcb874d-e6e9-415f-81b0-efd2e843952e` passed the live OAuth/PKCE, isolation and routing fixture.

The hosted route has also been tested using an ephemeral in-memory OAuth grant bound to the real companion. It discovers 21 tools and the final catalog, returns real listing search/detail data and returns a pending approval plan plus its status without submitting any change. No token or pairing code was written into the repository or validation report.

The Mac companion runs as a LaunchAgent with a private socket and browser profile. Its last verified status is signed out. Existing-browser Jiji inspection is not counted as companion authentication.

## Client completion is still open

- Codex: configured and live research/catalog/preparation calls verified. Authenticated account checks remain pending sign-in.
- ChatGPT: all 21 app tools are available. Live capability/status, expanded-grant search-suggestion reads, and prepare/status calls succeeded through the connected app. Search/detail calls also succeeded. The web verification chat currently displays “This response couldn’t load,” including after reload; that display issue is separate from the verified MCP responses.
- Claude: OAuth and all 21 tools are verified. The saved verification chat passed capability, search and first-listing detail calls. Its initial status call timed out; a standalone retry succeeded and reported the browser/relay connected with Jiji signed out. No seller contact or mutation was exercised.
- Grokbot: native installation/test remains pending. After unlock, its UI is readable but connector controls return invalid-element/frontmost-application errors. The import configuration is prepared; the personal setup window needs to be active to continue.

The remaining browser setup and test pages were preserved. The user has unlocked the Mac. Grokbot native control is still blocked by window/focus errors, and Jiji sign-in is still required to finish authenticated inbox/saved/account tests and verify all four clients.

No live test sends a seller message or native offer, publishes/deletes an advert, files feedback/reports, pays, changes credentials or permanently deletes data. Fixtures are not evidence that those real effects have been exercised. Browser owner handoffs in FEATURES.md are not claims of full automation.
