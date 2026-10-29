import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JijiBrowser } from "../src/browser-driver.mjs";
import { ApprovalPlans } from "../src/plans.mjs";
import { createServer } from "../src/tools.mjs";
import { browserProxyList, scrubProxySecrets } from "../src/runtime-policy.mjs";

const MARKERS = /FAKEUSER_MARK|FAKEPASS_MARK/;
const DIRTY =
  "page.click: net::ERR_PROXY_CONNECTION_FAILED via https://FAKEUSER_MARK:FAKEPASS_MARK@proxy.example:89";
const NAV_FAILED = "Jiji navigation failed through the browser proxy.";
const A = "https://proxy.example:89";
const B = "https://proxy2.example:89";
const room = "/profile-messages/7_12";
const listing =
  "https://jiji.ng/ikeja/networking-products/router-abcdefgh12345678.html";
const key = "a".repeat(24);
const ENV_KEYS = [
  "JIJI_BROWSER_PROXY",
  "JIJI_BROWSER_PROXIES",
  "JIJI_BROWSER_PROXY_USERNAME",
  "JIJI_BROWSER_PROXY_PASSWORD",
  "JIJI_BROWSER_PROXY_BYPASS",
];

function withEnv(t, env) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  t.after(() => {
    for (const k of ENV_KEYS)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  });
}

function captureLogs(t) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  t.after(() => {
    console.error = original;
  });
  return logged;
}

// A browser on the given proxy list, without launching anything.
function proxiedBrowser(entries, active = 0) {
  const browser = new JijiBrowser("unused-mock-profile");
  browser.proxies = browserProxyList({ JIJI_BROWSER_PROXIES: entries });
  browser.activeProxyIndex = active;
  return browser;
}

// A conversation list page whose click / waitForURL can be made to fail.
function inboxPage({ click, waitForURL } = {}) {
  const labels = {
    first: () => ({ waitFor: async () => {} }),
    evaluateAll: async (fn, item) =>
      fn(
        [
          {
            querySelector: (selector) => ({
              textContent: selector.endsWith("-name") ? "Seller" : "Router",
            }),
          },
        ],
        item,
      ),
    nth: () => ({ click: click || (async () => {}) }),
  };
  return {
    url: () => "https://jiji.ng" + room,
    locator: (selector) =>
      selector === ".qa-room-label-link" ? labels : { waitFor: async () => {} },
    waitForURL: waitForURL || (async () => {}),
  };
}

test("scrubProxySecrets strips URL userinfo and configured credentials, recursively", () => {
  const proxies = browserProxyList({
    JIJI_BROWSER_PROXIES:
      "https://FAKEUSER_MARK:FAKEPASS_MARK@proxy.example:89",
  });
  assert.equal(
    scrubProxySecrets(DIRTY, proxies),
    "page.click: net::ERR_PROXY_CONNECTION_FAILED via https://proxy.example:89",
  );
  // Bare credentials (no URL) are caught by value, from env or the list.
  const env = {
    JIJI_BROWSER_PROXIES: A,
    JIJI_BROWSER_PROXY_USERNAME: "FAKEUSER_MARK",
    JIJI_BROWSER_PROXY_PASSWORD: "FAKE/PASS_MARK",
  };
  const bare = "auth FAKEUSER_MARK FAKE/PASS_MARK FAKE%2FPASS_MARK";
  assert.doesNotMatch(scrubProxySecrets(bare, env), /FAKE/);
  assert.doesNotMatch(
    scrubProxySecrets("user FAKEUSER_MARK pass FAKEPASS_MARK", proxies),
    MARKERS,
  );
  const nested = scrubProxySecrets(
    { error: DIRTY, detail: [{ message: DIRTY }], code: 7, ok: null },
    proxies,
  );
  assert.doesNotMatch(JSON.stringify(nested), MARKERS);
  assert.equal(nested.code, 7);
  assert.equal(nested.ok, null);
  // An env with an unparseable list is read leniently, never thrown on.
  assert.equal(
    scrubProxySecrets("plain", { JIJI_BROWSER_PROXIES: "not a url" }),
    "plain",
  );
});

