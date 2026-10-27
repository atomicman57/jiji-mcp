# Validation — version 0.2.0

Eleven automated tests currently cover MCP discovery and research, individual-contact/WhatsApp fixtures, conversation routing, draft preparation without sending, one-time/expired/concurrent approval, uncertain delivery without retry, cross-origin rejection, private local socket permissions, and cloud OAuth/PKCE and user isolation.

The extension-free companion service and its control page run on this Mac. It opens a dedicated Jiji browser and reports whether visible account controls indicate sign-in. No browser extension or copied cookie/session file is used.

Live Jiji search/item endpoints were separately checked in an existing browser session. The previous cloud relay passed a live OAuth/routing test using synthetic listing data. Version 0.2.0 must be checked after deployment and each client must be checked separately.

Pending: completing Jiji login in the dedicated companion, authenticated inbox/saved-list verification through that companion, real-client installation checks, and a live seller send (not performed as part of testing). Full Jiji platform coverage is not claimed; see FEATURES.md.
