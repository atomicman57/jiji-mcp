import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import {
  JijiBrowser,
  isCloudflareChallenge,
  isProxyFailure,
} from "../src/browser-driver.mjs";
import {
  browserLaunchOptions,
  browserProxyList,
} from "../src/runtime-policy.mjs";

const LAUNCH_FAILED = "browser launch failed (check proxy config)";
const LEAK =
  /secret|ERR_PROXY|ERR_TUNNEL|net::|page\.goto|Just a moment|cf-mitigated/;
const ENV_KEYS = [
  "JIJI_BROWSER_PROXY",
  "JIJI_BROWSER_PROXIES",
  "JIJI_BROWSER_PROXY_USERNAME",
  "JIJI_BROWSER_PROXY_PASSWORD",
  "JIJI_BROWSER_PROXY_BYPASS",
];

function response(status, headers = {}, body = "") {
  return {
    status: () => status,
    headers: () => headers,
    text: async () => body,
  };
}

// `plan` maps a proxy server to "launch" (launch throws), an Error (goto
// throws it) or a response-like object (goto resolves to it).
async function harness(t, env, plan) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "jiji-failover-"));
  const original = chromium.launchPersistentContext;
  const originalError = console.error;
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const logged = [];
  const attempts = [];
  const closed = [];
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  console.error = (...args) => logged.push(args.join(" "));
  chromium.launchPersistentContext = async (_profile, options) => {
    const server = options.proxy?.server;
    attempts.push(options.proxy);
    const step = plan[server];
    if (step === "launch")
      throw new Error(
        "browserType.launchPersistentContext: net::ERR_PROXY_CONNECTION_FAILED " +
          "http://secret-user:secret-pass@" +
          server,
      );
    let url = "about:blank";
    const page = {
      isClosed: () => false,
      url: () => url,
      title: async () => step?.title || "",
      goto: async (target) => {
        if (step instanceof Error) throw step;
        url = target;
        return step === undefined ? response(200) : step;
      },
      locator: () => ({ count: async () => 0 }),
      bringToFront: async () => {},
    };
    let closeHandler;
    return {
      pages: () => [],
      newPage: async () => page,
      on: (event, handler) => {
        if (event === "close") closeHandler = handler;
      },
      close: async () => {
        closed.push(server);
        closeHandler?.();
      },
    };
  };
  t.after(async () => {
    chromium.launchPersistentContext = original;
    console.error = originalError;
    for (const key of ENV_KEYS)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await fs.rm(profile, { recursive: true, force: true });
  });
  return { browser: new JijiBrowser(profile), attempts, closed, logged };
}

const A = "https://ng13.proxy.example:89";
const B = "https://ng14.proxy.example:89";
const C = "https://ng15.proxy.example:89";

test("a proxy-class launch failure fails over to the next entry", async (t) => {
  const { browser, attempts, closed, logged } = await harness(
    t,
    {
      JIJI_BROWSER_PROXIES: A + "," + B,
      JIJI_BROWSER_PROXY_USERNAME: "secret-user",
      JIJI_BROWSER_PROXY_PASSWORD: "secret-pass",
    },
    { [A]: "launch" },
  );
  await browser.open();
  assert.deepEqual(
    attempts.map((proxy) => proxy.server),
    [A, B],
  );
  assert.equal(attempts[1].username, "secret-user");
  assert.equal(browser.activeProxyIndex, 1);
  assert.deepEqual(closed, []);
  const status = await browser.status();
  assert.equal(status.browser_open, true);
  assert.equal(status.proxy_index, 1);
  assert.equal(status.proxy, "ng14.proxy.example:89");
  assert.equal(status.last_error, undefined);
  assert.doesNotMatch(JSON.stringify(status), LEAK);
  assert.doesNotMatch(logged.join("\n"), LEAK);
});

