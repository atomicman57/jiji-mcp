import { test } from "node:test";
import assert from "node:assert/strict";
test("browser bridge keeps requests on Jiji and strips account/contact fields", async () => {
  let listener, nativeListener, resolveResult;
  const messages = [];
  const event = () => ({ addListener() {} });
  const native = {
    onMessage: {
      addListener(f) {
        nativeListener = f;
      },
    },
    onDisconnect: event(),
    postMessage(m) {
      messages.push(m);
      resolveResult?.(m);
    },
    disconnect() {},
  };
  globalThis.location = { origin: "https://jiji.ng" };
  globalThis.chrome = {
    runtime: {
      id: "test",
      connectNative: () => native,
      onMessage: {
        addListener(f) {
          listener = f;
        },
      },
      onStartup: event(),
      onInstalled: event(),
    },
    storage: { local: { get: async () => ({}) } },
    tabs: {
      query: async () => [{ id: 1, active: true }],
      create: async () => {},
    },
    scripting: {
      executeScript: async ({ func, args }) => [
        { result: await func(...args) },
      ],
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.match(url, /^\/api_web\/v1\/item\//);
    assert.equal(options.credentials, "include");
    return Response.json({
      advert: {
        guid: "abcdefgh12345678",
        title: "Router",
        url: "/router.html",
        admin_info: { private: "secret" },
        is_fav: true,
      },
      seller: {
        id: 7,
        name: "Seller",
        phone: "private-phone",
        user_phones: ["private-phone"],
        start_chat_form: { token: "secret" },
      },
      notifications: { private: "secret" },
    });
  };
  try {
    await import("../extension/background.js");
    await new Promise((resolve) =>
      listener({ action: "connect" }, { id: "test" }, resolve),
    );
    const result = await new Promise((resolve) => {
      resolveResult = resolve;
      nativeListener({
        id: "request1",
        action: "fetch",
        path: "/api_web/v1/item/abcdefgh12345678?webp=true",
      });
    });
    assert.equal(result.body.seller.name, "Seller");
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    const rejected = await new Promise((resolve) => {
      resolveResult = resolve;
      nativeListener({
        id: "request2",
        action: "fetch",
        path: "https://evil.example/api_web/v1/listing",
      });
    });
    assert.match(rejected.error, /Only Jiji/);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.chrome;
    delete globalThis.location;
  }
});
