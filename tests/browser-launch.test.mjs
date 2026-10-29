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
