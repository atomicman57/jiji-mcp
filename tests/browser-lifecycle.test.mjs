import { test } from "node:test";
import assert from "node:assert/strict";
import { JijiBrowser } from "../src/browser-driver.mjs";

test("a closed Jiji tab reports closed and sign-in opens a replacement", async () => {
  const browser = new JijiBrowser("unused-test-profile");
  const visits = [];
  let foregrounded = false;
  const closed = { isClosed: () => true };
  const replacement = {
    isClosed: () => false,
    goto: async (url) => visits.push(url),
    bringToFront: async () => {
      foregrounded = true;
    },
  };
  browser.page = closed;
  browser.context = {
    pages: () => [closed],
    newPage: async () => replacement,
  };
  assert.equal((await browser.status()).browser_open, false);
  assert.equal((await browser.login()).opened, true);
  assert.deepEqual(visits, ["https://jiji.ng/", "https://jiji.ng/login.html"]);
  assert.equal(foregrounded, true);
  assert.equal(browser.page, replacement);
});

test("recovery preserves an existing sign-in provider page", async () => {
  const browser = new JijiBrowser("unused-test-profile");
  const provider = { isClosed: () => false };
  browser.page = { isClosed: () => true };
  browser.context = {
    pages: () => [browser.page, provider],
    newPage: async () => assert.fail("must preserve the active sign-in flow"),
  };
  assert.equal(await browser.open(), provider);
});