test("lastError and status never retain proxy credentials, even from a dirty string", async (t) => {
  withEnv(t, {
    JIJI_BROWSER_PROXIES: A,
    JIJI_BROWSER_PROXY_USERNAME: "FAKEUSER_MARK",
    JIJI_BROWSER_PROXY_PASSWORD: "FAKEPASS_MARK",
  });
  const browser = new JijiBrowser("unused-mock-profile");
  browser.lastError = DIRTY + " user=FAKEUSER_MARK";
  assert.doesNotMatch(browser.lastError, MARKERS);
  const status = await browser.status();
  assert.match(status.last_error, /ERR_PROXY_CONNECTION_FAILED/);
  assert.doesNotMatch(JSON.stringify(status), MARKERS);
  browser.lastError = null;
  assert.equal(browser.lastError, null);
});

test("openConversation click failure through the last proxy is the fixed error", async (t) => {
  const logged = captureLogs(t);
  const browser = proxiedBrowser(
    "https://FAKEUSER_MARK:FAKEPASS_MARK@proxy.example:89",
  );
  browser.conversations.set(key, { seller: "Seller", title: "Router" });
  browser.go = async () =>
    inboxPage({
      click: async () => {
        throw new Error(DIRTY);
      },
    });
  await assert.rejects(browser.openConversation(key), (error) => {
    assert.equal(error.message, NAV_FAILED);
    assert.doesNotMatch(JSON.stringify(error), MARKERS);
    return true;
  });
  assert.doesNotMatch(logged.join("\n"), MARKERS);
  assert.doesNotMatch(JSON.stringify(await browser.status()), MARKERS);
});

