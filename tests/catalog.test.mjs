import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRead,
  buildAction,
  featureMap,
  workflows,
} from "../src/catalog.mjs";
import { JijiBrowser } from "../src/browser-driver.mjs";
test("catalog separates account reads, owner-approved changes and sensitive handoffs", () => {
  const c = featureMap();
  assert.ok(c.read_resources.some((x) => x.name === "order"));
  assert.ok(c.owner_approved_actions.some((x) => x.name === "publish_advert"));
  for (const name of [
    "password",
    "identity",
    "delete_account",
    "balance",
    "orders",
    "pro_sales",
  ])
    assert.equal(workflows[name].mode, "owner_handoff");
  for (const name of ["pay", "withdraw", "change_password", "delete_account"])
    assert.throws(() => buildAction(name, {}), /Unknown action/);
  assert.match(
    buildRead("order", { guid: "abcdefgh12345678" }).path,
    /delivery\/order-info/,
  );
  assert.throws(() => buildRead("order", { guid: "https://evil.example" }));
  assert.throws(() =>
    buildRead("personal_details", { next_url: "https://evil.example" }),
  );
});
test("action bodies are fixed and reject credentials, paid packages and prototype keys", () => {
  const follow = buildAction("follow_seller", { id: 7 });
  assert.deepEqual(follow.body, { user_id: 7, is_follow: true });
  assert.equal(follow.method, "POST");
  for (const details of [
    { password: "x" },
    { nested: { access_token: "x" } },
    { paid_package: 3 },
    JSON.parse('{"__proto__":{"x":true}}'),
  ])
    assert.throws(() => buildAction("update_business", { details }));
  assert.throws(() => buildAction("follow_seller", { id: "../other" }));
});
test("catalog responses strip credentials before leaving the browser", async () => {
  const driver = new JijiBrowser("/unused-test-profile");
  driver.jijiPage = async () => ({ evaluate: async (fn, arg) => fn(arg) });
  const oldFetch = globalThis.fetch,
    oldLocation = globalThis.location;
  globalThis.location = { origin: "https://jiji.ng" };
  globalThis.fetch = async (path, options) => {
    assert.equal(options.credentials, "include");
    assert.equal(path, "/api_web/v1/profile/contact-details.json");
    return Response.json({
      name: "Example",
      token: "private-token",
      session: { secret: "private-session" },
      email: "owner@example.test",
      nested: { password: "private-password" },
      fields: [{ name: "otp", value: "private-code" }],
    });
  };
  try {
    const result = await driver.readResource("personal_details", {});
    const text = JSON.stringify(result);
    assert.equal(result.body.name, "Example");
    assert.ok(!text.includes("private-"));
    assert.equal(result.body.fields[0].owner_only, true);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.location = oldLocation;
  }
});
test("account research omits embedded seller contacts but preserves owner details", async () => {
  const driver = new JijiBrowser("/unused-test-profile");
  driver.jijiPage = async () => ({ evaluate: async (fn, arg) => fn(arg) });
  const oldFetch = globalThis.fetch,
    oldLocation = globalThis.location;
  globalThis.location = { origin: "https://jiji.ng" };
  globalThis.fetch = async () =>
    Response.json({
      adverts: [
        {
          user_phone: "+2348000000000",
          phoneNumber: "08000000000",
          title: "Example",
        },
      ],
      results: [{ advert: { phone: "08000000000", show_contact_on: true } }],
      link: "https://wa.me/2348000000000",
      fields: [{ name: "phone", value: "08000000000" }],
      email: "owner@example.test",
    });
  try {
    for (const resource of ["saved_adverts", "chat_rooms"]) {
      driver.lastRequest = 0;
      const { body } = await driver.readResource(resource, {});
      assert.equal(body.adverts[0].title, "Example");
      assert.equal(body.results[0].advert.show_contact_on, true);
      assert.equal(body.fields[0].selected_contact_required, true);
      assert.ok(!JSON.stringify(body).includes("8000000000"));
      assert.ok(!JSON.stringify(body).includes("owner@example.test"));
    }
    driver.lastRequest = 0;
    const { body } = await driver.readResource("personal_details", {});
    assert.equal(body.email, "owner@example.test");
    assert.equal(body.fields[0].value, "08000000000");
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.location = oldLocation;
  }
});
test("advert approval preserves create vs edit and refuses changed draft identity", async () => {
  const browser = new JijiBrowser("/unused-test-profile");
  const calls = [];
  browser.readResource = async (name, args) => {
    calls.push(name);
    return {
      status: 200,
      body:
        name === "advert_category_fields"
          ? {
              fields: [
                { name: "title" },
                { name: "description" },
                { name: "price" },
              ],
            }
          : {
              params: {
                advert_id: 12,
                modify_advert_url: "/api_web/v1/item/modify/12.json",
              },
              fields: [{ name: "title" }],
            },
    };
  };
  const prepared = await browser.prepareAdvert({
    category_id: 3,
    region_id: 4,
    fields: { title: "Example", description: "Example listing", price: 100 },
  });
  assert.equal(prepared.parameters.editing, false);
  browser.catalogRequest = async (request) => {
    assert.equal(request.method, "POST");
    assert.match(request.path, /modify\/12/);
    return { status: 200, body: { status: "ok" } };
  };
  assert.equal(
    (await browser.executeAdvert(prepared.parameters)).submitted,
    true,
  );
  assert.ok(!calls.includes("advert_edit_form"));
  await assert.rejects(
    browser.prepareAdvert({ ...prepared.parameters, advert_id: 13 }),
    /form changed/,
  );
  await assert.rejects(
    browser.prepareAdvert({
      category_id: 3,
      region_id: 4,
      fields: { title: "Example", paid_package: 7 },
    }),
    /payment authorization/,
  );
});
test("checking login status cannot redirect an active sign-in provider", async () => {
  const browser = new JijiBrowser("/unused-test-profile");
  browser.context = {};
  browser.page = {
    url: () => "https://accounts.google.com/signin",
    isClosed: () => false,
  };
  const state = await browser.status();
  assert.equal(state.login_in_progress, true);
  assert.equal(state.signed_in, false);
});

