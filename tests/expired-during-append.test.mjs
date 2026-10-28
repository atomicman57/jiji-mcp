import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalPlans } from "../src/plans.mjs";
import { createRelease, projectSendLog } from "../src/message-release.mjs";

// The pre-send log append reserves a cap slot. If the plan expires while that
// append is still in flight, the send must not run and the reservation must
// be revoked so a later message can use the slot.
test("a plan that expires during the pre-send log append does not consume a cap slot", async () => {
  const plans = new ApprovalPlans();
  const entries = [];
  let calls = 0;
  const log = {
    entries,
    async append(row) {
      entries.push(row);
      if (row.event === "attempt")
        await new Promise((resolve) => setTimeout(resolve, 80));
    },
  };
  const release = createRelease({
    plans,
    log,
    settings: {
      autoApprove: false,
      hourlySendCap: 1,
      dedupeMs: 600000,
      logText: false,
    },
    send: async () => {
      calls += 1;
      return { sent: true };
    },
  });
  const plan = plans.prepare({
    type: "jiji_message",
    seller: "Example seller",
    title: "Router",
    listing_url: "https://jiji.ng/example.html",
    chat_url: "/profile-messages/7_12",
    message: "Expires while the log append is in flight",
  });
  // The release check runs before the append. The delay inside the append
  // then lets the real clock pass the plan's expiry before send starts.
  plans.get(plan.id).expires = Date.now() + 30;
  const expired = await release.approve(plan.id);
  assert.equal(expired.state, "expired");
  assert.equal(calls, 0);
  assert.equal(plans.get(plan.id).state, "expired");
  assert.ok(
    entries.some((row) => row.event === "attempt" && row.counts === true),
  );
  assert.ok(
    entries.some((row) => row.state === "expired" && row.revokeCount === true),
  );
  const reserved = projectSendLog(entries, Date.now(), 600000).find(
    (row) => row.id === plan.id,
  );
  assert.equal(reserved.state, "expired");
  assert.equal(reserved.counts, false);
  const next = plans.prepare({
    type: "jiji_message",
    seller: "Example seller",
    title: "Router",
    listing_url: "https://jiji.ng/example.html",
    chat_url: "/profile-messages/other",
    message: "This send should still fit under the cap",
  });
  plans.get(next.id).expires = Date.now() + 60 * 60 * 1000;
  const sent = await release.approve(next.id);
  assert.equal(sent.state, "sent");
  assert.equal(calls, 1);
});