test("openConversation waitForURL failure is sanitized at the MCP boundary", async (t) => {
  const browser = proxiedBrowser(
    "https://FAKEUSER_MARK:FAKEPASS_MARK@proxy.example:89",
  );
  browser.conversations.set(key, { seller: "Seller", title: "Router" });
  browser.go = async () =>
    inboxPage({
      waitForURL: async () => {
        throw new Error(
          "page.waitForURL: net::ERR_HTTP_RESPONSE_CODE_FAILURE " + DIRTY,
        );
      },
    });
  const request = async (m) => {
    if (m.action !== "status") throw new Error("unexpected " + m.action);
    await browser.openConversation(key);
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(request);
  const client = new Client({ name: "proxy-secrets", version: "1" });
  await server.connect(a);
  await client.connect(b);
  try {
    const result = await client.callTool({
      name: "jiji_connection_status",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, NAV_FAILED);
    assert.doesNotMatch(JSON.stringify(result), MARKERS);
  } finally {
    await client.close();
    await server.close();
  }
});

test("the MCP boundary scrubs a dirty error message that slipped through", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(async () => {
    throw new Error(DIRTY);
  });
  const client = new Client({ name: "proxy-secrets", version: "1" });
  await server.connect(a);
  await client.connect(b);
  try {
    const result = await client.callTool({
      name: "jiji_connection_status",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /proxy\.example:89/);
    assert.doesNotMatch(JSON.stringify(result), MARKERS);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a Chrome 407 while opening a conversation fails over and retries once", async (t) => {
  withEnv(t, { JIJI_BROWSER_PROXIES: A + "," + B });
  const logged = captureLogs(t);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "jiji-secrets-"));
  const original = chromium.launchPersistentContext;
  const servers = [];
  chromium.launchPersistentContext = async (_profile, options) => {
    servers.push(options.proxy.server);
    const page = {
      isClosed: () => false,
      url: () => "https://jiji.ng/",
      goto: async () => ({ status: () => 200 }),
    };
    return {
      pages: () => [page],
      on: () => {},
      close: async () => {},
    };
  };
  t.after(async () => {
    chromium.launchPersistentContext = original;
    await fs.rm(profile, { recursive: true, force: true });
  });
  const browser = new JijiBrowser(profile);
  await browser.open();
  browser.conversations.set(key, { seller: "Seller", title: "Router" });
  let clicks = 0;
  browser.go = async () =>
    inboxPage({
      click: async () => {
        clicks++;
        if (browser.activeProxyIndex === 0)
          throw new Error(
            "page.click: net::ERR_HTTP_RESPONSE_CODE_FAILURE via https://FAKEUSER_MARK:FAKEPASS_MARK@proxy.example:89",
          );
      },
    });
  const { item } = await browser.openConversation(key);
  assert.equal(item.seller, "Seller");
  assert.deepEqual(servers, [A, B]);
  assert.equal(browser.activeProxyIndex, 1);
  assert.equal(clicks, 2);
  assert.doesNotMatch(logged.join("\n"), MARKERS);
});

// A chat page whose send steps can be made to fail; counts editor writes.
function chatPage({ press, waitForFunction } = {}) {
  const writes = { fill: 0, press: 0 };
  const editor = {
    waitFor: async () => {},
    fill: async () => {
      writes.fill++;
    },
    press: async () => {
      writes.press++;
      if (press) await press();
    },
  };
  const page = {
    url: () => "https://jiji.ng" + room,
    locator: (selector) => {
      if (selector === ".qa-messenger-send-message-textarea") return editor;
      if (selector === "a.b-messenger-room-advert-info-link")
        return { evaluateAll: async (fn) => fn([{ href: listing }]) };
      return { count: async () => 0 };
    },
    waitForFunction: waitForFunction || (async () => {}),
  };
  return { page, writes };
}

for (const step of ["press", "waitForFunction"])
  test(`a send ${step} failure through a proxy is scrubbed, uncertain and never re-sent`, async (t) => {
    const logged = captureLogs(t);
    const browser = proxiedBrowser(
      "https://FAKEUSER_MARK:FAKEPASS_MARK@proxy.example:89," + B,
    );
    const fail = async () => {
      throw new Error(
        "page." + step + ": net::ERR_HTTP_RESPONSE_CODE_FAILURE " + DIRTY,
      );
    };
    const { page, writes } = chatPage({ [step]: fail });
    browser.go = async () => page;
    browser.failOver = async () =>
      assert.fail("A possibly sent message must not fail over");
    const plans = new ApprovalPlans();
    const plan = plans.prepare({
      type: "jiji_message",
      chat_url: room,
      listing_url: listing,
      message: "Hello",
    });
    const result = await plans.approve(plan.id, (p) => browser.send(p));
    assert.equal(result.state, "uncertain");
    assert.equal(result.result.error, NAV_FAILED);
    assert.doesNotMatch(JSON.stringify(result), MARKERS);
    await assert.rejects(
      plans.approve(plan.id, (p) => browser.send(p)),
      /already handled/,
    );
    assert.equal(writes.fill, 1);
    assert.equal(writes.press, 1);
    assert.equal(browser.activeProxyIndex, 0);
    assert.doesNotMatch(logged.join("\n"), MARKERS);
    assert.doesNotMatch(JSON.stringify(await browser.status()), MARKERS);
  });

test("plan errors are scrubbed even when the driver lets a dirty message through", async (t) => {
  withEnv(t, {
    JIJI_BROWSER_PROXIES: A,
    JIJI_BROWSER_PROXY_USERNAME: "FAKEUSER_MARK",
    JIJI_BROWSER_PROXY_PASSWORD: "FAKEPASS_MARK",
  });
  const plans = new ApprovalPlans();
  const plan = plans.prepare({ type: "jiji_message", message: "Hello" });
  const result = await plans.approve(plan.id, async () => {
    throw new Error(DIRTY + " FAKEPASS_MARK");
  });
  assert.equal(result.state, "uncertain");
  assert.doesNotMatch(JSON.stringify(result), MARKERS);
});
