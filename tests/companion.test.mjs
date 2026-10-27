import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { bridgeRequest } from "../src/bridge.mjs";
test("extension-free companion has a private socket and rejects cross-site approval", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "jiji-companion-test-"));
  const socket = path.join(tmp, "bridge.sock");
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  await writeFile(
    path.join(tmp, "config.json"),
    JSON.stringify({ cloudEnabled: false, port }),
  );
  const processHandle = spawn(
    process.execPath,
    [new URL("../src/companion.mjs", import.meta.url).pathname],
    {
      env: { ...process.env, JIJI_MCP_SOCKET: socket },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  try {
    await new Promise((resolve, reject) => {
      let text = "";
      processHandle.stderr.on("data", (c) => {
        text += c;
        if (text.includes("Jiji companion ready")) resolve();
      });
      processHandle.on("exit", (code) =>
        reject(new Error("Companion exited " + code)),
      );
    });
    assert.equal((await stat(socket)).mode & 0o777, 0o600);
    const status = await bridgeRequest({ action: "status" }, socket);
    assert.equal(status.extension_required, false);
    assert.equal(status.browser_open, false);
    const origin = "http://127.0.0.1:" + port;
    const page = await fetch(origin);
    const cookie = page.headers.get("set-cookie").split(";")[0];
    const html = await page.text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
    assert.match(html, /NO BROWSER EXTENSION REQUIRED/);
    const blocked = await fetch(origin + "/api/pair", {
      method: "POST",
      headers: { Origin: "https://evil.example", Cookie: cookie },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(blocked.status, 403);
    const noCookie = await fetch(origin + "/api/pair", {
      method: "POST",
      headers: { Origin: origin },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(noCookie.status, 403);
    const plan = await bridgeRequest(
      {
        action: "prepare_message",
        plan: {
          seller: "Example seller",
          title: "Router",
          listing_url: "https://jiji.ng/example.html",
          chat_url: "/profile-messages/7_12",
          message: "Is it still available?",
        },
      },
      socket,
    );
    assert.equal(plan.state, "pending");
    assert.match(plan.approval_url, /\/approve\//);
    const approve = await fetch(origin + "/api/approve/" + plan.id, {
      method: "POST",
      headers: { Origin: "https://evil.example", Cookie: cookie },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(approve.status, 403);
    assert.equal(
      (await bridgeRequest({ action: "plan_status", id: plan.id }, socket))
        .state,
      "pending",
    );
  } finally {
    processHandle.kill("SIGTERM");
    await new Promise((resolve) => processHandle.once("exit", resolve));
    await rm(tmp, { recursive: true, force: true });
  }
});