test("a proxy-class navigation failure closes that context and fails over", async (t) => {
  const { browser, attempts, closed } = await harness(
    t,
    { JIJI_BROWSER_PROXIES: [A, B, C].join("\n") },
    {
      [A]: new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED"),
      [B]: Object.assign(new Error("page.goto: Timeout 30000ms exceeded."), {
        name: "TimeoutError",
      }),
    },
  );
  await browser.open();
  assert.deepEqual(
    attempts.map((proxy) => proxy.server),
    [A, B, C],
  );
  assert.deepEqual(closed, [A, B]);
  assert.equal(browser.activeProxyIndex, 2);
  assert.equal((await browser.status()).proxy, "ng15.proxy.example:89");
});

test("every proxy failing leaves the browser closed with a generic error", async (t) => {
  const { browser, attempts, logged } = await harness(
    t,
    {
      JIJI_BROWSER_PROXIES:
        "https://secret-user:secret-pass@ng13.proxy.example:89," + B,
    },
    {
      [A]: "launch",
      [B]: new Error("page.goto: net::ERR_PROXY_AUTH_UNSUPPORTED via " + B),
    },
  );
  await assert.rejects(browser.open(), (error) => {
    assert.equal(error.message, LAUNCH_FAILED);
    return true;
  });
  assert.equal(attempts.length, 2);
  assert.equal(browser.context, null);
  assert.equal(browser.page, null);
  assert.equal(browser.activeProxyIndex, null);
  const status = await browser.status();
  assert.equal(status.browser_open, false);
  assert.equal(status.signed_in, false);
  assert.equal(status.last_error, LAUNCH_FAILED);
  assert.equal(status.proxy, undefined);
  assert.doesNotMatch(JSON.stringify(status), LEAK);
  assert.doesNotMatch(logged.join("\n"), LEAK);
});

test("a Cloudflare challenge on the first navigation fails over", async (t) => {
  const { browser, attempts, closed } = await harness(
    t,
    { JIJI_BROWSER_PROXIES: A + "," + B + "," + C },
    {
      [A]: response(403, { "CF-Mitigated": "challenge" }),
      [B]: response(
        503,
        {},
        '<html><div id="cf-browser-verification">Checking</div></html>',
      ),
    },
  );
  await browser.open();
  assert.deepEqual(
    attempts.map((proxy) => proxy.server),
    [A, B, C],
  );
  assert.deepEqual(closed, [A, B]);
  assert.equal(browser.activeProxyIndex, 2);
});

test("an ordinary Jiji error page does not switch proxies", async (t) => {
  const { browser, attempts } = await harness(
    t,
    { JIJI_BROWSER_PROXIES: A + "," + B },
    { [A]: response(500, { "cf-ray": "abc" }, "<h1>Server error</h1>") },
  );
  await browser.open();
  assert.equal(attempts.length, 1);
  assert.equal(browser.activeProxyIndex, 0);
  const status = await browser.status();
  assert.equal(status.proxy_index, 0);
  assert.equal(status.proxy, "ng13.proxy.example:89");
});

test("a non-proxy launch error does not fail over", async (t) => {
  const { browser, attempts } = await harness(
    t,
    { JIJI_BROWSER_PROXIES: A + "," + B },
    { [A]: new Error("page.goto: net::ERR_NAME_NOT_RESOLVED") },
  );
  await assert.rejects(browser.open(), { message: LAUNCH_FAILED });
  assert.equal(attempts.length, 1);
});

test("a partially invalid list is rejected before any launch", async (t) => {
  const { browser, attempts } = await harness(
    t,
    {
      JIJI_BROWSER_PROXIES:
        A + ",https://secret-user:secret-pass@ng14.proxy.example",
    },
    {},
  );
  await assert.rejects(browser.open(), (error) => {
    assert.equal(
      error.message,
      "JIJI_BROWSER_PROXIES entry 2 must include an explicit port.",
    );
    assert.doesNotMatch(error.message, /secret|proxy\.example/);
    return true;
  });
  assert.equal(attempts.length, 0);
});

