import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/tools.mjs";
import { JijiBrowser } from "../src/browser-driver.mjs";
import { normalize, chatUrl } from "../src/protocol.mjs";
import { ApprovalPlans } from "../src/plans.mjs";
import { prepareMessageAction } from "../src/message-actions.mjs";

const advert = {
  guid: "abcdefgh12345678",
  title: "Example router",
  url: "/ikeja/networking-products/router-abcdefgh12345678.html",
};
const listing = "https://jiji.ng" + advert.url;
const room = "/profile-messages/7_12";
const key = "a".repeat(24);

async function withClient(request, fn) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(request);
  const client = new Client({ name: "mock-messaging", version: "1" });
  await server.connect(a);
  await client.connect(b);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

// Execute the actual browser-side filtering callback in an isolated fake page.
async function filteredDetail(raw) {
  const browser = new JijiBrowser("unused-mock-profile");
  browser.jijiPage = async () => ({
    evaluate: (fn, path) =>
      vm.runInNewContext(`(${fn})(path)`, {
        path,
        location: { origin: "https://jiji.ng" },
        AbortSignal,
        fetch: async () => ({
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify(raw),
        }),
      }),
  });
  return browser.fetch(`/api_web/v1/item/${advert.guid}?webp=true`);
}

test("browser filtering preserves alternate seller identity and chat fields without leaking secrets", async () => {
  for (const raw of [
    {
      advert: {
        ...advert,
        message_url: "https://jiji.ng" + room + "/?source=advert",
      },
      seller: {
        user_name: " Example seller ",
        start_chat_form: { csrf: "secret" },
        phone: "private",
      },
    },
    {
      advert: {
        ...advert,
        seller: { name: "Example seller", chat_url: room, phone: "private" },
      },
      seller: null,
    },
    {
      advert,
      seller: {
        full_name: "Example seller",
        message_url: room,
        token: "secret",
      },
    },
  ]) {
    const result = await filteredDetail(raw);
    assert.equal(result.status, 200);
    const value = normalize(result.body.advert, result.body.seller);
    assert.equal(value.seller.name, "Example seller");
    assert.equal(value.chat_url, room);
    assert.equal(
      /secret|private|start_chat_form/.test(JSON.stringify(result)),
      false,
    );
  }
  assert.equal(normalize(advert, null).seller.name, null);
  assert.equal(
    normalize({ ...advert, user_id: 7, id: 12 }).chat_url,
    null,
    "never guess room IDs",
  );
});

test("chat routes reject external, credentialed and incomplete targets", () => {
  for (const value of [
    null,
    {},
    "/profile-messages",
    "/profile-messages/a/b",
    "//evil.test" + room,
    "https://jiji.ng.evil.test" + room,
    "https://user:pass@jiji.ng" + room,
    room + "#other",
  ])
    assert.equal(chatUrl(value), null);
  assert.equal(
    chatUrl("https://jiji.ng/profile-messages/room-with-hyphens/?new=1"),
    "/profile-messages/room-with-hyphens",
  );
});

test("listing preparation uses filtered identity, read-only fallback, and fails closed on missing targets", async () => {
  for (const fallback of [false, true]) {
    const seen = [];
    const response = await filteredDetail({
      advert: { ...advert, ...(fallback ? {} : { message_url: room }) },
      seller: { user_name: "Example seller" },
    });
    await withClient(
      async (m) => {
        seen.push(m);
        if (m.action === "fetch") return response;
        if (m.action === "resolve_listing_target")
          return { chat_url: room, seller: "Example seller" };
        if (m.action === "prepare_message")
          return {
            ...m.plan,
            state: "pending",
            approval_url: "http://127.0.0.1/approve/mock",
          };
        assert.fail("Unexpected action " + m.action);
      },
      async (client) => {
        const result = await client.callTool({
          name: "jiji_prepare_message",
          arguments: { guid: advert.guid, message: "Exact message" },
        });
        assert.ok(!result.isError, result.content[0].text);
        const plan = JSON.parse(result.content[0].text);
        assert.equal(plan.chat_url, room);
        assert.equal(plan.seller, "Example seller");
        assert.equal(plan.message, "Exact message");
        assert.equal(
          seen.some((m) => m.action === "resolve_listing_target"),
          fallback,
        );
        assert.equal(seen.at(-1).action, "prepare_message");
      },
    );
  }
  await withClient(
    async (m) => {
      if (m.action === "fetch") return { status: 200, body: { advert } };
      if (m.action === "resolve_listing_target") return {};
      assert.fail("Cannot prepare an unresolved target");
    },
    async (client) => {
      const r = await client.callTool({
        name: "jiji_prepare_message",
        arguments: { guid: advert.guid },
      });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /no verified chat target/);
    },
  );
});

