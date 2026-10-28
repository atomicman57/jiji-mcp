import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApprovalPlans } from "../src/plans.mjs";
import {
  createMemoryLog,
  createRelease,
  finishPreparedMessage,
  messageDigest,
  openSendLog,
  readSendSettings,
} from "../src/message-release.mjs";
import { createServer } from "../src/tools.mjs";

const HOUR = 60 * 60 * 1000;

function messagePlan(plans, extra = {}) {
  return plans.prepare({
    type: "jiji_message",
    seller: "Example seller",
    title: "Router",
    listing_url: "https://jiji.ng/example.html",
    chat_url: "/profile-messages/7_12",
    message: "Is it available?",
    ...extra,
  });
}

function harness({
  cap = 12,
  dedupeMs = 10 * 60 * 1000,
  clock = Date.now(),
} = {}) {
  let time = clock;
  let calls = 0;
  let behavior = async () => ({ sent: true });
  const plans = new ApprovalPlans();
  const log = createMemoryLog();
  const release = createRelease({
    plans,
    log,
    settings: { autoApprove: false, hourlySendCap: cap, dedupeMs },
    now: () => time,
    send: (plan) => {
      calls += 1;
      return behavior(plan);
    },
  });
  return {
    plans,
    log,
    release,
    calls: () => calls,
    setBehavior(fn) {
      behavior = fn;
    },
    advance(ms) {
      time += ms;
    },
    at: () => time,
    draft(extra) {
      const plan = messagePlan(plans, extra);
      plans.get(plan.id).expires = time + HOUR;
      return plan;
    },
  };
}

async function waitFor(fn) {
  for (let i = 0; i < 30; i++) {
    if (fn()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not reached.");
}

test("send settings default off and environment overrides config", () => {
  assert.deepEqual(readSendSettings(), {
    autoApprove: false,
    hourlySendCap: 12,
    dedupeMs: 600000,
    logText: false,
  });
  assert.equal(
    readSendSettings({}, { JIJI_AUTO_APPROVE: true, JIJI_HOURLY_SEND_CAP: 3 })
      .autoApprove,
    true,
  );
  assert.deepEqual(
    readSendSettings(
      {
        JIJI_AUTO_APPROVE: "0",
        JIJI_HOURLY_SEND_CAP: "4",
        JIJI_SEND_DEDUPE_MS: "1000",
      },
      { JIJI_AUTO_APPROVE: true, JIJI_HOURLY_SEND_CAP: 99 },
    ),
    { autoApprove: false, hourlySendCap: 4, dedupeMs: 1000, logText: false },
  );
  assert.throws(
    () => readSendSettings({ JIJI_AUTO_APPROVE: "maybe" }),
    /true or false/,
  );
  assert.throws(
    () => readSendSettings({ JIJI_HOURLY_SEND_CAP: "-1" }),
    /non-negative/,
  );
});

test("auto-approve off stays pending and on sends through the approval function", async () => {
  const off = harness();
  const prepared = off.draft();
  const pending = await finishPreparedMessage(false, prepared, off.release);
  assert.equal(pending, prepared);
  assert.equal(pending.state, "pending");
  assert.equal(off.calls(), 0);
  assert.equal(off.log.entries.length, 0);

  const on = harness();
  let seen;
  on.setBehavior(async (plan) => {
    seen = plan;
    return { sent: true };
  });
  const draft = on.draft({ message: "Exact text" });
  const sent = await finishPreparedMessage(true, draft, on.release);
  assert.equal(sent.state, "sent");
  assert.equal(seen.id, draft.id);
  assert.equal(seen.message, "Exact text");
  assert.equal(on.calls(), 1);
  const repeat = await on.release.approve(draft.id);
  assert.equal(repeat.state, "sent");
  assert.equal(on.calls(), 1);
});

test("jiji_send_prepared releases pending, reports already sent, and rejects unknown ids", async () => {
  const h = harness();
  const plan = h.draft();
  assert.equal(h.plans.public(h.plans.get(plan.id)).state, "pending");
  const sent = await h.release.approve(plan.id);
  assert.equal(sent.state, "sent");
  const again = await h.release.approve(plan.id);
  assert.equal(again.state, "sent");
  assert.equal(h.calls(), 1);
  await assert.rejects(
    h.release.approve("11111111-1111-4111-8111-111111111111"),
    /Plan not found/,
  );
  assert.equal(h.calls(), 1);
  assert.ok(
    h.log.entries.some(
      (row) => row.event === "outcome" && row.state === "sent",
    ),
  );
  assert.ok(
    h.log.entries.some(
      (row) => row.event === "idempotent" && row.state === "sent",
    ),
  );
});

test("a double call sends once and status moves pending to sending to sent", async () => {
  const h = harness();
  let finish;
  h.setBehavior(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ sent: true });
      }),
  );
  const plan = h.draft();
  const first = h.release.approve(plan.id);
  const second = h.release.approve(plan.id);
  await waitFor(() => h.plans.get(plan.id).state === "sending");
  assert.equal(h.plans.public(h.plans.get(plan.id)).state, "sending");
  assert.equal(h.calls(), 1);
  finish();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.state, "sent");
  assert.equal(b.state, "sent");
  assert.equal(h.calls(), 1);
});