test("a later proxy-class navigation failure moves to the next proxy and retries once", async (t) => {
  const { browser, attempts, closed } = await harness(
    t,
    { JIJI_BROWSER_PROXIES: A + "," + B },
    {},
  );
  await browser.open();
  const first = browser.page;
  first.goto = async () => {
    throw new Error(
      "page.goto: net::ERR_PROXY_CONNECTION_FAILED via http://secret-user:secret-pass@ng13.proxy.example:89",
    );
  };
  const page = await browser.go("/profile-messages");
  assert.notEqual(page, first);
  assert.equal(page.url(), "https://jiji.ng/profile-messages");
  assert.deepEqual(
    attempts.map((proxy) => proxy.server),
    [A, B],
  );
  assert.deepEqual(closed, [A]);
  assert.equal(browser.activeProxyIndex, 1);
  // The last entry has nowhere to go: a fixed error, never the raw text.
  page.goto = first.goto;
  await assert.rejects(browser.go("/profile-messages"), (error) => {
    assert.equal(
      error.message,
      "Jiji navigation failed through the browser proxy.",
    );
    return true;
  });
  assert.equal(attempts.length, 2);
});

const NAV_FAILED = "Jiji navigation failed through the browser proxy.";
const CREDENTIAL_LEAK = /secret-user|secret-pass|:secret-pass@/;

test("login navigation through a proxy never surfaces raw Playwright text", async (t) => {
  const { browser, attempts, logged } = await harness(
    t,
    { JIJI_BROWSER_PROXIES: A + "," + B },
    {},
  );
  await browser.open();
  const raw = new Error(
    "page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://jiji.ng/login.html via http://secret-user:secret-pass@ng13.proxy.example:89",
  );
  browser.page.goto = async () => {
    throw raw;
  };
  // Fails over to B, where the retry fails the same way.
  const original = chromium.launchPersistentContext;
  chromium.launchPersistentContext = async (...args) => {
    const context = await original(...args);
    const page = await context.newPage();
    let first = true;
    page.goto = async (target) => {
      if (first) {
        first = false;
        return response(200);
      }
      throw raw;
    };
    return context;
  };
  await assert.rejects(browser.login(), (error) => {
    assert.equal(error.message, NAV_FAILED);
    assert.doesNotMatch(error.message, CREDENTIAL_LEAK);
    return true;
  });
  assert.deepEqual(
    attempts.map((proxy) => proxy.server),
    [A, B],
  );
  assert.doesNotMatch(logged.join("\n"), CREDENTIAL_LEAK);
  assert.doesNotMatch(logged.join("\n"), LEAK);
  assert.doesNotMatch(JSON.stringify(await browser.status()), CREDENTIAL_LEAK);
});

test("login on the last proxy maps any navigation error to the fixed message", async (t) => {
  const { browser, attempts, logged } = await harness(
    t,
    { JIJI_BROWSER_PROXIES: A },
    {},
  );
  await browser.open();
  browser.page.goto = async () => {
    throw new Error(
      "page.goto: net::ERR_PROXY_CONNECTION_FAILED via http://secret-user:secret-pass@ng13.proxy.example:89",
    );
  };
  await assert.rejects(browser.login(), { message: NAV_FAILED });
  assert.equal(attempts.length, 1);
  assert.doesNotMatch(logged.join("\n"), CREDENTIAL_LEAK);
  assert.doesNotMatch(JSON.stringify(await browser.status()), CREDENTIAL_LEAK);
});

test("a non-proxy navigation error while proxied is fixed text and does not fail over", async (t) => {
  const { browser, attempts } = await harness(
    t,
    { JIJI_BROWSER_PROXIES: A + "," + B },
    {},
  );
  await browser.open();
  browser.page.goto = async () => {
    throw new Error(
      "page.goto: net::ERR_NAME_NOT_RESOLVED via http://secret-user:secret-pass@ng13.example:89",
    );
  };
  await assert.rejects(browser.go("/profile-messages"), (error) => {
    assert.equal(error.message, NAV_FAILED);
    return true;
  });
  assert.equal(attempts.length, 1);
  assert.equal(browser.activeProxyIndex, 0);
});

