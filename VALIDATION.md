# Validation — version 0.3.0

Runtime implementation tested at commit `f4b7755` on 2026-10-27. Subsequent validation/documentation changes add explicit deployment-update mode and bounded live-test timeouts; the runtime implementation is unchanged.

## Automated checks

`npm run cloud:build`, `npm test` and `npm audit` passed. The suite has 18 tests covering tool discovery/research/pagination, catalog validation, credential/payment-field rejection and browser-side redaction, advert create/edit identity, native-offer target validation, saved-search routing, exact one-time/expired/concurrent approvals, uncertain outcomes without retry, private local socket/HTTP CSRF protections, and cloud OAuth/PKCE, user isolation, expanded consent and transport/approval ID separation.

Live OAuth fixtures establish a bridge heartbeat before issuing requests so network arrival order cannot create a false offline result. Remote HTTP requests have a 45-second timeout and the test has an overall 180-second limit. A prior live rerun hit a network timeout; its failure was not counted as a pass. Cloudflare deploys can temporarily mix Worker and Durable Object versions; the final relay deployment explicitly uses immediate object-code updates.

## Live product evidence

A fresh local stdio client and the running Codex tools discover all 21 tools and the final catalog of 73 read resources, 35 prepared actions and 42 workflows. Actual public search, item detail and search suggestions succeed through the extension-free companion.

The final hosted deployment `efcb874d-e6e9-415f-81b0-efd2e843952e` passed the live OAuth/PKCE, isolation and routing fixture.

The hosted route has also been tested using an ephemeral in-memory OAuth grant bound to the real companion. It discovers 21 tools and the final catalog, returns real listing search/detail data and returns a pending approval plan plus its status without submitting any change. No token or pairing code was written into the repository or validation report.

The Mac companion runs as a LaunchAgent with a private socket and browser profile. Its last verified status is signed out. Existing-browser Jiji inspection is not counted as companion authentication.

## Client completion is still open

- Codex: configured and live research/catalog/preparation calls verified. Authenticated account checks remain pending sign-in.
- ChatGPT: installed; actual hosted search/detail calls succeeded. Expanded OAuth consent/callback and connected-account UI were verified, and tools were refreshed against the final deployment. A dedicated read-only verification chat completed; its detailed response still needs inspection.
- Claude: the replacement OAuth connection succeeded. Its settings show all 21 tools (16 read-only and 5 preparation/navigation tools), with approved reads enabled. A dedicated read-only client test was submitted; its result still needs inspection.
- Grokbot: native installation/test remains pending. Its local UI did not respond to connector controls; further desktop setup stopped when the Mac locked.

The remaining browser setup and test pages were preserved. Native app control again reports the Mac is locked. Unlock and Jiji sign-in are required to finish authenticated inbox/saved/account tests and verify all four clients.

No live test sends a seller message or native offer, publishes/deletes an advert, files feedback/reports, pays, changes credentials or permanently deletes data. Fixtures are not evidence that those real effects have been exercised. Browser owner handoffs in FEATURES.md are not claims of full automation.