test("overlapping releases cannot share the last cap slot", async () => {
  const h = harness({ cap: 1 });
  let finish;
  h.setBehavior(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ sent: true });
      }),
  );
  const first = h.release.approve(h.draft({ message: "A" }).id);
  const second = h.release.approve(h.draft({ message: "B" }).id);
  await waitFor(() => h.calls() === 1);
  assert.equal((await second).state, "capped");
  finish();
  assert.equal((await first).state, "sent");
  assert.equal(h.calls(), 1);
});

test("hourly cap blocks the next send and clears on the following hour", async () => {
  const h = harness({ cap: 1 });
  const first = await h.release.approve(h.draft({ message: "One" }).id);
  assert.equal(first.state, "sent");
  const blocked = await h.release.approve(h.draft({ message: "Two" }).id);
  assert.equal(blocked.state, "capped");
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.limited, true);
  assert.match(blocked.result.message, /Nothing was sent/);
  assert.equal(h.calls(), 1);
  const raced = h.release.approve(h.draft({ message: "Race" }).id);
  assert.equal((await raced).state, "capped");
  assert.equal(h.calls(), 1);
  h.advance(HOUR + 1);
  const later = await h.release.approve(h.draft({ message: "Three" }).id);
  assert.equal(later.state, "sent");
  assert.equal(h.calls(), 2);
});

test("identical text to the same chat is deduped, then allowed after the window", async () => {
  const h = harness({ dedupeMs: 1000, cap: 10 });
  assert.equal((await h.release.approve(h.draft().id)).state, "sent");
  const duplicate = await h.release.approve(h.draft().id);
  assert.equal(duplicate.state, "duplicate");
  assert.equal(duplicate.blocked, true);
  assert.equal(h.calls(), 1);
  assert.equal(
    (await h.release.approve(h.draft({ message: "Different text" }).id)).state,
    "sent",
  );
  assert.equal(
    (
      await h.release.approve(
        h.draft({ chat_url: "/profile-messages/other" }).id,
      )
    ).state,
    "sent",
  );
  assert.equal(
    (
      await h.release.approve(
        h.draft({ offer_amount: 90, message: "Is it available?" }).id,
      )
    ).state,
    "sent",
  );
  h.advance(1001);
  assert.equal((await h.release.approve(h.draft().id)).state, "sent");
  assert.equal(h.calls(), 5);
});

test("uncertain delivery is not retried and blocks the same text", async () => {
  const h = harness();
  h.setBehavior(async () => {
    throw new Error("Delivery status unknown");
  });
  const plan = h.draft();
  const uncertain = await h.release.approve(plan.id);
  assert.equal(uncertain.state, "uncertain");
  assert.match(uncertain.result.message, /No automatic retry/);
  const again = await h.release.approve(plan.id);
  assert.equal(again.state, "uncertain");
  const copy = await h.release.approve(h.draft().id);
  assert.equal(copy.state, "duplicate");
  assert.equal(h.calls(), 1);
  assert.equal(h.plans.public(h.plans.get(plan.id)).state, "uncertain");
});

test("a known pre-send failure is failed, is not retried, and does not dedupe", async () => {
  const h = harness();
  h.setBehavior(async () => {
    const error = new Error("Chat target changed. Nothing was sent.");
    error.nothingSent = true;
    throw error;
  });
  const plan = h.draft();
  const failed = await h.release.approve(plan.id);
  assert.equal(failed.state, "failed");
  assert.match(failed.result.message, /will not be retried/);
  assert.equal((await h.release.approve(plan.id)).state, "failed");
  h.setBehavior(async () => ({ sent: true }));
  assert.equal((await h.release.approve(h.draft().id)).state, "sent");
  assert.equal(h.calls(), 2);
});

test("expired, capped, and duplicate plans send nothing and status reports them", async () => {
  const expired = harness();
  const old = expired.draft();
  expired.plans.get(old.id).expires = expired.at() - 1;
  const expiredResult = await expired.release.approve(old.id);
  assert.equal(expiredResult.state, "expired");
  assert.equal(expired.calls(), 0);
  assert.equal(
    expired.plans.public(expired.plans.get(old.id)).state,
    "expired",
  );

  const capped = harness({ cap: 0 });
  const blocked = await capped.release.approve(capped.draft().id);
  assert.equal(blocked.state, "capped");
  assert.equal(capped.calls(), 0);
  assert.equal(
    capped.plans.public(capped.plans.get(blocked.id)).state,
    "capped",
  );
});