test("a navigation error without a proxy passes through unchanged", async (t) => {
  const { browser } = await harness(t, {}, {});
  await browser.open();
  browser.page.goto = async () => {
    throw new Error("page.goto: net::ERR_NAME_NOT_RESOLVED");
  };
  await assert.rejects(browser.go("/profile-messages"), {
    message: "page.goto: net::ERR_NAME_NOT_RESOLVED",
  });
});

test("the proxy list is capped at 16 entries without echoing values", () => {
  const entries = (count) =>
    Array.from(
      { length: count },
      (_, i) => "https://secret-user:secret-pass@ng" + i + ".proxy.example:89",
    ).join(",");
  assert.equal(
    browserProxyList({ JIJI_BROWSER_PROXIES: entries(16) }).length,
    16,
  );
  assert.throws(
    () => browserProxyList({ JIJI_BROWSER_PROXIES: entries(17) }),
    (error) =>
      error.message === "JIJI_BROWSER_PROXIES supports at most 16 entries." &&
      !/secret|proxy\.example/.test(error.message),
  );
});

test("proxy list parsing accepts comma or newline lists and names only the entry", () => {
  const list = browserProxyList({
    JIJI_BROWSER_PROXIES: A + ",\n" + B + "\r\n" + C + "\n",
    JIJI_BROWSER_PROXY_BYPASS: "localhost",
  });
  assert.deepEqual(
    list.map((proxy) => [proxy.server, proxy.display, proxy.bypass]),
    [
      [A, "ng13.proxy.example:89", "localhost"],
      [B, "ng14.proxy.example:89", "localhost"],
      [C, "ng15.proxy.example:89", "localhost"],
    ],
  );
  assert.deepEqual(browserProxyList({}), []);
  assert.deepEqual(
    browserProxyList({ JIJI_BROWSER_PROXY: A }).map((p) => p.display),
    ["ng13.proxy.example:89"],
  );
  // The alias and the override produce the same Playwright option, without display.
  assert.deepEqual(browserLaunchOptions({}, list[1]).proxy, {
    server: B,
    bypass: "localhost",
  });
  assert.equal("proxy" in browserLaunchOptions({}, null), false);

  const rejects = (env, message) =>
    assert.throws(
      () => browserProxyList(env),
      (error) =>
        error.message === message &&
        !/secret|proxy\.example/.test(error.message),
    );
  const empty =
    "JIJI_BROWSER_PROXIES must be a comma- or newline-separated URL list with no empty entries.";
  for (const value of [A + ",," + B, A + ",", "," + A, A + ", ,\n" + B])
    rejects({ JIJI_BROWSER_PROXIES: value }, empty);
  rejects(
    { JIJI_BROWSER_PROXY: A, JIJI_BROWSER_PROXIES: B },
    "JIJI_BROWSER_PROXY and JIJI_BROWSER_PROXIES cannot both be set.",
  );
  rejects(
    { JIJI_BROWSER_PROXY_BYPASS: "localhost" },
    "JIJI_BROWSER_PROXY_BYPASS requires JIJI_BROWSER_PROXY or JIJI_BROWSER_PROXIES.",
  );
  rejects(
    {
      JIJI_BROWSER_PROXIES:
        A + ",https://secret-user:secret-pass@ng14.proxy.example:89",
      JIJI_BROWSER_PROXY_USERNAME: "secret-env-user",
      JIJI_BROWSER_PROXY_PASSWORD: "secret-env-pass",
    },
    "JIJI_BROWSER_PROXIES entry 2 credentials must come from the URL or from JIJI_BROWSER_PROXY_USERNAME/PASSWORD, not both.",
  );
  rejects(
    { JIJI_BROWSER_PROXIES: A + ",https://ng14.proxy.example:0" },
    "JIJI_BROWSER_PROXIES entry 2 port must be an integer from 1 to 65535.",
  );
  rejects(
    {
      JIJI_BROWSER_PROXIES:
        "socks5://secret-user:secret-pass@ng13.proxy.example:1080",
    },
    "JIJI_BROWSER_PROXIES entry 1 socks proxies do not support credentials.",
  );
  rejects(
    { JIJI_BROWSER_PROXIES: A + "\nhttps://secret-user@ng14.proxy.example:89" },
    "JIJI_BROWSER_PROXIES entry 2 username and password must both be set or both be empty.",
  );
  rejects(
    { JIJI_BROWSER_PROXIES: A + ",ftp://ng14.proxy.example:21" },
    "JIJI_BROWSER_PROXIES entry 2 must be an http, https, socks4 or socks5 URL with only a host and port.",
  );
});

