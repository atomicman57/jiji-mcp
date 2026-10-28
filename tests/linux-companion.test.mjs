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
  assert.match(entry, /-rfbauth/);
  assert.match(entry, /chmod 0600/);
  assert.match(entry, /sudo cat \/var\/lib\/jiji-mcp\/vnc-password/);
  assert.doesNotMatch(entry, /-nopw/);
  assert.doesNotMatch(entry, /-shared/);
  assert.doesNotMatch(entry, /echo[^\\n]*\$pw/);
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
    /ExecStopPost=-\/bin\/rm -f \/var\/lib\/jiji-mcp\/vnc-password \/var\/lib\/jiji-mcp\/vnc-auth/,
  );
  assert.doesNotMatch(signin, /WantedBy=/);
  assert.match(worker, /closeReplacedCompanions/);
  assert.match(wrangler, /"binding": "MCP_STORAGE"/);
  assert.match(wrangler, /"name": "BRIDGES"/);
  assert.match(wrangler, /"class_name": "JijiBridge"/);
  const envExample = await text("deploy/env.example");
  assert.doesNotMatch(envExample, /^JIJI_HOURLY_SEND_CAP=/m);
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