test("account approval still uses the same send function and is not message-capped", async () => {
  const h = harness({ cap: 0 });
  const plan = h.plans.prepare({
    type: "jiji_api_action",
    operation: "save_search",
    title: "Save",
  });
  const result = await h.release.approve(plan.id);
  assert.equal(result.state, "submitted");
  assert.equal(h.calls(), 1);
  assert.equal(h.log.entries.length, 0);
});

test("the send log is appended and a restarted log still enforces the cap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jiji-send-log-"));
  const file = path.join(dir, "nested", "send-log.jsonl");
  try {
    const log = await openSendLog(file);
    let calls = 0;
    const plans = new ApprovalPlans();
    const release = createRelease({
      plans,
      log,
      settings: { autoApprove: false, hourlySendCap: 1, dedupeMs: 600000 },
      send: async () => {
        calls += 1;
        return { sent: true };
      },
    });
    const first = messagePlan(plans, { message: "Logged send" });
    assert.equal((await release.approve(first.id)).state, "sent");
    const text = await readFile(file, "utf8");
    assert.match(text, /"event":"attempt"/);
    assert.match(text, /"state":"sent"/);
    assert.match(text, new RegExp(messageDigest("Logged send").text_sha256));
    assert.match(text, /"text_length":11/);
    assert.equal(text.includes("Logged send"), false);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const reloaded = await openSendLog(file);
    const plans2 = new ApprovalPlans();
    const release2 = createRelease({
      plans: plans2,
      log: reloaded,
      settings: { autoApprove: false, hourlySendCap: 1, dedupeMs: 600000 },
      send: async () => {
        calls += 1;
        return { sent: true };
      },
    });
    const second = messagePlan(plans2, { message: "Another send" });
    assert.equal((await release2.approve(second.id)).state, "capped");
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("send log stores message text only when JIJI_SEND_LOG_TEXT is on", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jiji-send-log-text-"));
  const message = "Private reply text";
  try {
    for (const [logText, file] of [
      [false, "redacted.jsonl"],
      [true, "clear.jsonl"],
    ]) {
      const log = await openSendLog(path.join(dir, file));
      const plans = new ApprovalPlans();
      const release = createRelease({
        plans,
        log,
        settings: {
          autoApprove: false,
          hourlySendCap: 5,
          dedupeMs: 600000,
          logText,
        },
        send: async () => ({ sent: true }),
      });
      await release.approve(messagePlan(plans, { message }).id);
      const text = await readFile(path.join(dir, file), "utf8");
      assert.match(text, new RegExp(messageDigest(message).text_sha256));
      assert.equal(text.includes(message), logText);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("companion and worker share one message release path", () => {
  const companion = readFileSync(
    new URL("../src/companion.mjs", import.meta.url),
    "utf8",
  );
  const worker = readFileSync(
    new URL("../cloud/worker.mjs", import.meta.url),
    "utf8",
  );
  assert.equal([...companion.matchAll(/browser\.send\(/g)].length, 1);
  assert.equal(companion.includes("plans.approve"), false);
  assert.equal([...companion.matchAll(/release\.approve\(/g)].length, 2);
  assert.match(companion, /finishPreparedMessage\(settings\.autoApprove/);
  assert.match(worker, /"send_prepared"/);
});

test("MCP send_prepared and message status forward release states", async () => {
  const h = harness();
  const plan = h.draft();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(async (message) => {
    if (message.action === "send_prepared")
      return h.release.approve(message.id);
    if (message.action === "plan_status")
      return h.plans.public(h.plans.get(message.id));
    throw new Error("Unexpected action " + message.action);
  });
  const client = new Client({ name: "mock-send", version: "1" });
  await server.connect(a);
  await client.connect(b);
  try {
    const call = async (name, id) =>
      client.callTool({ name, arguments: { id } });
    const sent = await call("jiji_send_prepared", plan.id);
    assert.equal(JSON.parse(sent.content[0].text).state, "sent");
    const repeat = await call("jiji_send_prepared", plan.id);
    assert.equal(JSON.parse(repeat.content[0].text).state, "sent");
    assert.equal(h.calls(), 1);
    const status = await call("jiji_message_status", plan.id);
    assert.equal(JSON.parse(status.content[0].text).state, "sent");
    const missing = await call(
      "jiji_send_prepared",
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Plan not found/);
  } finally {
    await client.close();
    await server.close();
  }
});