test("listing-page fallback rejects redirects and ambiguous or external chat links", async () => {
  const browser = new JijiBrowser("unused-mock-profile");
  browser.listingRoom = async () => null;
  for (const chats of [
    [room],
    ["https://evil.test" + room],
    [room, "/profile-messages/other"],
  ]) {
    browser.go = async (path) => {
      assert.equal(path, advert.url);
      return {
        url: () => listing,
        locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
        evaluate: async () => ({ chats, seller: "Example seller" }),
      };
    };
    if (chats.length === 1 && chats[0] === room)
      assert.deepEqual(await browser.resolveListingTarget(listing), {
        chat_url: room,
        seller: "Example seller",
      });
    else if (chats.length > 1)
      await assert.rejects(
        browser.resolveListingTarget(listing),
        /no unique verified/,
      );
    else
      assert.equal(
        (await browser.resolveListingTarget(listing)).chat_url,
        null,
      );
  }
  browser.go = async () => ({ url: () => "https://jiji.ng/login.html" });
  await assert.rejects(browser.resolveListingTarget(listing), /redirected/);
});

test("existing-conversation tool creates the same pending one-time approval plan without sending", async () => {
  const browser = new JijiBrowser("unused-mock-profile");
  const store = new ApprovalPlans();
  const seen = [];
  browser.send = () => assert.fail("Must never send during preparation");
  browser.openConversation = async (requestedKey) => {
    assert.equal(requestedKey, key);
    return {
      item: { seller: "Example seller", title: advert.title },
      page: {
        url: () => "https://jiji.ng" + room,
        locator: () => ({
          evaluateAll: async () => [{ url: listing, title: advert.title }],
        }),
      },
    };
  };
  await withClient(
    async (m) => {
      seen.push(m);
      if (m.action === "plan_status") return store.public(store.get(m.id));
      assert.equal(m.action, "prepare_conversation_message");
      const plan = await prepareMessageAction(browser, store, m);
      return { ...plan, approval_url: "http://127.0.0.1/approve/" + plan.id };
    },
    async (client) => {
      const tools = (await client.listTools()).tools;
      assert.ok(!tools.some((t) => /approve|^jiji_send/.test(t.name)));
      for (const args of [
        { key: "invalid", message: "Hello" },
        { key, message: "  " },
        { key, message: "x".repeat(4001) },
      ])
        assert.equal(
          (
            await client.callTool({
              name: "jiji_prepare_conversation_message",
              arguments: args,
            })
          ).isError,
          true,
        );
      assert.equal(seen.length, 0);
      const result = await client.callTool({
        name: "jiji_prepare_conversation_message",
        arguments: { key, message: "  Exact reply\n" },
      });
      assert.ok(!result.isError, result.content[0].text);
      const plan = JSON.parse(result.content[0].text);
      assert.equal(plan.type, "jiji_message");
      assert.equal(plan.state, "pending");
      assert.equal(plan.message, "  Exact reply\n");
      assert.equal(plan.listing_url, listing);
      assert.equal(plan.seller, "Example seller");
      assert.match(plan.approval_url, /\/approve\//);
      assert.equal(store.get(plan.id).chat_url, room);
      assert.ok(store.get(plan.id).expires > Date.now());
      const status = await client.callTool({
        name: "jiji_message_status",
        arguments: { id: plan.id },
      });
      assert.equal(JSON.parse(status.content[0].text).state, "pending");
      assert.equal(store.plans.size, 1);
    },
  );
});

test("conversation preparation rejects stale, ambiguous and missing listing targets", async () => {
  const browser = new JijiBrowser("unused-mock-profile");
  await assert.rejects(
    browser.prepareConversationMessage(key, "Hello"),
    /reference expired/,
  );
  for (const links of [
    [],
    [
      { url: listing, title: advert.title },
      { url: "https://jiji.ng/other.html", title: advert.title },
    ],
  ]) {
    browser.openConversation = async () => ({
      item: { seller: "Seller", title: advert.title },
      page: {
        url: () => "https://jiji.ng" + room,
        locator: () => ({ evaluateAll: async () => links }),
      },
    });
    await assert.rejects(
      browser.prepareConversationMessage(key, "Hello"),
      /identified uniquely/,
    );
  }
  const store = new ApprovalPlans();
  await assert.rejects(
    prepareMessageAction(browser, store, {
      action: "prepare_message",
      plan: {
        seller: "Seller",
        listing_url: listing,
        chat_url: "https://evil.test" + room,
        message: "Hello",
      },
    }),
    /incomplete/,
  );
  assert.equal(store.plans.size, 0);
});

test("conversation navigation matches seller/title exactly and rejects duplicate rows", async () => {
  const browser = new JijiBrowser("unused-mock-profile");
  browser.conversations.set(key, { seller: "Seller", title: "Router" });
  let clicked;
  let rows = [
    { seller: "Seller Plus", title: "Router" },
    { seller: "Seller", title: "Router" },
  ];
  const labels = {
    first: () => ({ waitFor: async () => {} }),
    evaluateAll: async (fn, item) =>
      fn(
        rows.map((row) => ({
          querySelector: (selector) => ({
            textContent: selector.endsWith("-name") ? row.seller : row.title,
          }),
        })),
        item,
      ),
    nth: (index) => ({
      click: async () => {
        clicked = index;
      },
    }),
  };
  browser.go = async () => ({
    locator: (selector) =>
      selector === ".qa-room-label-link" ? labels : { waitFor: async () => {} },
    waitForURL: async (predicate) =>
      assert.equal(predicate(new URL("https://jiji.ng" + room)), true),
  });
  await browser.openConversation(key);
  assert.equal(clicked, 1);
  rows = [
    { seller: "Seller", title: "Router" },
    { seller: "Seller", title: "Router" },
  ];
  clicked = undefined;
  await assert.rejects(browser.openConversation(key), /identified uniquely/);
  assert.equal(clicked, undefined);
});

test("changed chat target stops before any editor or mutation", async () => {
  const browser = new JijiBrowser("unused-mock-profile");
  browser.go = async () => ({
    url: () => "https://jiji.ng/profile-messages/wrong",
    locator: () => assert.fail("Cannot touch an editor for a different chat"),
  });
  await assert.rejects(
    browser.send({ chat_url: room, listing_url: listing, message: "Hello" }),
    /target changed/,
  );
});

test("listing form URLs resolve through verified room IDs and exact advert URLs across pages", async () => {
  const browser = new JijiBrowser("unused-mock-profile");
  const seen = [];
  browser.go = () =>
    assert.fail("An existing room needs no listing-page navigation");
  browser.send = () => assert.fail("Resolution never sends");
  browser.catalogRequest = async (request) => {
    seen.push(request);
    assert.equal(request.method, undefined, "only GET is allowed");
    return {
      status: 200,
      body: {
        status: "ok",
        results:
          seen.length === 1
            ? [
                {
                  room_id: 1,
                  advert: { url: "/other.html", title: advert.title },
                  user: { user_name: "Other seller" },
                },
              ]
            : [
                {
                  room_id: 116980747,
                  advert: { url: advert.url },
                  user: { user_name: " Example seller " },
                },
              ],
        next_url:
          seen.length === 1
            ? "/api_web/v1/chat/rooms.json?page=2&sort=active"
            : null,
      },
    };
  };
  const detail = normalize(
    { ...advert, message_url: advert.url + "?show_message=1" },
    { name: "Example seller" },
  );
  assert.equal(detail.chat_url, null, "a message form URL is not a room ID");
  assert.deepEqual(await browser.resolveListingTarget(detail.url), {
    chat_url: "/profile-messages/116980747",
    seller: "Example seller",
  });
  assert.deepEqual(
    seen.map((r) => r.path),
    [
      "/api_web/v1/chat/rooms.json",
      "/api_web/v1/chat/rooms.json?page=2&sort=active",
    ],
  );
});

test("room lookup rejects ambiguous matches, malformed IDs, challenges, and unsafe or repeated pagination", async () => {
  const browser = new JijiBrowser("unused-mock-profile");
  const row = {
    room_id: 123,
    advert: { url: listing },
    user: { user_name: "Seller" },
  };
  for (const [response, error] of [
    [
      {
        status: 200,
        body: { status: "ok", results: [row, { ...row, room_id: 456 }] },
      },
      /no unique verified/,
    ],
    [
      {
        status: 200,
        body: { status: "ok", results: [{ ...row, room_id: "../../other" }] },
      },
      /invalid conversation ID/,
    ],
    [{ status: 403 }, /unavailable/],
    [
      {
        status: 200,
        body: {
          status: "ok",
          results: [],
          next_url: "https://evil.test/api_web/v1/chat/rooms.json",
        },
      },
      /pagination target/,
    ],
    [
      {
        status: 200,
        body: {
          status: "ok",
          results: [],
          next_url: "/api_web/v1/chat/rooms.json",
        },
      },
      /incomplete/,
    ],
  ]) {
    let calls = 0;
    browser.catalogRequest = async () => {
      calls++;
      return response;
    };
    await assert.rejects(browser.listingRoom(listing), error);
    assert.equal(calls, 1, "fail without retries or unsafe next requests");
  }
});

test("active conversation header includes price and ignores quoted or preview links", async () => {
  const browser = new JijiBrowser("unused-mock-profile");
  const page = {
    locator(selector) {
      assert.equal(
        selector,
        "a.b-messenger-room-advert-info-link",
        "only the active advert header is authoritative",
      );
      return {
        evaluateAll: async (fn) =>
          fn([{ href: listing, textContent: advert.title + "₦ 78,000" }]),
      };
    },
  };
  assert.equal(await browser.conversationListing(page), listing);
  browser.openConversation = async () => ({
    page: { ...page, url: () => "https://jiji.ng" + room },
    item: { seller: "Seller", title: advert.title },
  });
  const plan = await browser.prepareConversationMessage(
    key,
    "MCP verification only. Do not send.",
  );
  assert.equal(plan.listing_url, listing);
  assert.equal(plan.chat_url, room);
});