test("per-entry URL credentials and shared credentials stay separate", () => {
  const list = browserProxyList({
    JIJI_BROWSER_PROXIES:
      "https://url-user:url-pass@ng13.proxy.example:89," + B,
  });
  assert.deepEqual(
    list.map((proxy) => [proxy.username, proxy.password]),
    [
      ["url-user", "url-pass"],
      [undefined, undefined],
    ],
  );
  assert.doesNotMatch(JSON.stringify(list), /display/);
  assert.equal(list[0].display, "ng13.proxy.example:89");
});

test("proxy failure and Cloudflare challenge detection stay tight", () => {
  for (const message of [
    "net::ERR_PROXY_CONNECTION_FAILED",
    "net::ERR_TUNNEL_CONNECTION_FAILED",
    "net::ERR_PROXY_AUTH_UNSUPPORTED",
    "HTTP 407 Proxy Authentication Required",
    "page.goto: Timeout 30000ms exceeded.",
  ])
    assert.equal(isProxyFailure(new Error(message)), true, message);
  assert.equal(isProxyFailure({ name: "TimeoutError" }), true);
  assert.equal(isProxyFailure({ status: 407 }), true);
  for (const message of [
    "net::ERR_NAME_NOT_RESOLVED",
    "Target page, context or browser has been closed",
  ])
    assert.equal(isProxyFailure(new Error(message)), false, message);

  assert.equal(
    isCloudflareChallenge({
      status: 403,
      headers: { "cf-mitigated": "Challenge" },
    }),
    true,
  );
  assert.equal(
    isCloudflareChallenge({ status: 403, title: "Just a moment..." }),
    true,
  );
  assert.equal(
    isCloudflareChallenge({
      status: 403,
      title: "Attention Required! | Cloudflare",
    }),
    true,
  );
  assert.equal(
    isCloudflareChallenge({
      status: 503,
      body: '<div class="cf-browser-verification"></div>',
    }),
    true,
  );
  assert.equal(
    isCloudflareChallenge({ status: 500, headers: { "cf-ray": "abc" } }),
    false,
  );
  assert.equal(
    isCloudflareChallenge({
      status: 200,
      headers: { "cf-mitigated": "challenge" },
    }),
    false,
  );
  assert.equal(
    isCloudflareChallenge({
      status: 403,
      title: "Jiji.ng: just a moment of your time",
    }),
    false,
  );
  // Title and body matches still require a challenge status.
  assert.equal(
    isCloudflareChallenge({ status: 200, title: "Just a moment..." }),
    false,
  );
  assert.equal(
    isCloudflareChallenge({
      status: 200,
      body: '<div class="cf-browser-verification"></div>',
    }),
    false,
  );
  assert.equal(isCloudflareChallenge({ title: "Just a moment..." }), false);
  assert.equal(
    isCloudflareChallenge({ status: 429, title: "Just a moment..." }),
    true,
  );
});
