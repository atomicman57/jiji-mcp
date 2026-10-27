import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalPlans } from "../src/plans.mjs";
test("preparing never sends, approval sends once, and repeat approval cannot duplicate it", async () => {
  const store = new ApprovalPlans();
  let sent = 0;
  const plan = store.prepare({
    type: "jiji_message",
    seller: "Example seller",
    message: "Is it available?",
    listing_url: "https://jiji.ng/example.html",
  });
  assert.equal(sent, 0);
  const result = await store.approve(plan.id, async () => {
    sent++;
    return { sent: true };
  });
  assert.equal(result.state, "sent");
  assert.equal(sent, 1);
  await assert.rejects(
    store.approve(plan.id, async () => {
      sent++;
    }),
    /already handled/,
  );
  assert.equal(sent, 1);
});
test("uncertain delivery cannot be retried, including concurrent approval", async () => {
  const store = new ApprovalPlans();
  const plan = store.prepare({ message: "Hello" });
  let release;
  const first = store.approve(
    plan.id,
    () =>
      new Promise((resolve, reject) => {
        release = () => reject(new Error("Delivery status unknown"));
      }),
  );
  await assert.rejects(
    store.approve(plan.id, async () => {}),
    /already handled/,
  );
  release();
  assert.equal((await first).state, "uncertain");
  await assert.rejects(
    store.approve(plan.id, async () => {}),
    /already handled/,
  );
});
test("expired plans do not send", async () => {
  const store = new ApprovalPlans();
  const plan = store.prepare({ message: "Hello" });
  store.get(plan.id).expires = Date.now() - 1;
  let sent = 0;
  await assert.rejects(
    store.approve(plan.id, async () => sent++),
    /expired/,
  );
  assert.equal(sent, 0);
});
