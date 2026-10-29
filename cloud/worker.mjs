import { socketConnectionId, matchesSocket } from "./socket-identity.mjs";
import { closeReplacedCompanions } from "./single-bridge.mjs";
import { withD1Storage, cleanupD1Storage } from "./d1-kv.mjs";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "../src/tools.mjs";
import { validatePath } from "../src/protocol.mjs";
export const hash = async (value) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const json = (data, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const escape = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
const stub = (env, id) => env.BRIDGES.get(env.BRIDGES.idFromName(id));
const call = (env, id, path, body) =>
  stub(env, id).fetch("https://bridge.internal" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
const random = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
function html(body, headers = {}, referrerPolicy = "same-origin") {
  const h = new Headers(headers);
  h.set("Content-Type", "text/html;charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("Referrer-Policy", referrerPolicy);
  h.set("X-Content-Type-Options", "nosniff");
  h.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jiji MCP</title><style>body{font:16px/1.6 system-ui;background:#f5f8f6;color:#18312b;max-width:560px;margin:40px auto;padding:24px}input,button{font:inherit;padding:12px;margin:10px 0;display:block}input{width:90%}button{background:#186044;color:white;border:0;border-radius:8px}a{color:#18583f}</style>${body}</html>`,
    { headers: h },
  );
}
async function limited(req, env) {
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  const r = await call(env, "limit:" + (await hash(ip)), "/limit");
  return (await r.json()).allowed;
}
async function authorize(req, env) {
  const oauth = env.OAUTH_PROVIDER;
  if (req.method === "GET") {
    const auth = await oauth.parseAuthRequest(req);
    const info = await oauth.describeConsent(auth);
    const consent = await oauth.beginConsent(auth);
    if (auth.scope.some((s) => !["jiji:read", "offline_access"].includes(s)))
      return json({ error: "Unsupported permission" }, 400);
    return html(
      `<h1>Connect Jiji to your agent</h1><p><strong>${escape(info.clientName)}</strong> wants to use your Jiji companion for listing research, selected seller contacts and your private Jiji conversations.</p><p>Return address: ${escape(info.redirectHost)}. The client name may be self-registered.</p><p>Open the Jiji MCP companion and choose <strong>Generate pairing code</strong>. Enter its one-time pairing code below. Only continue if you started this connection.</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}"><label>Pairing code<input name="code" autocomplete="off" spellcheck="false" required maxlength="32"></label><p>Allows listing research, selected seller contacts, private chat reading and message drafts. Your Jiji password, cookies and verification codes stay in your companion browser. Messages stay on the companion approval page unless the owner has set JIJI_AUTO_APPROVE; payments are completed directly on Jiji.</p><label><input type="checkbox" name="account_access" value="yes"> Also allow account features: profile/business settings, own adverts, notifications, feedback, orders, balance/history and campaign information; prepare changes for local owner approval. This expands private-data access.</label><button name="decision" value="approve">Connect agent</button><button name="decision" value="deny" formnovalidate>Cancel</button></form>`,
      consent.headers,
    );
  }
  if (
    req.method !== "POST" ||
    req.headers.get("Origin") !== new URL(req.url).origin
  )
    return json({ error: "Origin rejected" }, 403);
  if (!(await limited(req, env)))
    return json({ error: "Too many attempts. Wait one minute." }, 429);
  const form = await req.formData();
  const handle = String(form.get("handle") || "");
  if (form.get("decision") !== "approve") {
    const d = await oauth.denyConsent(req, handle);
    return new Response(null, { status: 302, headers: d.headers });
  }
  const approved = await oauth.approveConsent(req, handle);
  const code = String(form.get("code") || "")
    .replace(/[\s-]/g, "")
    .toLowerCase();
  if (!/^[a-f0-9]{20}$/.test(code))
    return html(
      "<h1>Invalid pairing code</h1><p>Restart the connection and use a fresh code from the companion.</p>",
    );
  const codeHash = await hash(code);
  const user = await env.OAUTH_KV.get("pair:" + codeHash);
  if (!user)
    return html(
      "<h1>Pairing code expired</h1><p>Generate a new code in the companion and restart the connection.</p>",
    );
  const consumed = await call(env, user, "/consume", { codeHash });
  if (!consumed.ok)
    return html(
      "<h1>Pairing code already used</h1><p>Generate another code and restart the connection.</p>",
    );
  await env.OAUTH_KV.delete("pair:" + codeHash);
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: user,
    metadata: { label: "Jiji browser bridge" },
    scope: approved.request.scope,
    props: {
      userId: user,
      accountAccess: form.get("account_access") === "yes",
    },
    revokeExistingGrants: false,
  });
  return html(
    `<h1>Jiji connected</h1><p>Your agent can now read listings while your bridge is connected.</p><a href="${escape(redirectTo)}" rel="noreferrer noopener">Continue to your agent</a>`,
    approved.headers,
    "no-referrer",
  );
}
const apiHandler = {
  async fetch(req, env, ctx) {
    if (!ctx.props?.userId || !ctx.auth?.scope?.includes("jiji:read"))
      return json({ error: "Jiji read permission required" }, 403);
    const headers = new Headers(req.headers);
    headers.set(
      "X-Jiji-Account-Access",
      ctx.props.accountAccess === true ? "1" : "0",
    );
    return stub(env, ctx.props.userId).fetch(new Request(req, { headers }));
  },
};
const defaultHandler = {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/authorize") return authorize(req, env);
    if (u.pathname.startsWith("/bridge/")) {
      const socket = u.pathname === "/bridge/socket";
      if (socket ? req.method !== "GET" : req.method !== "POST")
        return json({ error: "Method rejected" }, 405);
      if (
        socket &&
        (req.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
          req.headers.has("Origin"))
      )
        return json({ error: "Native WebSocket upgrade required" }, 403);
      const token = req.headers.get("Authorization")?.replace(/^Bearer /, "");
      if (!/^[a-f0-9]{64}$/.test(token || ""))
        return json({ error: "Browser installation token required" }, 401);
      const user = await hash(token);
      if (socket) {
        const headers = new Headers(req.headers);
        headers.delete("Authorization");
        return stub(env, user).fetch(
          new Request("https://bridge.internal/connect", {
            method: "GET",
            headers,
          }),
        );
      }
      if (u.pathname === "/bridge/pair") {
        if (!(await limited(req, env)))
          return json({ error: "Too many requests" }, 429);
        const code = random().slice(0, 20);
        const codeHash = await hash(code);
        await call(env, user, "/pair", { codeHash });
        await env.OAUTH_KV.put("pair:" + codeHash, user, {
          expirationTtl: 600,
        });
        return json({ code, expires_in: 600 });
      }
      if (
        ![
          "/bridge/poll",
          "/bridge/result",
          "/bridge/disconnect",
          "/bridge/status",
        ].includes(u.pathname)
      )
        return json({ error: "Not found" }, 404);
      if (Number(req.headers.get("Content-Length") || 0) > 7 * 1024 * 1024)
        return json({ error: "Too large" }, 413);
      return call(
        env,
        user,
        u.pathname.replace("/bridge", ""),
        await req.json(),
      );
    }
    if (u.pathname === "/health") return json({ ok: true, version: "0.3.3" });
    if (u.pathname === "/")
      return html(
        '<h1>Jiji MCP</h1><p>Open-source marketplace and account tools through your own Jiji browser session.</p><p>Start the extension-free companion, sign in on jiji.ng, then connect an MCP agent to <code>/mcp</code>. Use a one-time code from your companion to pair each agent.</p><p>This is an independent project, unaffiliated with Jiji.</p><a href="https://github.com/atomicman57/jiji-mcp">Source and installation</a>',
      );
    return json({ error: "Not found" }, 404);
  },
};
export default {
  scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupD1Storage(env));
  },
  async fetch(req, env, ctx) {
    env = withD1Storage(env);
    const origin = env.PUBLIC_ORIGIN || new URL(req.url).origin;
    if (env.PUBLIC_ORIGIN && new URL(req.url).origin !== origin)
      return json({ error: "Host rejected" }, 403);
    const provider = new OAuthProvider({
      apiRoute: "/mcp",
      apiHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["jiji:read", "offline_access"],
      requiredScopes: ["jiji:read"],
      resourceMetadata: {
        resource: origin,
        authorization_servers: [origin],
        resource_name: "Jiji MCP",
      },
      accessTokenTTL: 3600,
      refreshTokenTTL: 30 * 86400,
      clientIdMetadataDocumentEnabled: true,
      allowPrivateUseRedirectUris: true,
    });
    try {
      return await provider.fetch(req, env, ctx);
    } catch {
      return json(
        {
          error:
            "Connection failed. Restart sign-in or check the browser bridge.",
        },
        400,
      );
    }
  },
};
export class JijiBridge {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.jobs = [];
    this.pending = new Map();
    this.poll = null;
    this.lastPoll = 0;
    this.cursors = new Map();
    state.blockConcurrencyWhile(async () => {
      const rows = await state.storage.list({ prefix: "cursor:", limit: 100 });
      for (const [key, value] of rows) {
        if (value.expires > Date.now()) this.cursors.set(key.slice(7), value);
        else await state.storage.delete(key);
      }
    });
  }
  connectedSocket() {
    return this.state
      .getWebSockets("companion")
      .find((ws) => ws.readyState === 1);
  }
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/connect") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return json({ error: "Upgrade required" }, 426);
      // Only the authenticated outer Worker can address this installation's Object.
      // A second companion, such as a Mac left running beside Linux, loses the bridge.
      closeReplacedCompanions(this.state.getWebSockets("companion"));
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server, ["companion"]);
      server.serializeAttachment({
        protocol: 1,
        connectionId: crypto.randomUUID(),
      });
      server.send(JSON.stringify({ type: "ready", protocol: 1 }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (p === "/status")
      return json({
        connected: !!this.connectedSocket(),
        transport: "hibernating-websocket",
      });
    if (p === "/mcp") {
      const accountAccess = req.headers.get("X-Jiji-Account-Access") === "1";
      const request = async (m) => {
        if (
          [
            "resource",
            "workflow",
            "inspect_workflow",
            "prepare_action",
            "prepare_advert",
            "confirm_advert",
          ].includes(m.action) &&
          !accountAccess
        )
          throw new Error(
            "Account-feature access has not been granted. Reconnect this agent and explicitly enable account features on the consent page. Existing listing/chat access remains available.",
          );
        if (m.action === "status" && !this.connectedSocket())
          return {
            connected: false,
            message: "Cloud bridge heartbeat; Jiji login stays in Chrome.",
          };
        if (m.action === "login")
          return {
            message:
              "Open https://jiji.ng/login.html in Chrome on the computer running your bridge. Login cannot be completed in an agent chat.",
          };
        if (
          ![
            "status",
            "resource",
            "workflow",
            "inspect_workflow",
            "prepare_action",
            "prepare_advert",
            "confirm_advert",
            "fetch",
            "inbox",
            "conversation",
            "saved",
            "prepare_message",
            "resolve_listing_target",
            "prepare_conversation_message",
            // The companion refuses this unless JIJI_AUTO_APPROVE is on.
            "send_prepared",
            "plan_status",
          ].includes(m.action)
        )
          throw new Error("Unsupported companion action.");
        if (m.action === "fetch") validatePath(m.path);
        if (!this.connectedSocket())
          throw new Error(
            "Browser bridge offline. Connect the Jiji MCP companion on your computer.",
          );
        if (this.pending.size >= 20) throw new Error("Browser bridge busy.");
        return new Promise((resolve, reject) => {
          const id = crypto.randomUUID();
          const timer = setTimeout(() => {
            this.pending.delete(id);
            this.jobs = this.jobs.filter((j) => j.id !== id);
            reject(
              new Error("Browser request timed out. Check your Jiji tab."),
            );
          }, 25000);
          this.pending.set(id, { resolve, reject, timer });
          this.jobs.push({ ...m, id, request: m });
          this.flush();
        });
      };
      const beforeCursors = new Map(
        [...this.cursors].map(([key, value]) => [key, JSON.stringify(value)]),
      );
      const server = createServer(request, { cursors: this.cursors });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(req);
      } finally {
        // Timers exist only while real requests run. Pagination must survive idle eviction.
        for (const [key, value] of this.cursors)
          if (beforeCursors.get(key) !== JSON.stringify(value))
            await this.state.storage.put("cursor:" + key, value);
        for (const key of beforeCursors.keys())
          if (!this.cursors.has(key))
            await this.state.storage.delete("cursor:" + key);
        await transport.close();
        await server.close();
      }
    }
    const b = await req.json();
    if (p === "/limit") {
      const now = Date.now();
      const times = ((await this.state.storage.get("attempts")) || []).filter(
        (t) => now - t < 60000,
      );
      const allowed = times.length < 6;
      if (allowed) times.push(now);
      await this.state.storage.put("attempts", times);
      return json({ allowed });
    }
    if (p === "/pair") {
      await this.state.storage.put("pair", {
        hash: b.codeHash,
        expires: Date.now() + 600000,
      });
      return json({ ok: true });
    }
    if (p === "/consume") {
      const ok = await this.state.storage.transaction(async (txn) => {
        const c = await txn.get("pair");
        if (!c || c.expires < Date.now() || c.hash !== b.codeHash) return false;
        await txn.delete("pair");
        return true;
      });
      return json({ ok }, ok ? 200 : 401);
    }
    if (p === "/poll")
      return json(
        { error: "Companion upgrade required; connect through /bridge/socket" },
        426,
      );
    if (p === "/result")
      return json({ error: "Use the authenticated companion WebSocket" }, 426);
    if (p === "/disconnect") {
      for (const ws of this.state.getWebSockets("companion"))
        ws.close(1000, "Disconnected");
      this.lastPoll = 0;
      this.jobs = [];
      for (const t of this.pending.values()) {
        clearTimeout(t.timer);
        t.reject(new Error("Browser bridge disconnected."));
      }
      this.pending.clear();
      if (this.poll) {
        clearTimeout(this.poll.timer);
        this.poll.resolve(json({ jobs: [] }));
        this.poll = null;
      }
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  }
  flush() {
    const ws = this.connectedSocket();
    for (const job of this.jobs.splice(0)) {
      const pending = this.pending.get(job.id);
      if (!pending) continue;
      try {
        if (!ws) throw new Error("Browser bridge disconnected.");
        const message = JSON.stringify({ type: "job", job });
        if (
          new TextEncoder().encode(message).byteLength > 262144 ||
          ws.bufferedAmount > 1048576
        )
          throw new Error("Browser bridge busy.");
        pending.connectionId = socketConnectionId(ws);
        ws.send(message);
      } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(job.id);
        pending.reject(error);
      }
    }
  }
  webSocketMessage(ws, message) {
    if (
      typeof message !== "string" ||
      new TextEncoder().encode(message).byteLength > 7 * 1024 * 1024
    ) {
      ws.close(1009, "Message too large");
      this.failSocket(ws);
      return;
    }
    let body;
    try {
      body = JSON.parse(message);
    } catch {
      ws.close(1008, "Invalid message");
      this.failSocket(ws);
      return;
    }
    if (
      body?.type !== "result" ||
      typeof body.id !== "string" ||
      !body.result ||
      typeof body.result !== "object" ||
      Array.isArray(body.result)
    ) {
      ws.close(1008, "Invalid result");
      this.failSocket(ws);
      return;
    }
    const pending = this.pending.get(body.id);
    if (!pending || !matchesSocket(pending.connectionId, ws)) return; // Unknown/late result: never replay an operation.
    clearTimeout(pending.timer);
    this.pending.delete(body.id);
    if (body.result.error)
      pending.reject(new Error(String(body.result.error).slice(0, 500)));
    else pending.resolve(body.result);
  }
  failSocket(ws) {
    for (const [id, pending] of this.pending)
      if (matchesSocket(pending.connectionId, ws)) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(
          new Error("Browser connection lost; the operation was not retried."),
        );
      }
  }
  webSocketClose(ws) {
    this.failSocket(ws);
    ws.close(1000);
  }
  webSocketError(ws) {
    this.failSocket(ws);
    ws.close(1011, "Connection error");
  }
}
