import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadIdentity } from "../src/identity.mjs";
import {
  browserLaunchOptions,
  loopbackBindHost,
} from "../src/runtime-policy.mjs";
import { closeReplacedCompanions } from "../cloud/single-bridge.mjs";
import {
  createVncPassword,
  VNC_PASSWORD_PATTERN,
} from "../deploy/vnc-password.mjs";

const root = new URL("..", import.meta.url);

async function text(name) {
  return readFile(new URL(name, root), "utf8");
}

test("browser launch defaults to headed Chrome and can target headless system Chromium", () => {
  assert.deepEqual(browserLaunchOptions({}), {
    headless: false,
    viewport: null,
    channel: "chrome",
  });
  const linux = browserLaunchOptions({
    JIJI_HEADLESS: "true",
    JIJI_CHROMIUM_PATH: "/usr/bin/chromium",
    JIJI_CHROMIUM_NO_SANDBOX: "1",
    JIJI_BROWSER_CHANNEL: "",
  });
  assert.equal(linux.headless, true);
  assert.equal(linux.executablePath, "/usr/bin/chromium");
  assert.equal(linux.channel, undefined);
  assert.deepEqual(linux.viewport, { width: 1280, height: 800 });
  assert.deepEqual(linux.args, [
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ]);
  assert.throws(
    () => browserLaunchOptions({ JIJI_HEADLESS: "sometimes" }),
    /JIJI_HEADLESS/,
  );
});

test("browser proxy is optional and parses credentials without leaking them", () => {
  assert.equal("proxy" in browserLaunchOptions({}), false);
  assert.equal(
    "proxy" in browserLaunchOptions({ JIJI_BROWSER_PROXY: "  " }),
    false,
  );
  const server = "https://ng13.proxy.example:89";
  assert.deepEqual(browserLaunchOptions({ JIJI_BROWSER_PROXY: server }).proxy, {
    server,
  });
  assert.deepEqual(
    browserLaunchOptions({
      JIJI_BROWSER_PROXY: server,
      JIJI_BROWSER_PROXY_USERNAME: "env-user",
      JIJI_BROWSER_PROXY_PASSWORD: "env-pass",
    }).proxy,
    { server, username: "env-user", password: "env-pass" },
  );
  assert.deepEqual(
    browserLaunchOptions({
      JIJI_BROWSER_PROXY: "https://url%40user:p%3Ass@ng13.proxy.example:89/",
    }).proxy,
    { server, username: "url@user", password: "p:ss" },
  );
  assert.deepEqual(
    browserLaunchOptions({
      JIJI_BROWSER_PROXY: "https://url-user:url-pass@ng13.proxy.example:89",
      JIJI_BROWSER_PROXY_USERNAME: "env-user",
      JIJI_BROWSER_PROXY_PASSWORD: "env-pass",
    }).proxy,
    { server, username: "env-user", password: "env-pass" },
  );
  for (const bad of [
    "not a url",
    "ng13.proxy.example:89",
    "ftp://ng13.proxy.example:21",
    "https://secret-user:secret-pass@ng13.proxy.example:89/path",
  ]) {
    assert.throws(
      () => browserLaunchOptions({ JIJI_BROWSER_PROXY: bad }),
      (error) =>
        /JIJI_BROWSER_PROXY/.test(error.message) &&
        !/secret/.test(error.message),
    );
  }
});

test("the control page refuses any bind host except loopback", () => {
  assert.equal(loopbackBindHost(), "127.0.0.1");
  assert.equal(loopbackBindHost(""), "127.0.0.1");
  assert.equal(loopbackBindHost("127.0.0.1"), "127.0.0.1");
  for (const host of ["0.0.0.0", "::", "localhost", "10.0.0.8"])
    assert.throws(() => loopbackBindHost(host), /127\.0\.0\.1 only/);
});

test("a new companion closes every previous bridge socket", () => {
  const closed = [];
  const sockets = [0, 1].map(() => ({
    close(code, reason) {
      closed.push([code, reason]);
    },
  }));
  assert.equal(closeReplacedCompanions(sockets), 2);
  assert.deepEqual(closed, [
    [4001, "Companion replaced"],
    [4001, "Companion replaced"],
  ]);
  assert.equal(closeReplacedCompanions([]), 0);
});

