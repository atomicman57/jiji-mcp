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
test("rejects cross-origin, contacts, and unsupported paths", () => {
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
    assert.equal((await x.client.listTools()).tools.length, 14);
    const call = async (name, args) =>
      JSON.parse(
        (await x.client.callTool({ name, arguments: args })).content[0].text,
      );
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