test("native offers require the approved listing and a confirmed Jiji response", async () => {
  const browser = new JijiBrowser("/unused-test-profile");
  const plan = {
    chat_url: "/profile-messages/7_12",
    listing_url: "https://jiji.ng/example.html",
    offer_amount: 100,
    message: "",
  };
  let matching = false,
    calls = 0;
  browser.go = async () => ({
    url: () => "https://jiji.ng/profile-messages/7_12",
    locator: (selector) =>
      selector === "a.b-messenger-room-advert-info-link"
        ? {
            evaluateAll: async () =>
              matching ? [{ url: plan.listing_url }] : [],
          }
        : { waitFor: async () => {} },
  });
  browser.catalogRequest = async (request) => {
    calls++;
    assert.equal(request.path, "/api_web/v1/chat/room/7_12.json");
    assert.equal(request.body.make_an_offer, 100);
    assert.match(request.body.client_msg_id, /^[a-f0-9-]+$/);
    return { status: 200, body: { status: "ok" } };
  };
  await assert.rejects(browser.send(plan), /identified uniquely/);
  assert.equal(calls, 0);
  matching = true;
  assert.equal((await browser.send(plan)).sent, true);
  browser.catalogRequest = async () => ({
    status: 200,
    body: { status: "error" },
  });
  await assert.rejects(browser.send(plan), /did not confirm/);
});
test("saved-search and history changes use mapped approval actions", () => {
  assert.deepEqual(
    buildAction("save_search", {
      search_params: { query: "router", region_id: 3 },
    }).body,
    { search_params: { query: "router", region_id: 3 } },
  );
  assert.deepEqual(buildAction("unsubscribe_search", { id: 12 }).body, {
    user_search_id: 12,
  });
  assert.equal(buildAction("clear_recently_viewed").method, "DELETE");
  assert.match(
    buildRead("order", { guid: "12345678-1234-1234-1234-123456789abc" }).path,
    /order-info/,
  );
});