test("Linux packaging stays loopback-only, non-root, and single-companion", async () => {
  const dockerfile = await text("Dockerfile");
  const entry = await text("deploy/entrypoint.sh");
  const steady = await text("deploy/jiji-mcp.service");
  const signin = await text("deploy/jiji-mcp-signin.service");
  const worker = await text("cloud/worker.mjs");
  const wrangler = await text("wrangler.jsonc");
  assert.match(dockerfile, /--uid 950/);
  assert.match(dockerfile, /USER 950:950/);
  assert.match(entry, /-localhost/);
  assert.match(entry, /-nolisten tcp/);
  assert.match(entry, /-passwdfile/);
  assert.match(entry, /jiji-vnc-password create/);
  assert.match(entry, /sudo cat \/var\/lib\/jiji-mcp\/vnc-password/);
  assert.doesNotMatch(entry, /-nopw/);
  assert.doesNotMatch(entry, /-shared/);
  assert.doesNotMatch(entry, /-storepasswd/);
  assert.doesNotMatch(entry, /-rfbauth/);
  assert.doesNotMatch(entry, /\$pw/);
  assert.doesNotMatch(entry, /0\.0\.0\.0/);
  for (const unit of [steady, signin]) {
    assert.match(unit, /--read-only/);
    assert.match(unit, /--cap-drop=ALL/);
    assert.match(unit, /no-new-privileges:true/);
    assert.match(unit, /--user 950:950/);
    assert.match(unit, /--network host/);
    assert.doesNotMatch(unit, /-p 0\.0\.0\.0/);
    assert.doesNotMatch(unit, /5900:5900/);
  }
  assert.match(steady, /-e JIJI_SIGNIN=0/);
  assert.match(steady, /-e JIJI_HEADLESS=true/);
  assert.match(steady, /Conflicts=jiji-mcp-signin\.service/);
  assert.match(signin, /-e JIJI_SIGNIN=1/);
  assert.match(signin, /-e JIJI_HEADLESS=false/);
  assert.match(signin, /Conflicts=jiji-mcp\.service/);
  assert.match(signin, /RuntimeMaxSec=1800/);
  assert.match(
    signin,
    /ExecStopPost=-\/bin\/rm -f \/var\/lib\/jiji-mcp\/vnc-password/,
  );
  assert.doesNotMatch(signin, /WantedBy=/);
  assert.match(worker, /closeReplacedCompanions/);
  assert.match(wrangler, /"binding": "MCP_STORAGE"/);
  assert.match(wrangler, /"name": "BRIDGES"/);
  assert.match(wrangler, /"class_name": "JijiBridge"/);
  const envExample = await text("deploy/env.example");
  assert.doesNotMatch(envExample, /^JIJI_HOURLY_SEND_CAP=/m);
  // The push feed ships documented but off: no uncommented push setting.
  assert.match(envExample, /^# JIJI_PUSH_WEBHOOK_URL=https:\/\//m);
  assert.doesNotMatch(envExample, /^JIJI_PUSH_/m);
  // The browser proxy ships documented but off.
  assert.match(envExample, /^# JIJI_BROWSER_PROXY=/m);
  assert.doesNotMatch(envExample, /^JIJI_BROWSER_PROXY/m);
});

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: process.env,
    });
    let err = "";
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(err || "exit " + code)),
    );
  });
}

test("vnc password generation writes eight safe characters and cleanup deletes the file", async () => {
  for (let i = 0; i < 20; i++)
    assert.match(createVncPassword(), VNC_PASSWORD_PATTERN);
  const dir = await mkdtemp(path.join(tmpdir(), "jiji-vnc-"));
  const file = path.join(dir, "vnc-password");
  const script = new URL("../deploy/vnc-password.mjs", import.meta.url)
    .pathname;
  try {
    await runNode(script, ["create", file]);
    const password = (await readFile(file, "utf8")).trim();
    assert.equal(password.length, 8);
    assert.match(password, VNC_PASSWORD_PATTERN);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await runNode(script, ["remove", file]);
    await assert.rejects(stat(file), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the relay credential helper persists one identity and no browser profile", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jiji-identity-"));
  const file = path.join(dir, "relay-identity.json");
  const previous = process.env.JIJI_IDENTITY_FILE;
  process.env.JIJI_IDENTITY_FILE = file;
  try {
    const helper = new URL("../deploy/credential-helper.mjs", import.meta.url)
      .pathname;
    const first = await loadIdentity(helper, "https://relay.example");
    const second = await loadIdentity(helper, "https://relay.example");
    assert.equal(first, second);
    assert.match(first, /^[a-f0-9]{64}$/);
    const stored = await readFile(file, "utf8");
    assert.match(stored, /relay\.example/);
    assert.doesNotMatch(stored, /cookie|profile|password/i);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const listed = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [helper, "list-documents", "--prefix", "jiji-mcp"],
        { env: process.env },
      );
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve(out) : reject(new Error("helper exited " + code)),
      );
    });
    assert.deepEqual(JSON.parse(listed), ["jiji-mcp-companion"]);
  } finally {
    if (previous === undefined) delete process.env.JIJI_IDENTITY_FILE;
    else process.env.JIJI_IDENTITY_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
