# Jiji MCP

An independent, MIT-licensed MCP server for Jiji Nigeria. Search and inspect listings from Codex, Claude, Cursor, Grokbot, or another MCP client, using your own Jiji session in Chrome.

Hosted MCP endpoint: **https://jiji-browser-mcp.felicity-blessing.workers.dev/mcp**. Source is self-hostable; each user connects their own browser bridge and signs in to Jiji directly.

**Status: initial implementation.** Automated tests cover MCP tool calls and the cloud authentication flow. Check the release notes for live-client verification. This project is not affiliated with or endorsed by Jiji. Its undocumented web endpoints may change.

## Sign in to Jiji

Sign in on **https://jiji.ng** in your normal Chrome profile. The extension performs read-only requests inside a Jiji tab. It never reads, exports, or replays cookies, passwords, OTPs, or browser profile databases. If Jiji requires a challenge, authentication, or verification, complete it on the Jiji page yourself. The MCP does not solve CAPTCHAs or retry restrictions.

The MCP exposes five tools:

| Tool                     | Purpose                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `jiji_open_sign_in`      | Open Jiji's normal login page, or give the browser login URL for a remote agent |
| `jiji_connection_status` | Check the bridge connection; does not claim that a user is authenticated        |
| `jiji_search`            | Search and sort listings, with optional price/region/category filters           |
| `jiji_next_page`         | Follow the exact pagination URL returned by Jiji through an opaque cursor       |
| `jiji_listing_details`   | Read a listing's description, attributes, images, price and seller signals      |

No messaging, offers, seller phone retrieval, ad posting, or payments are implemented. Descriptions and seller claims are unverified third-party content.

## Local setup (macOS)

Requires Node.js 22 or later and Google Chrome. Windows/Linux native-host installation is not yet included.

```sh
git clone https://github.com/atomicman57/jiji-mcp.git
cd jiji-mcp
npm ci
npm run install:bridge
```

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked**, then select this project's `extension` directory.
3. Open **Jiji MCP Browser Bridge**, choose **Connect bridge**, and keep a Jiji tab open.
4. Choose **Open Jiji sign-in** and complete login directly on Jiji when needed.
5. Add the server to your MCP client. Use the absolute Node and server paths printed by `install:bridge`:

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

For Codex, the equivalent configuration is:

```toml
[mcp_servers.jiji]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/jiji-mcp/src/server.mjs"]
```

Restart or refresh MCP discovery in the client. Multiple local clients can share the bridge. One Chrome profile owns the bridge at a time. Local connections use a Unix socket inside a mode-0700 directory, with a mode-0600 socket. No local TCP server or cookie file is required. Disconnect in the extension to stop access.

## Cloud agents, including Grokbot

For clients that require an HTTPS MCP URL, deploy the included Cloudflare Worker or use a trusted deployment. Users retain their own Jiji session in their own Chrome browser.

1. In the extension, expand **Connect a cloud agent**.
2. Enter the trusted server's HTTPS origin and choose **Use this server**. Chrome asks permission for that specific server.
3. Add `https://YOUR_SERVER/mcp` as a custom MCP connector in the agent.
4. Choose **Pair an agent** in the extension. Enter its one-time code on the server's connection page and approve the connection.
5. Return to the agent to complete OAuth. Repeat pairing for each agent.

The agent receives an OAuth grant for your bridge. Pairing codes expire after ten minutes and can be consumed once. Each browser installation is isolated by a random 256-bit token stored in extension-local storage. The cloud receives allowlisted listing and seller fields; Jiji cookies and credentials stay in Chrome. Keep Chrome, the native bridge, and a Jiji tab available when using remote agents.

Only pair agents you trust. OAuth does not sign you into Jiji: it binds the agent to your browser bridge. Disconnect stops the bridge's local and remote requests; remove the connector in the agent to discard its grant. Uninstalling the extension removes its installation identity.

## Self-host the cloud relay

```sh
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```

Set the resulting KV namespace ID in a copy of `wrangler.jsonc`, and deploy:

```sh
npx wrangler deploy --config wrangler.local.jsonc
```

The deployment creates a Durable Object namespace for per-user routing, isolated queues, one-time pairing, and login rate limits. OAuth token/grant storage uses KV through `@cloudflare/workers-oauth-provider`. Use a dedicated namespace. Configure `PUBLIC_ORIGIN` when using a custom domain. Cloudflare usage costs and limits apply to the deployment owner; active bridges maintain long polls.

Use your own deployment credentials. No user-specific configuration, Jiji credentials, deployment secrets, or generated native-host wrapper should be committed.

## Development

```sh
npm run cloud:build
npm test
npm audit
```

Run `npm run install:bridge` after changing shared protocol code, then reload the extension in Chrome and refresh Jiji. Cloud tests use Miniflare and require the compiled Worker from `cloud:build`. Native host and popup smoke tests need Chrome. Automated tests never log in to Jiji or contact sellers.

Search is bounded to 20 returned listings per page and uses Jiji's authoritative next-page URL. Cursors are connection-local for stdio and bridge-local for cloud; they expire after 15 minutes and may be lost on a cloud instance restart. The extension spaces requests by at least 1.2 seconds and serializes browser work. It stops on access errors, HTML challenges, or malformed responses without automatic retries.

## Security

See [SECURITY.md](SECURITY.md) for trust boundaries, data retention, and reporting.
