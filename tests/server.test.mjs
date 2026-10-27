import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/tools.mjs";
import { validatePath, normalize } from "../src/protocol.mjs";
async function setup(request) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(request);
  const client = new Client({ name: "test", version: "1" });
  await server.connect(a);
  await client.connect(b);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}
const advert = {
  guid: "abcdefgh12345678",
  title: "Router",
  url: "/ikeja/networking-products/router-abcdefgh12345678.html?tracking=1",
  price_obj: { value: 20 },
  user_id: 7,
};
test("rejects cross-origin and unsupported paths", () => {
  for (const url of [
    "https://evil.test/api_web/v1/listing",
    "//evil.test/api_web/v1/listing",
    "/api_web/v1/item/../../profile",
    "/api_web/v1/listing?redirect=evil",
    "https://x:y@jiji.ng/api_web/v1/listing",
  ])
    assert.throws(() => validatePath(url));
  assert.equal(
    validatePath("https://jiji.ng/api_web/v1/listing?crsr=abc&lsmid=123"),
    "/api_web/v1/listing?crsr=abc&lsmid=123",
  );
});
test("normalization excludes private account and contact fields", () => {
  const out = normalize(
    { ...advert, cookies: "secret" },
    {
      name: "Seller",
      phone: "private",
      user_phones: ["private"],
      start_chat_form: { secret: "x" },
    },
  );
  assert.equal(out.seller.name, "Seller");
  assert.equal(JSON.stringify(out).includes("private"), false);
  assert.equal(
    out.url,
    "https://jiji.ng/ikeja/networking-products/router-abcdefgh12345678.html",
  );
});
test("MCP lists tools, paginates with authoritative URL, and reads details", async () => {
  const paths = [];
  const next =
    "https://jiji.ng/api_web/v1/listing?query=router&page=2&crsr=opaque&lsmid=session";
  const x = await setup(async (m) => {
    paths.push(m);
    return {
      status: 200,
      body: m.path?.includes("/item/")
        ? { advert, seller: { name: "Seller", phone: "hidden" } }
        : {
            adverts_list: { count: 2, adverts: [advert, advert] },
            next_url: next,
          },
    };
  });
  try {
    assert.equal((await x.client.listTools()).tools.length, 22);
    const call = async (name, args) => {
      const result = await x.client.callTool({ name, arguments: args });
      const data = JSON.parse(result.content[0].text);
      assert.deepEqual(result.structuredContent, { data });
      return data;
    };
    const found = await call("jiji_search", { query: "router" });
    assert.equal(found.results.length, 1);
    await call("jiji_next_page", { cursor: found.next_cursor });
    assert.equal(paths[1].path, new URL(next).pathname + new URL(next).search);
    const details = await call("jiji_listing_details", { guid: advert.guid });
    assert.equal(details.seller.name, "Seller");
    assert.equal(JSON.stringify(details).includes("hidden"), false);
  } finally {
    await x.close();
  }
});
test("access restrictions return actionable errors without retry", async () => {
  let count = 0;
  const x = await setup(async () => {
    count++;
    return { status: 403 };
  });
  try {
    const r = await x.client.callTool({
      name: "jiji_search",
      arguments: { query: "router" },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /403/);
    assert.equal(count, 1);
  } finally {
    await x.close();
  }
});
test("small search limits retain every item, including the final server page", async () => {
  const adverts = Array.from({ length: 7 }, (_, index) => ({
    ...advert,
    guid: `listing0000000${index}`,
  }));
  const next = "/api_web/v1/listing?query=router&page=2&crsr=authoritative";
  for (const hasNext of [false, true]) {
    const paths = [];
    const x = await setup(async (m) => {
      paths.push(m.path);
      return {
        status: 200,
        body: {
          adverts_list: {
            count: hasNext ? 7 : 5,
            adverts: m.path === next ? adverts.slice(5) : adverts.slice(0, 5),
          },
          next_url: m.path !== next && hasNext ? next : null,
        },
      };
    });
    try {
      const call = async (name, args) => {
        const r = await x.client.callTool({ name, arguments: args });
        assert.ok(!r.isError);
        return JSON.parse(r.content[0].text);
      };
      let result = await call("jiji_search", { query: "router", limit: 2 });
      assert.equal(result.remaining_on_page, 3);
      const ids = result.results.map((a) => a.guid);
      let pages = 1;
      while (result.next_cursor) {
        assert.ok(pages++ < 5, "pagination must finish");
        result = await call("jiji_next_page", {
          cursor: result.next_cursor,
          limit: 2,
        });
        ids.push(...result.results.map((a) => a.guid));
        if (ids.length <= 5)
          assert.equal(
            paths.length,
            1,
            "same-page remainder needs no additional Jiji request",
          );
      }
      assert.deepEqual(
        ids,
        adverts.slice(0, hasNext ? 7 : 5).map((a) => a.guid),
      );
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(paths.length, hasNext ? 2 : 1);
      if (hasNext) assert.equal(paths[1], next);
    } finally {
      await x.close();
    }
  }
});
test("native attribute filters reach search, pagination and market-price samples", async () => {
  const paths = [];
  const next =
    "/api_web/v1/listing?query=panel&page=2&filter_attr_1484_condition=Used&crsr=opaque";
  const x = await setup(async (m) => {
    paths.push(m.path);
    return {
      status: 200,
      body: { adverts_list: { count: 1, adverts: [advert] }, next_url: next },
    };
  });
  try {
    const args = {
      query: "panel",
      category_slug: "solar-energy-products",
      filters: {
        filter_attr_1484_condition: "Used",
        filter_attr_2330_brand: ["A&B", "Example"],
      },
      region_id: 1,
    };
    const search = await x.client.callTool({
      name: "jiji_search",
      arguments: args,
    });
    assert.ok(!search.isError);
    const url = new URL(paths[0], "https://jiji.ng");
    assert.equal(url.searchParams.get("filter_attr_1484_condition"), "Used");
    assert.deepEqual(url.searchParams.getAll("filter_attr_2330_brand"), [
      "A&B",
      "Example",
    ]);
    assert.equal(url.searchParams.get("region_id"), "1");
    assert.equal(url.searchParams.get("slug"), "solar-energy-products");
    assert.equal(url.searchParams.has("B"), false);
    const result = JSON.parse(search.content[0].text);
    assert.ok(
      !(
        await x.client.callTool({
          name: "jiji_next_page",
          arguments: { cursor: result.next_cursor },
        })
      ).isError,
    );
    assert.equal(paths[1], next);
    const prices = await x.client.callTool({
      name: "jiji_market_prices",
      arguments: args,
    });
    assert.ok(!prices.isError);
    assert.equal(
      new URL(paths[2], "https://jiji.ng").searchParams.get(
        "filter_attr_1484_condition",
      ),
      "Used",
    );
    const calls = paths.length;
    const unscoped = await x.client.callTool({
      name: "jiji_search",
      arguments: {
        query: "panel",
        filters: { filter_attr_1484_condition: "Used" },
      },
    });
    assert.equal(unscoped.isError, true);
    assert.match(unscoped.content[0].text, /require category_slug/);
    for (const filters of [
      { query: "override" },
      { redirect: "https://evil.test" },
      { filter_attr_1484_condition: "" },
    ]) {
      assert.equal(
        (
          await x.client.callTool({
            name: "jiji_search",
            arguments: { query: "panel", filters },
          })
        ).isError,
        true,
      );
    }
    assert.equal(paths.length, calls);
  } finally {
    await x.close();
  }
});
test("unknown cursors and changed schemas fail closed", async () => {
  const x = await setup(async () => ({
    status: 200,
    body: { unexpected: true },
  }));
  try {
    for (const [name, args] of [
      ["jiji_search", { query: "router" }],
      ["jiji_next_page", { cursor: "8abc051b-8410-4985-9b41-be8b41642804" }],
    ])
      assert.equal(
        (await x.client.callTool({ name, arguments: args })).isError,
        true,
      );
  } finally {
    await x.close();
  }
});
