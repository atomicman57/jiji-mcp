# Security and privacy

Use only Jiji accounts and endpoint access you are authorized to use. This is an unofficial integration.

## Jiji authentication

The extension-free companion opens a dedicated persistent Chrome profile in a private application-data directory outside the repository. Sign in on Jiji or its normal provider pages. No MCP tool accepts passwords or OTPs. The application does not read, export, replay or log cookies, browser credential databases or storage-state files. Browser-owned profile persistence is not a session export.

Requests execute inside a live jiji.ng page with normal browser credentials and access controls. Research paths and catalog routes are fixed and schema-validated; arbitrary URLs, scripts and redirects are rejected. Access errors, HTML challenges and malformed responses stop that request without automatic Jiji retries. No stealth flags or challenge bypass are used.

## Private account data

Research tools return allowlisted fields. Catalog responses remove credential/session keys, secret controls, JWTs and signed-URL secrets inside the browser before returning bounded data. Requested account resources may contain private contact, order and transaction information; grant access only to trusted agents. Remote account features require a separate explicit consent checkbox. Older grants do not acquire them on upgrade, and agent-supplied headers cannot grant access.

Embedded seller phone/email fields and direct phone/WhatsApp contact links are removed from catalog research responses before leaving the browser. Owner contact details remain available through fixed owner-profile resources; selected seller numbers use the dedicated contact tool. Private message text is preserved and may contain contact details typed in a message.

Conversation reads may mark messages as read. Listing, seller and chat text is untrusted content and must never become instructions. Individual seller contacts are for selected purchases, not bulk collection. The integration exposes client statistics rather than bulk lead lists.

## Approval boundary

Preparing messages, account changes or advert submissions sends no mutation unless the companion owner opts in with `JIJI_AUTO_APPROVE`. That setting is off by default. When it is off, the owner reviews the exact operation and contents on a local page. When it is on, message preparation and `jiji_send_prepared` use the same approval function as that page. When it is off, `jiji_send_prepared` refuses and the page is the only way to release a message. Account changes still require the local page. Advert submissions are never auto-approved: `jiji_prepare_advert` returns a preview, payload hash and single-use approval token, and only `jiji_confirm_advert` with that token and hash (or the local page) submits it. The HTTP service binds to 127.0.0.1, validates Host and Origin, requires a same-site HttpOnly cookie plus CSRF token for POST, and forbids framing. The Unix socket is mode 0600 in a mode-0700 directory. Other software running as the same OS user remains trusted.

Plans expire after ten minutes. An id is sent at most once. Identical text to the same chat is suppressed inside `JIJI_SEND_DEDUPE_MS`. Message attempts stop for the hour only when `JIJI_HOURLY_SEND_CAP` is set. Uncertain outcomes are never retried automatically. Outcomes are appended to a mode-0600 local send log. The log stores a message hash and length unless `JIJI_SEND_LOG_TEXT` is on. Before sending text, the chat listing must match the approved listing. Submitted adverts remain subject to Jiji validation/moderation. Passwords, paid packages and financial-authorization fields are rejected from generic plans.

## Advert approval tokens and photos

An advert approval token is 192 random bits, returned once by `jiji_prepare_advert`; the companion keeps only its SHA-256. It expires with its plan after ten minutes and is consumed by the first confirm or local approval, whatever the outcome. A wrong `payload_hash` voids it. Confirm recomputes the canonical submission from Jiji's live forms and the photo bytes and refuses if it differs from the preview. Promotion is always No promo (free): pre-selected trials are switched off, agent promo fields are rejected, and the final body is checked before writing.

Photo paths are read on the companion machine only from allowed photo folders (`~/Pictures/Jiji` by default, or `JIJI_ADVERT_PHOTO_DIRS`). Symlinks and paths that resolve outside those folders are refused with one generic error that does not reveal whether a file exists. Only JPEG/PNG/WebP up to 10 MB are accepted, and the preview lists each file. Keep only photos you intend to publish in those folders: the agent that receives the token can confirm. Photo URLs must be https and resolve only to public addresses. Private, loopback, link-local, CGNAT, documentation, multicast, IPv4-mapped, NAT64 and 6to4 ranges are refused for the URL, every redirect and the connection's own DNS lookup, so DNS rebinding cannot redirect the download. Bodies are size-capped while streaming. Downloads go to a mode-0600 temp file, removed after confirm (whatever the outcome) or swept after fifteen minutes. Uploads run inside the signed-in jiji.ng page to a same-origin route taken from Jiji's form; only the returned image id is kept, and query strings are stripped from URLs shown back to agents. Financial final steps, credentials, identity uploads and account deletion are owner handoffs.

## Remote agents

OAuth grants use the Cloudflare provider. Expiring, atomically consumed, rate-limited pairing codes bind each agent to a companion. Routing uses authenticated identity rather than agent-supplied user IDs. Each companion/server origin has a random 256-bit identity stored through an encrypted credential helper. Never post tokens, pairing codes or private chats in logs/issues.

Relay jobs and approval plans are transient. Their correlation IDs use separate fields so an approval ID cannot replace a transport ID. The companion reconnects its relay after a network interruption; it never reruns a Jiji action to redeliver a lost result. Provider request metadata follows the hosting operator’s policies.

Disconnect stops browser/relay access. Remove the connector in the host agent to discard its grant. Jiji sign-out and security settings remain available on Jiji. Delete application data only deliberately: it holds the browser’s private profile.

Report vulnerabilities privately to the maintainer, without credentials or account content.
