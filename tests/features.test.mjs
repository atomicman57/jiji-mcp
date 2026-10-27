import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/tools.mjs";
test("seller research, contacts, inbox and message preparation route without sending", async () => {
  const seen = [];
  const advert = {
    guid: "abcdefgh12345678",
    id: 12,
    title: "Example router",
    url: "/ikeja/networking-products/router-abcdefgh12345678.html",
    message_url: "/profile-messages/7_12",
    price_obj: { value: 100 },
    user_id: 7,
  };
  const request = async (m) => {
    seen.push(m);
    if (m.action === "prepare_message")
      return { id: "example-plan", state: "pending", sent: false, ...m.plan };
    if (m.action === "inbox")
      return {
        conversations: [{ key: "a".repeat(24), seller: "Example seller" }],
      };
    if (m.action === "conversation")
      return { messages: [{ text: "Available", direction: "inbound" }] };
    if (m.action === "fetch")
      return {
        status: 200,
        body: m.path.endsWith("_phone.json")
          ? { phones: ["08000000000"] }
          : m.path.includes("/item/")
            ? { advert, seller: { name: "Example seller", id: 7 } }
            : {
                adverts_list: {
                  count: 3,
                  adverts: [
                    advert,
                    {
                      ...advert,
                      guid: "ijklmnop12345678",
                      price_obj: { value: 200 },
                      user_id: 8,
                    },
                    {
                      ...advert,
                      guid: "qrstuvwx12345678",
                      price_obj: { value: 200 },
                      user_id: 8,
                    },
                  ],
                },
              },
      };
    return {};
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(request);
  const client = new Client({ name: "test", version: "1" });
  await server.connect(a);
  await client.connect(b);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 22);
    assert.ok(!tools.some((t) => /approve|send_message/.test(t.name)));
    assert.equal(
      (await call("jiji_market_prices", { query: "router" })).median,
      150,
    );
    assert.equal(
      (
        await call("jiji_seller_contact", {
          guid: advert.guid,
          purchase_purpose: "Compare one shortlisted router for purchase",
        })
      ).phones.length,
      1,
    );
    assert.equal(
      (
        await call("jiji_whatsapp_handoff", {
          guid: advert.guid,
          purchase_purpose: "Purchase one shortlisted router",
        })
      ).sent,
      false,
    );
    const inbox = await call("jiji_list_conversations");
    assert.equal(
      (
        await call("jiji_read_conversation", {
          key: inbox.conversations[0].key,
        })
      ).messages[0].text,
      "Available",
    );
    const draft = await call("jiji_prepare_message", { guid: advert.guid });
    assert.equal(draft.state, "pending");
    assert.match(draft.message, /Is it still available/);
    const offer = await call("jiji_prepare_message", {
      guid: advert.guid,
      offer_amount: 90,
    });
    assert.equal(offer.state, "pending");
    assert.equal(offer.offer_amount, 90);
    assert.equal(offer.message, "");
    assert.ok(!seen.some((m) => /send|approve/.test(m.action)));
  } finally {
    await client.close();
    await server.close();
  }
});
