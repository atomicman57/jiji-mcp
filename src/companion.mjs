#!/usr/bin/env node
import http from "node:http";
import { runCloudSession } from "./cloud-socket.mjs";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JijiBrowser } from "./browser-driver.mjs";
import { ApprovalPlans } from "./plans.mjs";
import { prepareMessageAction } from "./message-actions.mjs";
import {
  createRelease,
  finishPreparedMessage,
  openSendLog,
  readSendSettings,
  releasePrepared,
} from "./message-release.mjs";
import { loadIdentity } from "./identity.mjs";
import { socketPath } from "./bridge.mjs";
import { validatePath } from "./protocol.mjs";
import { buildAction, buildRead, workflows } from "./catalog.mjs";
const runtime = path.dirname(socketPath);
await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
await fs.chmod(runtime, 0o700);
process.umask(0o077);
let config = {
  cloudOrigin: "",
  cloudEnabled: false,
};
try {
  config = {
    ...config,
    ...JSON.parse(await fs.readFile(path.join(runtime, "config.json"), "utf8")),
  };
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const port = Number(config.port || 38473);
const origin = `http://127.0.0.1:${port}`;
const settings = readSendSettings(process.env, config);
const browser = new JijiBrowser(path.join(runtime, "browser-profile"));
const plans = new ApprovalPlans();
const sendLog = await openSendLog(path.join(runtime, "send-log.jsonl"));
// The local Approve button, auto-approve, and jiji_send_prepared all use this.
const dispatchPlan = (p) =>
  browser.run(() =>
    p.type === "jiji_message"
      ? browser.send(p)
      : p.type === "jiji_advert"
        ? browser.executeAdvert(p.parameters)
        : browser.executeAction(p.operation, p.parameters),
  );
const release = createRelease({
  plans,
  send: dispatchPlan,
  log: sendLog,
  settings,
});
let enabled = config.enabled !== false,
  cloudConnected = false,
  cloudError = "",
  cloudAbort,
  identity,
  pairingCode = "";
const session = randomBytes(32).toString("hex"),
  csrf = randomBytes(32).toString("hex");
const escape = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
const publicPlan = (p) => ({ ...p, approval_url: `${origin}/approve/${p.id}` });
async function action(m) {
  if (m.action === "status")
    return {
      ...(await browser.run(() => browser.status())),
      connected: enabled,
      companion_url: origin,
      cloud_connected: cloudConnected,
      cloud_transport: "hibernating-websocket",
      auto_approve: settings.autoApprove,
      hourly_send_cap: settings.hourlySendCap,
    };
  if (m.action === "login") return browser.run(() => browser.login());
  if (!enabled)
    throw new Error(
      "Jiji companion is disconnected. Reconnect on its local control page.",
    );
  if (m.action === "fetch")
    return browser.run(() => browser.fetch(validatePath(m.path)));
  if (m.action === "inbox") return browser.run(() => browser.inbox());
  if (m.action === "conversation")
    return browser.run(() => browser.conversation(m.key));
  if (m.action === "saved") return browser.run(() => browser.saved());
  if (m.action === "resource") {
    buildRead(m.resource, m.parameters);
    return browser.run(() => browser.readResource(m.resource, m.parameters));
  }
  if (m.action === "workflow" || m.action === "inspect_workflow") {
    if (!workflows[m.workflow]) throw new Error("Unknown workflow.");
    return browser.run(() =>
      browser.workflow(m.workflow, m.action === "inspect_workflow"),
    );
  }
  if (m.action === "prepare_action") {
    const p = buildAction(m.operation, m.parameters);
    return publicPlan(
      plans.prepare({
        type: "jiji_api_action",
        operation: p.operation,
        parameters: p.parameters,
        title: p.title,
        purpose: String(m.purpose || "").slice(0, 500),
      }),
    );
  }
  if (m.action === "prepare_advert") {
    const p = await browser.run(() => browser.prepareAdvert(m.parameters));
    return publicPlan(
      plans.prepare({
        type: "jiji_advert",
        operation: p.operation,
        parameters: p.parameters,
        title: p.title,
        purpose: p.notice,
      }),
    );
  }
  if (m.action === "resolve_listing_target")
    return browser.run(() => browser.resolveListingTarget(m.listing_url));
  if (["prepare_message", "prepare_conversation_message"].includes(m.action)) {
    const prepared = await prepareMessageAction(browser, plans, m);
    return publicPlan(
      await finishPreparedMessage(settings.autoApprove, prepared, release),
    );
  }
  if (m.action === "send_prepared") {
    if (!settings.autoApprove)
      await releasePrepared(settings.autoApprove, release, m.id);
    const existing = plans.get(m.id);
    if (existing.type !== "jiji_message")
      throw new Error("Only a prepared message can be released.");
    return publicPlan(
      await releasePrepared(settings.autoApprove, release, existing.id),
    );
  }
  if (m.action === "plan_status")
    return publicPlan(plans.public(plans.get(m.id)));
  throw new Error("Unsupported companion action.");
}
async function remote(route, body = {}, signal) {
  const r = await fetch(config.cloudOrigin + route, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + identity,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error("Cloud relay returned HTTP " + r.status);
  return r.json();
}
async function startCloud() {
  if (cloudAbort || !config.cloudEnabled || !enabled) return;
  try {
    const u = new URL(config.cloudOrigin);
    if (u.protocol !== "https:" || u.origin !== config.cloudOrigin)
      throw new Error("Cloud origin must be an HTTPS origin.");
    identity = await loadIdentity(config.credentialHelper, config.cloudOrigin);
    cloudAbort = new AbortController();
    const signal = cloudAbort.signal;
    let failures = 0;
    while (!signal.aborted && enabled) {
      try {
        await runCloudSession({
          origin: config.cloudOrigin,
          identity,
          signal,
          action,
          onConnected: () => {
            cloudConnected = true;
            cloudError = "";
            failures = 0;
          },
        });
      } catch (e) {
        if (signal.aborted) break;
        cloudConnected = false;
        cloudError = e.message;
        if (e.code === "COMPANION_REPLACED") break;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, delay);
          signal.addEventListener("abort", done, { once: true });
        });
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") cloudError = e.message;
  } finally {
    cloudConnected = false;
    cloudAbort = null;
  }
}

function send(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
function html(res, body) {
  res.writeHead(200, {
    "Content-Type": "text/html;charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Set-Cookie": `jiji-companion=${session}; HttpOnly; SameSite=Strict; Path=/`,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jiji MCP companion</title><link rel="stylesheet" href="/panel.css"><body><main><a class="brand" href="/">Jiji MCP</a>${body}</main><script src="/panel.js"></script></body></html>`,
  );
}
async function read(req) {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 12000) throw new Error("Request too large.");
  }
  return new URLSearchParams(raw);
}
const web = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`)
      return send(res, { error: "Host rejected" }, 403);
    const u = new URL(req.url, origin);
    if (req.method === "POST") {
      if (
        req.headers.origin !== origin ||
        !req.headers.cookie
          ?.split(";")
          .some((c) => c.trim() === "jiji-companion=" + session)
      )
        return send(
          res,
          {
            error:
              "Open the companion control page before submitting an action.",
          },
          403,
        );
      const form = await read(req);
      if (form.get("csrf") !== csrf)
        return send(
          res,
          { error: "Request expired. Reload the control page." },
          403,
        );
      if (u.pathname === "/api/login")
        return send(res, await action({ action: "login" }));
      if (u.pathname === "/api/pair") {
        if (!identity)
          throw new Error(cloudError || "Cloud relay is not configured.");
        pairingCode = (await remote("/bridge/pair")).code;
        return send(res, { code: pairingCode, expires_in: 600 });
      }
      if (u.pathname === "/api/disconnect") {
        enabled = false;
        config.enabled = false;
        await fs.writeFile(
          path.join(runtime, "config.json"),
          JSON.stringify(config, null, 2) + "\n",
          { mode: 0o600 },
        );
        cloudAbort?.abort();
        if (identity) await remote("/bridge/disconnect").catch(() => {});
        await browser.run(() => browser.close());
        return send(res, { disconnected: true });
      }
      if (u.pathname === "/api/connect") {
        enabled = true;
        config.enabled = true;
        await fs.writeFile(
          path.join(runtime, "config.json"),
          JSON.stringify(config, null, 2) + "\n",
          { mode: 0o600 },
        );
        void startCloud();
        return send(res, { connected: true });
      }
      if (u.pathname.startsWith("/api/approve/"))
        return send(res, await release.approve(u.pathname.split("/").pop()));
      return send(res, { error: "Not found" }, 404);
    }
    if (req.method !== "GET")
      return send(res, { error: "Method rejected" }, 405);
    if (["/panel.css", "/panel.js"].includes(u.pathname)) {
      const f = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "panel",
        u.pathname.slice(1),
      );
      res.writeHead(200, {
        "Content-Type": u.pathname.endsWith(".css")
          ? "text/css"
          : "text/javascript",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(await fs.readFile(f));
    }
    if (u.pathname === "/api/status")
      return send(res, {
        ...(await action({ action: "status" })),
        enabled,
        cloud_error: cloudError,
      });
    if (u.pathname.startsWith("/approve/")) {
      const p = plans.public(plans.get(u.pathname.split("/").pop()));
      if (p.type !== "jiji_message")
        return html(
          res,
          `<span class="eyebrow">REVIEW EXACT CHANGES</span><h1>${escape(p.title)}</h1><p>${escape(p.purpose)}</p><pre>${escape(JSON.stringify(p.parameters, null, 2))}</pre><p>This approval applies these changes once on your Jiji account. Review public posts, reports, and deletions carefully. Payments and credential changes are completed directly on Jiji.</p><form action="/api/approve/${escape(p.id)}" method="post"><input type="hidden" name="csrf" value="${csrf}"><button ${p.state !== "pending" ? "disabled" : ""}>Approve these changes on Jiji</button></form><p id="result" role="status">Status: ${escape(p.state)}</p>`,
        );
      return html(
        res,
        `<span class="eyebrow">REVIEW BEFORE SENDING</span><h1>Message ${escape(p.seller)}</h1><p>${escape(p.title)}</p><a href="${escape(p.listing_url)}" target="_blank" rel="noreferrer">View the exact Jiji listing</a>${p.offer_amount === undefined ? "" : `<h2>Native offer: ₦${escape(p.offer_amount)}</h2>`}<pre>${escape(p.message)}</pre><p>Approval sends this exact message or offer once. Check any offer, delivery address, or payment commitment carefully.</p><form action="/api/approve/${escape(p.id)}" method="post"><input type="hidden" name="csrf" value="${csrf}"><button ${p.state !== "pending" ? "disabled" : ""}>Approve and send on Jiji</button></form><p id="result" role="status">Status: ${escape(p.state)}</p>`,
      );
    }
    if (u.pathname === "/")
      return html(
        res,
        `<span class="eyebrow">NO BROWSER EXTENSION REQUIRED</span><h1>Your Jiji, connected.</h1><p>Sign in directly on Jiji in the companion browser. Your agents share the connection; your password and cookies stay in that browser.</p><section><h2>Connection</h2><p id="status" role="status">Checking connection…</p><form action="/api/login" method="post"><input type="hidden" name="csrf" value="${csrf}"><button>Open Jiji sign-in</button></form><form action="/api/connect" method="post"><input type="hidden" name="csrf" value="${csrf}"><button class="secondary">Connect agents</button></form></section><section><h2>Pair ChatGPT, Claude or Grokbot</h2><p>Use this MCP URL in your agent:</p><code>${escape(config.cloudOrigin)}/mcp</code><p>Generate a code for each agent. Enter it only on your MCP server’s connection page.</p><form action="/api/pair" method="post"><input type="hidden" name="csrf" value="${csrf}"><button>Generate pairing code</button></form><output id="pairing"></output></section><section><h2>Review changes</h2><p>Agents can prepare messages and account changes. You review their exact contents here before anything is submitted. Preparing a plan sends nothing unless auto-approve is enabled. Payments, identity uploads and credential changes are completed directly on Jiji.</p>${settings.autoApprove ? `<p><strong>Auto-approve is on.</strong> Prepared messages send immediately through this approval path${Number.isInteger(settings.hourlySendCap) ? `, up to ${settings.hourlySendCap} per hour` : ""}.</p>` : ""}</section><form action="/api/disconnect" method="post"><input type="hidden" name="csrf" value="${csrf}"><button class="secondary">Disconnect</button></form><p id="result" role="status"></p>`,
      );
    return send(res, { error: "Not found" }, 404);
  } catch (e) {
    send(res, { error: e.message }, 400);
  }
});
await new Promise((resolve, reject) => {
  web.on("error", reject);
  web.listen(port, "127.0.0.1", resolve);
});
try {
  await fs.stat(socketPath);
  const alive = await new Promise((resolve) => {
    const c = net.createConnection(socketPath);
    c.on("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.on("error", () => resolve(false));
  });
  if (alive)
    throw new Error(
      "Another bridge owns this socket. Disconnect it before starting the companion.",
    );
  await fs.unlink(socketPath);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const server = net.createServer({ allowHalfOpen: true }, (client) => {
  let raw = "";
  client.setTimeout(90000, () => client.destroy());
  client.on("error", () => {});
  client.on("data", (c) => {
    raw += c;
    if (raw.length > 15000) client.destroy();
  });
  client.on("end", async () => {
    try {
      const result = await action(JSON.parse(raw));
      client.end(JSON.stringify(result) + "\n");
    } catch (e) {
      client.end(JSON.stringify({ error: e.message }) + "\n");
    }
  });
});
await new Promise((resolve, reject) => {
  server.on("error", reject);
  server.listen(socketPath, resolve);
});
await fs.chmod(socketPath, 0o600);
console.error("Jiji companion ready at " + origin);
void startCloud();
const stop = async () => {
  enabled = false;
  cloudAbort?.abort();
  await browser.close();
  server.close();
  web.close();
  await fs.unlink(socketPath).catch(() => {});
  process.exit();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
