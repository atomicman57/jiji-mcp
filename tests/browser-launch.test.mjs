import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { JijiBrowser } from "../src/browser-driver.mjs";

test("a failed browser launch surfaces a fixed message without Playwright text", async (t) => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "jiji-launch-"));
  const original = chromium.launchPersistentContext;
  const originalError = console.error;
  const logged = [];
  chromium.launchPersistentContext = async () => {
    throw new Error(
      "net::ERR_PROXY_CONNECTION_FAILED at https://secret-user:secret-pass@ng13.proxy.example:89",
    );
  };
  console.error = (...args) => logged.push(args.join(" "));
  t.after(async () => {
    chromium.launchPersistentContext = original;
    console.error = originalError;
    await fs.rm(profile, { recursive: true, force: true });
  });
  const browser = new JijiBrowser(profile);
  await assert.rejects(browser.open(), (error) => {
    assert.equal(error.message, "browser launch failed (check proxy config)");
    assert.doesNotMatch(error.message, /secret|proxy\.example|ERR_PROXY/);
    return true;
  });
  assert.equal(browser.context, null);
  assert.doesNotMatch(logged.join("\n"), /secret|proxy\.example|ERR_PROXY/);
});

test("a failed startup navigation closes the browser and reports a fixed status", async (t) => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "jiji-launch-"));
  const original = chromium.launchPersistentContext;
  const originalError = console.error;
  const logged = [];
  const raw =
    "page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://jiji.ng/ via http://secret-user:secret-pass@ng13.proxy.example:89";
  let closed = 0;
  let closeHandler;
  const page = {
    isClosed: () => false,
    url: () => "about:blank",
    goto: async () => {
      throw new Error(raw);
    },
  };
  const context = {
    pages: () => [],
    newPage: async () => page,
    on: (event, handler) => {
      if (event === "close") closeHandler = handler;
    },
    close: async () => {
      closed += 1;
      closeHandler?.();
    },
  };
  chromium.launchPersistentContext = async () => context;
  console.error = (...args) => logged.push(args.join(" "));
  t.after(async () => {
    chromium.launchPersistentContext = original;
    console.error = originalError;
    await fs.rm(profile, { recursive: true, force: true });
  });
  const leak = /secret|proxy\.example|ERR_PROXY|net::|page\.goto/;
  const browser = new JijiBrowser(profile);
  await assert.rejects(browser.open(), (error) => {
    assert.equal(error.message, "browser launch failed (check proxy config)");
    assert.doesNotMatch(error.message, leak);
    return true;
  });
  assert.equal(closed, 1);
  assert.equal(browser.context, null);
  assert.equal(browser.page, null);
  const status = await browser.status();
  assert.equal(status.signed_in, false);
  assert.equal(status.browser_open, false);
  assert.equal(status.login_in_progress, undefined);
  assert.equal(status.last_error, "browser launch failed (check proxy config)");
  assert.doesNotMatch(JSON.stringify(status), leak);
  assert.doesNotMatch(logged.join("\n"), leak);
});

test("a failed reopen navigation closes the browser and reports a fixed status", async (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });
  let closed = 0;
  const browser = new JijiBrowser("/unused");
  browser.context = {
    pages: () => [],
    newPage: async () => ({
      isClosed: () => false,
      goto: async () => {
        throw new Error(
          "page.goto: Target page, context or browser has been closed",
        );
      },
    }),
    close: async () => {
      closed += 1;
    },
  };
  await assert.rejects(
    browser.open(),
    (error) => error.message === "browser launch failed (check proxy config)",
  );
  assert.equal(closed, 1);
  assert.equal(browser.context, null);
  const status = await browser.status();
  assert.equal(status.browser_open, false);
  assert.equal(status.last_error, "browser launch failed (check proxy config)");
});
