import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AD_STATUS_DEDUPE_MS,
  AD_STATUS_LOOSE_DEDUPE_MS,
  AlertOutbox,
  DEFAULT_OUTBOX_MAX,
  DEFAULT_POLL_MS,
  MAX_POLL_MS,
  MAX_PUSH_PAGES,
  MIN_POLL_MS,
  OUTBOX_MAX_AGE_MS,
  PUSH_READS,
  PushStore,
  backoffSeconds,
  detectEvents,
  isNonPublicHost,
  pollJiji,
  readPushConfig,
  resolvesPublic,
  safeErrorFields,
  sendAlert,
  startPushNotifications,
} from "../src/push-notifications.mjs";

const URL_OK =
  "https://api2.cursor.sh/automations/webhook/1234-uuid?k=query-secret";
const SECRET = "Bearer sk-push-secret-value";
const env = (extra = {}) => ({
  JIJI_PUSH_WEBHOOK_URL: URL_OK,
  JIJI_PUSH_WEBHOOK_AUTH_VALUE: SECRET,
  ...extra,
});
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
const tmp = () => mkdtemp(path.join(tmpdir(), "jiji-push-test-"));
function recorder() {
  const lines = [];
  const log = (level, message, fields = {}) =>
    lines.push(`${level} ${message} ${JSON.stringify(fields)}`);
  return { lines, log };
}
function fetchMock(status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", {
      status: typeof status === "function" ? status(calls.length) : status,
    });
  };
  fn.calls = calls;
  return fn;
}
const room = (id, msgId, extra = {}) => ({
  room_id: id,
  advert: { url: `/lagos/phone-${id}.html`, title: `Phone ${id}` },
  user: { user_name: `Buyer ${id}` },
  unread_count: 1,
  last_message: { id: msgId, text: `hello ${msgId}`, created_at: 1761700000 },
  ...extra,
});
const ok = (body) => ({ status: 200, body });
// A browser mock that only offers the read path; any other method fails.
function browserMock(responses) {
  const calls = [];
  const target = {
    calls,
    run: (fn) => fn(),
    status: async () => ({ browser_open: true, signed_in: true }),
    readResource: async (name, parameters) => {
      calls.push({ name, parameters });
      const r = responses[name];
      return typeof r === "function" ? r(parameters) : r;
    },
  };
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (typeof key === "symbol" || key === "then") return undefined;
      throw new Error(`push feed touched browser.${String(key)}`);
    },
  });
}

test("disabled when the URL or auth value is missing", () => {
  for (const e of [
    {},
    { JIJI_PUSH_WEBHOOK_URL: URL_OK },
    { JIJI_PUSH_WEBHOOK_AUTH_VALUE: SECRET },
    { JIJI_PUSH_WEBHOOK_URL: " ", JIJI_PUSH_WEBHOOK_AUTH_VALUE: " " },
  ]) {
    const c = readPushConfig(e, { runtimeDir: "/data" });
    assert.equal(c.enabled, false);
    assert.match(c.reason, /JIJI_PUSH_WEBHOOK_URL/);
  }
});

test("config defaults: Authorization header, 60s poll, 1000 outbox, state under runtime", () => {
  const c = readPushConfig(env(), { runtimeDir: "/data" });
  assert.equal(c.enabled, true);
  assert.equal(c.target.header, "Authorization");
  assert.equal(c.target.value, SECRET);
  assert.equal(c.target.host, "api2.cursor.sh");
  assert.equal(c.pollMs, DEFAULT_POLL_MS);
  assert.equal(c.outboxMax, DEFAULT_OUTBOX_MAX);
  assert.equal(c.stateDir, "/data/push-notifications");
});

test("poll interval and outbox max are clamped; bad numbers fall back", () => {
  const { log, lines } = recorder();
  const read = (extra) => readPushConfig(env(extra), { runtimeDir: "/d", log });
  assert.equal(read({ JIJI_PUSH_POLL_INTERVAL_MS: "10" }).pollMs, MIN_POLL_MS);
  assert.equal(
    read({ JIJI_PUSH_POLL_INTERVAL_MS: "99999999" }).pollMs,
    MAX_POLL_MS,
  );
  assert.equal(
    read({ JIJI_PUSH_POLL_INTERVAL_MS: "soon" }).pollMs,
    DEFAULT_POLL_MS,
  );
  assert.equal(read({ JIJI_PUSH_WEBHOOK_OUTBOX_MAX: "0" }).outboxMax, 1);
  assert.equal(read({ JIJI_PUSH_WEBHOOK_OUTBOX_MAX: "5" }).outboxMax, 5);
  assert.equal(
    read({ JIJI_PUSH_STATE_DIR: "/srv/push" }).stateDir,
    "/srv/push",
  );
  assert.equal(read({ JIJI_PUSH_STATE_DIR: "relative" }).enabled, false);
  assert.ok(lines.length >= 3);
});

test("bad URLs and headers disable the feed without throwing", () => {
  for (const [url, extra] of [
    ["http://api2.cursor.sh/hook", {}],
    ["not a url", {}],
    ["https://user:pw@api2.cursor.sh/hook", {}],
    ["https://api2.cursor.sh/hook#frag", {}],
    ["https://localhost/hook", {}],
    ["https://127.0.0.1/hook", {}],
    ["https://10.1.2.3/hook", {}],
    ["https://192.168.1.10/hook", {}],
    ["https://172.20.0.1/hook", {}],
    ["https://169.254.169.254/hook", {}],
    ["https://100.100.1.1/hook", {}],
    ["https://[::1]/hook", {}],
    ["https://[fd00::1]/hook", {}],
    ["https://[fe80::1]/hook", {}],
    ["https://[::ffff:127.0.0.1]/hook", {}],
    ["https://0x7f.1/hook", {}],
    [URL_OK, { JIJI_PUSH_WEBHOOK_AUTH_HEADER: "Host" }],
    [URL_OK, { JIJI_PUSH_WEBHOOK_AUTH_HEADER: "Bad Header" }],
    [URL_OK, { JIJI_PUSH_WEBHOOK_AUTH_VALUE: "Bearer a\r\nX: y" }],
  ]) {
    const c = readPushConfig(env({ JIJI_PUSH_WEBHOOK_URL: url, ...extra }), {
      runtimeDir: "/d",
    });
    assert.equal(c.enabled, false, url);
    assert.ok(c.reason);
    assert.ok(!c.reason.includes(SECRET));
  }
  const custom = readPushConfig(
    env({
      JIJI_PUSH_WEBHOOK_AUTH_HEADER: "X-Routine-Key",
      JIJI_PUSH_WEBHOOK_AUTH_VALUE: "k",
    }),
    { runtimeDir: "/d" },
  );
  assert.equal(custom.target.header, "X-Routine-Key");
});

test("public-address checks: literal hosts and fail-closed DNS", async () => {
  for (const h of [
    "localhost",
    "a.localhost",
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "169.254.1.1",
    "[::1]",
    "fc00::1",
    "fe80::2",
  ])
    assert.equal(isNonPublicHost(h), true, h);
  for (const h of [
    "api2.cursor.sh",
    "93.184.216.34",
    "100.128.0.1",
    "2606:4700::1",
  ])
    assert.equal(isNonPublicHost(h), false, h);
  assert.equal(await resolvesPublic("x", publicDns), "public");
  assert.equal(
    await resolvesPublic("x", async () => [
      { address: "93.184.216.34" },
      { address: "10.0.0.5" },
    ]),
    "non_public",
  );
  assert.equal(
    await resolvesPublic("x", async () => [{ address: "100.64.3.3" }]),
    "non_public",
  );
  assert.equal(await resolvesPublic("x", async () => []), "unresolved");
  assert.equal(
    await resolvesPublic("x", async () => {
      throw new Error("ENOTFOUND");
    }),
    "unresolved",
  );
});

test("startup never throws and stays off for missing config, bad URL, or non-public DNS", async () => {
  const dir = await tmp();
  try {
    const browser = browserMock({});
    for (const [e, resolve, reason] of [
      [{}, publicDns, /not set/],
      [env({ JIJI_PUSH_WEBHOOK_URL: "http://x.test/" }), publicDns, /https/],
      [env(), async () => [{ address: "127.0.0.1" }], /non-public/],
      [
        env(),
        async () => {
          throw new Error("dns down");
        },
        /did not resolve/,
      ],
    ]) {
      const { log, lines } = recorder();
      const fetch = fetchMock();
      const push = await startPushNotifications({
        env: e,
        runtimeDir: dir,
        browser,
        log,
        fetch,
        resolve,
      });
      assert.equal(push.enabled, false);
      assert.match(push.reason, reason);
      assert.deepEqual(await push.tick(), { skipped: "disabled" });
      await push.stop();
      assert.equal(fetch.calls.length, 0);
      assert.equal(browser.calls.length, 0);
      assert.ok(lines.some((l) => l.includes("disabled")));
      assert.ok(!lines.join("\n").includes(SECRET));
    }
    assert.deepEqual(await readdir(dir), [], "a disabled feed writes no state");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first run baselines every source and emits nothing", () => {
  const empty = { baselined: {}, rooms: {}, notifications: {}, adverts: {} };
  const { next, events } = detectEvents(
    empty,
    {
      rooms: [
        room(1, 10),
        room(2, 20, { last_message: { id: 21, offer: 5000 } }),
      ],
      notifications: [{ id: 7, type: "advert_approved", text: "Approved" }],
      adverts: [{ id: 99, status: "active", title: "Car" }],
    },
    1000,
  );
  assert.deepEqual(events, []);
  assert.deepEqual(next.baselined, {
    rooms: true,
    notifications: true,
    adverts: true,
  });
  assert.equal(next.rooms["1"].marker, "id:10");
  assert.equal(next.adverts["99"].status, "active");
  assert.ok("7" in next.notifications);
});

test("new chat, offer, and ad status transitions produce stable events", () => {
  const base = detectEvents(
    { baselined: {}, rooms: {}, notifications: {}, adverts: {} },
    {
      rooms: [room(1, 10), room(2, 20)],
      notifications: [{ id: 7, type: "info", text: "Welcome" }],
      adverts: [{ id: 99, status: "on_review", title: "Car" }],
    },
    1000,
  ).next;
  const reads = {
    rooms: [
      room(1, 11, { last_message: { id: 11, text: "x".repeat(1000) } }),
      room(2, 20),
      room(3, 30, { last_message: { id: 30, make_an_offer: 75000 } }),
      room(4, 40, { last_message: { id: 40, text: "mine", is_my: true } }),
      room(5, 50, { unread_count: 0 }),
    ],
    notifications: [
      { id: 7, type: "info", text: "Welcome" },
      {
        id: 8,
        type: "advert_declined",
        text: "Your ad was declined",
        advert: { id: 101, title: "Bike" },
      },
      { id: 9, type: "promo", text: "Boost your ad" },
      { id: 10, type: "chat_offer", text: "New offer" },
    ],
    adverts: [
      { id: 99, status: { name: "Declined" }, title: "Car" },
      { id: 100, status: "active" },
    ],
  };
  const { next, events } = detectEvents(base, reads, 2000);
  const byId = Object.fromEntries(events.map((e) => [e.event_id, e]));
  assert.deepEqual(Object.keys(byId).sort(), [
    "jiji:ad_status:99:1",
    "jiji:chat_message:1:id:11",
    "jiji:notification:10",
    "jiji:notification:8",
    "jiji:offer:3:id:30",
  ]);
  const chat = byId["jiji:chat_message:1:id:11"];
  assert.equal(chat.source, "jiji");
  assert.equal(chat.data.room_id, "1");
  assert.ok(chat.data.preview.length <= 280);
  assert.equal(byId["jiji:offer:3:id:30"].type, "offer");
  assert.equal(byId["jiji:offer:3:id:30"].data.offer_amount, 75000);
  assert.equal(byId["jiji:notification:8"].type, "ad_status");
  assert.equal(byId["jiji:notification:10"].type, "offer");
  const ad = byId["jiji:ad_status:99:1"];
  assert.deepEqual([ad.data.from, ad.data.to], ["on_review", "declined"]);
  // Same reads again: nothing new.
  assert.deepEqual(detectEvents({ ...next }, reads, 3000).events, []);
  // Flip back and again: the second transition to declined is a distinct event.
  const back = detectEvents(
    next,
    { adverts: [{ id: 99, status: "active" }] },
    4000,
  );
  const again = detectEvents(
    back.next,
    { adverts: [{ id: 99, status: "declined" }] },
    5000,
  );
  assert.deepEqual(
    [...back.events, ...again.events].map((e) => e.event_id),
    ["jiji:ad_status:99:2", "jiji:ad_status:99:3"],
  );
});

test("a failed source keeps its state and does not re-baseline", () => {
  const state = {
    baselined: { rooms: true },
    rooms: { 1: { marker: "id:10", at: 1 } },
    notifications: {},
    adverts: {},
  };
  const { next, events } = detectEvents(
    state,
    { rooms: null, notifications: null, adverts: null },
    2,
  );
  assert.deepEqual(events, []);
  assert.deepEqual(next.rooms, state.rooms);
  assert.deepEqual(next.baselined, { rooms: true });
});

test("poller uses only read resources and never chat_messages or writes", async () => {
  const browser = browserMock({
    chat_rooms: ok({ status: "ok", results: [room(1, 10)] }),
    notifications: ok({ notifications: [] }),
    my_adverts: (p) =>
      ok({
        adverts:
          p.page === 2
            ? [{ id: 2, status: "active" }]
            : [{ id: 1, status: "active" }],
        next_url:
          p.page === 2 ? null : "/api_web/v1/profile/my-ads.json?page=2",
      }),
  });
  const reads = await pollJiji(browser, () => {});
  assert.equal(reads.rooms.length, 1);
  assert.deepEqual(reads.notifications, []);
  assert.equal(reads.adverts.length, 2);
  assert.ok(browser.calls.every((c) => PUSH_READS.includes(c.name)));
  assert.deepEqual(
    browser.calls.map((c) => c.name),
    ["chat_rooms", "notifications", "my_adverts", "my_adverts"],
  );
});

test("poller turns read errors and odd shapes into skipped sources", async () => {
  const browser = browserMock({
    chat_rooms: { status: 403 },
    notifications: { error: "Jiji returned HTML or a challenge." },
    my_adverts: async () => {
      throw new Error("page crashed");
    },
  });
  const { log, lines } = recorder();
  assert.deepEqual(await pollJiji(browser, log), {
    rooms: null,
    notifications: null,
    adverts: null,
  });
  assert.equal(lines.length, 3);
});

async function harness(
  t,
  {
    responses,
    status = async () => ({ browser_open: true, signed_in: true }),
    fetchStatus = 200,
    extraEnv = {},
  } = {},
) {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const browser = browserMock(responses);
  Object.defineProperty(browser, "status", { value: status });
  const { log, lines } = recorder();
  const fetch = fetchMock(fetchStatus);
  let clock = 1_000_000;
  let connected = true;
  const push = await startPushNotifications({
    env: env(extraEnv),
    runtimeDir: dir,
    browser,
    log,
    fetch,
    resolve: publicDns,
    now: () => clock,
    isEnabled: () => connected,
    firstPollMs: 2 ** 31 - 1,
  });
  t.after(() => push.stop());
  return {
    dir,
    push,
    browser,
    fetch,
    lines,
    advance: (ms) => (clock += ms),
    disconnect: () => (connected = false),
  };
}

test("end to end: baseline, then POST with auth and Idempotency-Key, then dedupe", async (t) => {
  let rooms = [room(1, 10)];
  const h = await harness(t, {
    responses: {
      chat_rooms: () => ok({ status: "ok", results: rooms }),
      notifications: ok({ notifications: [] }),
      my_adverts: ok({ adverts: [] }),
    },
  });
  assert.equal(h.push.enabled, true);
  const first = await h.push.tick();
  assert.equal(first.events, 0);
  await h.push.outbox.kick();
  assert.equal(h.fetch.calls.length, 0, "baseline sends nothing");
  rooms = [room(1, 11)];
  const second = await h.push.tick();
  assert.equal(second.queued, 1);
  await h.push.outbox.kick();
  assert.equal(h.fetch.calls.length, 1);
  const { url, init } = h.fetch.calls[0];
  assert.equal(url, new URL(URL_OK).href);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  assert.equal(init.headers.Authorization, SECRET);
  assert.equal(init.headers["Idempotency-Key"], "jiji:chat_message:1:id:11");
  const body = JSON.parse(init.body);
  assert.equal(body.type, "chat_message");
  assert.equal(body.event_id, "jiji:chat_message:1:id:11");
  // The same message again, or reloaded state: no second POST.
  await h.push.tick();
  await h.push.outbox.kick();
  assert.equal(h.fetch.calls.length, 1);
  assert.equal(h.push.store.depth(), 0);
  const saved = JSON.parse(
    await readFile(
      path.join(h.dir, "push-notifications", "push-state.json"),
      "utf8",
    ),
  );
  assert.ok("jiji:chat_message:1:id:11" in saved.seen);
  assert.equal(
    (await stat(path.join(h.dir, "push-notifications"))).mode & 0o777,
    0o700,
  );
  assert.equal(
    (await stat(path.join(h.dir, "push-notifications", "push-state.json")))
      .mode & 0o777,
    0o600,
  );
  const logged = h.lines.join("\n");
  assert.ok(!logged.includes(SECRET));
  assert.ok(!logged.includes("query-secret"));
  assert.ok(!logged.includes("1234-uuid"));
});

test("signed out, disconnected, or browser error skips the tick and keeps state", async (t) => {
  let signedIn = false;
  const h = await harness(t, {
    responses: {
      chat_rooms: ok({ status: "ok", results: [room(1, 10)] }),
      notifications: ok({ notifications: [] }),
      my_adverts: ok({ adverts: [] }),
    },
    status: async () => {
      if (signedIn === "boom") throw new Error("browser crashed");
      return { browser_open: true, signed_in: signedIn };
    },
  });
  assert.deepEqual(await h.push.tick(), { skipped: "signed_out" });
  signedIn = "boom";
  assert.deepEqual(await h.push.tick(), { skipped: "browser_error" });
  assert.equal(h.browser.calls.length, 0);
  signedIn = true;
  assert.equal((await h.push.tick()).result, "accepted");
  h.disconnect();
  assert.deepEqual(await h.push.tick(), { skipped: "disconnected" });
  assert.deepEqual(h.push.store.snapshot().baselined, {
    rooms: true,
    notifications: true,
    adverts: true,
  });
});

test("retryable delivery failures back off and retry", async (t) => {
  let rooms = [room(1, 10)];
  let code = 503;
  const h = await harness(t, {
    responses: {
      chat_rooms: () => ok({ status: "ok", results: rooms }),
      notifications: ok({ notifications: [] }),
      my_adverts: ok({ adverts: [] }),
    },
    fetchStatus: () => code,
  });
  await h.push.tick();
  rooms = [room(1, 11)];
  await h.push.tick();
  await h.push.outbox.kick();
  assert.equal(h.fetch.calls.length, 1);
  const item = h.push.store.snapshot().outbox[0];
  assert.equal(item.attempts, 1);
  assert.equal(item.nextAttemptAt, 1_000_000 + backoffSeconds(0) * 1000);
  await h.push.outbox.kick();
  assert.equal(h.fetch.calls.length, 1, "not due yet: no busy retry");
  h.advance(backoffSeconds(0) * 1000);
  code = 500;
  await h.push.outbox.kick();
  assert.equal(h.fetch.calls.length, 2);
  assert.equal(h.push.store.snapshot().outbox[0].attempts, 2);
  h.advance(backoffSeconds(1) * 1000);
  code = 202;
  await h.push.outbox.kick();
  assert.equal(h.fetch.calls.length, 3);
  assert.equal(h.push.store.depth(), 0);
  assert.ok(h.lines.some((l) => l.includes("webhook_http_503")));
});

test("backoff schedule matches min(300, 2 ** min(attempts + 1, 9))", () => {
  assert.deepEqual(
    [0, 1, 2, 5, 7, 8, 20].map(backoffSeconds),
    [2, 4, 8, 64, 256, 300, 300],
  );
});

test("sendAlert re-checks DNS before every POST and fails closed", async () => {
  const target = { url: URL_OK, header: "Authorization", value: SECRET };
  const p = { event_id: "e1" };
  const fetch = fetchMock();
  assert.deepEqual(
    await sendAlert(target, p, {
      fetch,
      resolve: async () => [{ address: "10.0.0.1" }],
    }),
    { ok: false, code: "webhook_dns_non_public" },
  );
  assert.deepEqual(
    await sendAlert(target, p, {
      fetch,
      resolve: async () => {
        throw new Error("x");
      },
    }),
    { ok: false, code: "webhook_dns_error" },
  );
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(
    await sendAlert(target, p, {
      resolve: publicDns,
      fetch: async () => {
        throw Object.assign(new Error("t"), { name: "TimeoutError" });
      },
    }),
    { ok: false, code: "webhook_timeout" },
  );
  assert.deepEqual(await sendAlert(target, p, { fetch, resolve: publicDns }), {
    ok: true,
  });
});

test("outbox is bounded: at the cap new events are refused and state is not advanced", async () => {
  const dir = await tmp();
  try {
    let clock = 1;
    const store = new PushStore(dir, {
      now: () => clock,
      log: () => {},
      outboxMax: 1,
    });
    const mk = (id) => ({
      source: "jiji",
      type: "chat_message",
      event_id: id,
      occurred_at: new Date(0).toISOString(),
      summary: "s",
      data: {},
    });
    const next = (marker) => ({
      baselined: { rooms: true },
      rooms: { 1: { marker, at: clock } },
      notifications: {},
      adverts: {},
    });
    assert.equal(store.commit(next("a"), [mk("e1")]).result, "accepted");
    assert.equal(store.commit(next("b"), [mk("e2")]).result, "outbox_full");
    assert.equal(
      store.snapshot().rooms["1"].marker,
      "a",
      "refused poll is detected again later",
    );
    assert.equal(
      store.commit(next("a"), [mk("e1")]).queued,
      0,
      "queued id deduped",
    );
    // Age limit drops stale alerts, freeing room.
    clock += OUTBOX_MAX_AGE_MS;
    assert.equal(store.due(), undefined);
    assert.equal(store.commit(next("b"), [mk("e2")]).result, "accepted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt outbox entries are dropped on load; an unreadable file is set aside", async () => {
  const dir = await tmp();
  try {
    const good = {
      id: "e1",
      payload: {
        source: "jiji",
        type: "offer",
        event_id: "e1",
        occurred_at: "2026-10-29T00:00:00.000Z",
        summary: "Offer",
        data: {},
      },
      attempts: 0,
      nextAttemptAt: 1,
      enqueuedAt: 1,
    };
    await writeFile(
      path.join(dir, "push-state.json"),
      JSON.stringify({
        version: 1,
        baselined: { rooms: true, bogus: "yes" },
        rooms: { 1: { marker: "id:1", at: 1 }, 2: "bad" },
        seen: { e0: 1, bad: "x" },
        outbox: [
          good,
          { ...good, id: "e2" },
          {
            ...good,
            id: "e3",
            payload: { ...good.payload, event_id: "e3", type: "wire" },
          },
          {
            ...good,
            id: "e4",
            payload: { ...good.payload, event_id: "e4" },
            nextAttemptAt: "soon",
          },
          null,
        ],
      }),
    );
    const { log, lines } = recorder();
    const store = new PushStore(dir, { now: () => 1, log });
    const s = store.snapshot();
    assert.deepEqual(
      s.outbox.map((i) => i.id),
      ["e1"],
    );
    assert.deepEqual(s.baselined, { rooms: true });
    assert.deepEqual(Object.keys(s.rooms), ["1"]);
    assert.deepEqual(Object.keys(s.seen), ["e0"]);
    assert.equal(
      lines.filter((l) => l.includes("invalid push outbox item")).length,
      4,
    );
    await writeFile(path.join(dir, "push-state.json"), "{not json");
    const fresh = new PushStore(dir, { now: () => 42, log });
    assert.deepEqual(fresh.snapshot().outbox, []);
    assert.ok((await readdir(dir)).includes("push-state.json.corrupt-42"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("timer delay is clamped so a far-future retry cannot busy-loop", async () => {
  const dir = await tmp();
  try {
    const store = new PushStore(dir, { now: () => 0, log: () => {} });
    store.persist({
      ...store.snapshot(),
      outbox: [
        {
          id: "e",
          payload: {
            source: "jiji",
            type: "offer",
            event_id: "e",
            occurred_at: "x",
            summary: "",
            data: {},
          },
          attempts: 9,
          nextAttemptAt: Number.MAX_SAFE_INTEGER,
          enqueuedAt: 0,
        },
      ],
    });
    const fetch = fetchMock();
    const outbox = new AlertOutbox(
      store,
      { url: URL_OK, header: "Authorization", value: SECRET },
      {
        fetch,
        resolve: publicDns,
        log: () => {},
        now: () => 0,
      },
    );
    const delays = [];
    const real = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => {
      delays.push(ms);
      return real(() => {}, 0);
    };
    try {
      await outbox.kick();
      await new Promise((r) => real(r, 5));
    } finally {
      globalThis.setTimeout = real;
    }
    await outbox.close();
    assert.equal(fetch.calls.length, 0);
    assert.deepEqual(delays, [2 ** 31 - 1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop clears the poll timer and outbox timer", async (t) => {
  const h = await harness(t, {
    responses: {
      chat_rooms: ok({ status: "ok", results: [] }),
      notifications: ok({ notifications: [] }),
      my_adverts: ok({ adverts: [] }),
    },
  });
  await h.push.stop();
  assert.deepEqual(await h.push.tick(), { skipped: "stopped" });
  assert.equal(h.push.outbox.timer, undefined);
});

// --- Review fixes ------------------------------------------------------------

const fresh = () => ({
  baselined: {},
  rooms: {},
  notifications: {},
  adverts: {},
});

test("only true, a positive amount, or an offer kind counts as an offer", () => {
  const base = detectEvents(fresh(), { rooms: [room(1, 10)] }, 1000).next;
  const typeOf = (last) =>
    detectEvents(
      base,
      { rooms: [room(1, 11, { last_message: { id: 11, ...last } })] },
      2000,
    ).events[0].type;
  for (const last of [{ offer: false }, { offer: 0 }, { offer: "" }])
    assert.equal(typeOf(last), "chat_message", JSON.stringify(last));
  for (const last of [
    { offer: true },
    { offer: 5000 },
    { offer_amount: "2500" },
    { offer: { amount: 1200 } },
    { type: "offer" },
    { message_type: "make_offer", offer: 0 },
  ])
    assert.equal(typeOf(last), "offer", JSON.stringify(last));
});

test("a room with unknown unread never alerts; a known unread does", () => {
  const noCount = (id, msg) => {
    const r = room(id, msg);
    delete r.unread_count;
    return r;
  };
  const base = detectEvents(
    fresh(),
    { rooms: [noCount(1, 10), room(2, 20)] },
    1000,
  ).next;
  const { events } = detectEvents(
    base,
    { rooms: [noCount(1, 11), room(2, 21, { unread_count: 1 })] },
    2000,
  );
  assert.deepEqual(
    events.map((e) => e.event_id),
    ["jiji:chat_message:2:id:21"],
  );
});

test("an approval seen in my_adverts and notifications alerts once", () => {
  const base = detectEvents(
    fresh(),
    {
      notifications: [],
      adverts: [{ id: 99, status: "on_review", title: "Car" }],
    },
    1000,
  ).next;
  const { events } = detectEvents(
    base,
    {
      notifications: [
        {
          id: 8,
          type: "advert_approved",
          text: "Your ad was approved",
          advert: { id: 99, title: "Car" },
        },
      ],
      adverts: [{ id: 99, status: "active", title: "Car" }],
    },
    2000,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, "jiji:ad_status:99:1");
  assert.equal(events[0].data.via, "my_adverts");
});

test("poller follows next-page signals for chat rooms and notifications", async () => {
  const browser = browserMock({
    chat_rooms: (p) =>
      p.page === 2
        ? ok({ status: "ok", results: [room(2, 20)] })
        : ok({
            status: "ok",
            results: [room(1, 10)],
            next_url: "/rooms?page=2",
          }),
    notifications: (p) =>
      p.page === 2
        ? ok({ notifications: [{ id: 2, type: "info" }] })
        : ok({ notifications: [{ id: 1, type: "info" }], has_more: true }),
    my_adverts: ok({ adverts: [] }),
  });
  const reads = await pollJiji(browser, () => {});
  assert.deepEqual(
    reads.rooms.map((r) => r.room_id),
    [1, 2],
  );
  assert.deepEqual(
    reads.notifications.map((n) => n.id),
    [1, 2],
  );
  assert.deepEqual(
    browser.calls.map((c) => [c.name, c.parameters.page]),
    [
      ["chat_rooms", undefined],
      ["chat_rooms", 2],
      ["notifications", undefined],
      ["notifications", 2],
      ["my_adverts", undefined],
    ],
  );
});

test("paged push reads stop at MAX_PUSH_PAGES", async () => {
  let n = 0;
  const browser = browserMock({
    chat_rooms: () =>
      ok({ status: "ok", results: [room(++n, n)], has_more: true }),
    notifications: ok({ notifications: [] }),
    my_adverts: ok({ adverts: [] }),
  });
  const reads = await pollJiji(browser, () => {});
  assert.equal(reads.rooms.length, MAX_PUSH_PAGES);
  assert.equal(
    browser.calls.filter((c) => c.name === "chat_rooms").length,
    MAX_PUSH_PAGES,
  );
});

test("non-retryable HTTP failures are dropped once; retryable ones stay queued", async () => {
  const item = (id) => ({
    source: "jiji",
    type: "chat_message",
    event_id: id,
    occurred_at: new Date(0).toISOString(),
    summary: "x",
    data: {},
  });
  const target = {
    url: URL_OK,
    host: new URL(URL_OK).host,
    header: "Authorization",
    value: SECRET,
  };
  const cases = [
    [302, false],
    [400, false],
    [403, false],
    [404, false],
    [500, true],
    [503, true],
    [408, true],
    [429, true],
    ["network", true],
    ["timeout", true],
    ["dns", true],
    ["dns_private", true],
  ];
  for (const [failure, retried] of cases) {
    const dir = await tmp();
    try {
      const store = new PushStore(dir, { now: () => 1000 });
      store.commit(fresh(), [item("e1")]);
      let calls = 0;
      const fetch = async () => {
        calls++;
        if (failure === "network") throw new TypeError("fetch failed");
        if (failure === "timeout")
          throw Object.assign(new Error("t"), { name: "TimeoutError" });
        return new Response("{}", { status: failure });
      };
      const resolve =
        failure === "dns"
          ? async () => {
              throw new Error("ENOTFOUND");
            }
          : failure === "dns_private"
            ? async () => [{ address: "10.0.0.1", family: 4 }]
            : publicDns;
      const { log, lines } = recorder();
      const outbox = new AlertOutbox(store, target, {
        fetch,
        resolve,
        log,
        now: () => 1000,
      });
      await outbox.kick();
      await outbox.kick();
      await outbox.close();
      const label = String(failure);
      if (retried) {
        assert.equal(store.depth(), 1, label);
        const queued = store.snapshot().outbox[0];
        assert.equal(queued.attempts, 1, label);
        assert.ok(queued.nextAttemptAt > 1000, label);
        assert.ok(
          lines.some((l) => l.includes("will retry")),
          label,
        );
      } else {
        assert.equal(store.depth(), 0, label);
        assert.equal(calls, 1, label);
        assert.ok(lines.some((l) => l.includes(`webhook_http_${failure}`)));
        assert.ok(
          lines.some((l) => l.includes("dropped")),
          label,
        );
      }
      const logged = lines.join("\n");
      assert.ok(!logged.includes(SECRET), label);
      assert.ok(!logged.includes("query-secret"), label);
      assert.ok(!logged.includes("1234-uuid"), label);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("stop waits for an in-flight tick before closing the outbox", async (t) => {
  let release;
  let entered;
  const reached = new Promise((r) => (entered = r));
  const h = await harness(t, {
    responses: {
      chat_rooms: () => {
        entered();
        return new Promise((r) => (release = r));
      },
      notifications: ok({ notifications: [] }),
      my_adverts: ok({ adverts: [] }),
    },
  });
  const ticking = h.push.tick();
  await reached;
  let stopped = false;
  const stopping = h.push.stop().then(() => (stopped = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stopped, false, "stop returned while a read was hung");
  assert.equal(h.push.outbox.closed, false, "outbox closed before the tick");
  release(ok({ status: "ok", results: [room(1, 10)] }));
  await stopping;
  assert.equal(stopped, true);
  assert.equal(h.push.outbox.closed, true);
  assert.deepEqual(await ticking, { skipped: "stopped" });
  assert.deepEqual(await h.push.tick(), { skipped: "stopped" });
});

// --- Error redaction ---------------------------------------------------------

const LEAKS = [
  "cookie=",
  "token=",
  "bearer ",
  "message=",
  "is it still available",
  "sess-abc123",
];
const leaky = () =>
  Object.assign(
    new Error(
      "cookie=sess-abc123 token=tok-xyz Bearer sk-live message=Is it still available?",
    ),
    { code: "ECONNRESET" },
  );
const assertNoLeak = (lines, label) => {
  const logged = lines.join("\n").toLowerCase();
  for (const leak of LEAKS)
    assert.ok(!logged.includes(leak), `${label} logged ${leak}`);
};

test("safeErrorFields keeps only an identifier-like name and code", () => {
  assert.deepEqual(safeErrorFields(leaky()), {
    error_name: "Error",
    error_code: "ECONNRESET",
  });
  assert.deepEqual(
    safeErrorFields({ name: "token=abc", code: "Bearer x", message: "m" }),
    {},
  );
  assert.deepEqual(safeErrorFields({ name: "TypeError", code: 503 }), {
    error_name: "TypeError",
    error_code: 503,
  });
  assert.deepEqual(safeErrorFields(undefined), {});
  assert.deepEqual(safeErrorFields("cookie=x"), {});
});

test("a thrown poll read logs no part of the error message", async () => {
  const browser = browserMock({
    chat_rooms: async () => {
      throw leaky();
    },
    notifications: ok({ notifications: [] }),
    my_adverts: ok({ adverts: [] }),
  });
  const { log, lines } = recorder();
  const reads = await pollJiji(browser, log);
  assert.equal(reads.rooms, null);
  assert.ok(lines.some((l) => l.includes("push poll read failed")));
  assert.ok(lines.some((l) => l.includes('"error_code":"ECONNRESET"')));
  assertNoLeak(lines, "poll guard");
});

test("a browser error during a tick logs no part of the error message", async (t) => {
  const h = await harness(t, {
    responses: {
      chat_rooms: ok({ status: "ok", results: [] }),
      notifications: ok({ notifications: [] }),
      my_adverts: ok({ adverts: [] }),
    },
    status: async () => {
      throw leaky();
    },
  });
  assert.deepEqual(await h.push.tick(), { skipped: "browser_error" });
  assert.ok(h.lines.some((l) => l.includes("browser error")));
  assertNoLeak(h.lines, "browser.run");
});

test("a failed scheduled tick logs no part of the error message", async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { log, lines } = recorder();
  const push = await startPushNotifications({
    env: env(),
    runtimeDir: dir,
    browser: browserMock({
      chat_rooms: ok({ status: "ok", results: [] }),
      notifications: ok({ notifications: [] }),
      my_adverts: ok({ adverts: [] }),
    }),
    log,
    fetch: fetchMock(),
    resolve: publicDns,
    firstPollMs: 0,
  });
  t.after(() => push.stop());
  push.store.commit = () => {
    throw leaky();
  };
  for (let i = 0; i < 50 && !lines.some((l) => l.includes("poll failed")); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(lines.some((l) => l.includes("push poll failed")));
  assertNoLeak(lines, "schedule");
});

test("a local outbox failure logs no part of the error message", async () => {
  const { log, lines } = recorder();
  const store = {
    due: () => {
      throw leaky();
    },
    nextDueAt: () => undefined,
  };
  const outbox = new AlertOutbox(store, {}, { log });
  await outbox.kick();
  await outbox.close();
  assert.ok(lines.some((l) => l.includes("push alert outbox failed")));
  assertNoLeak(lines, "outbox");
});

test("an unusable state directory is reported without the error message", async () => {
  const dir = await tmp();
  try {
    const file = path.join(dir, "not-a-dir");
    await writeFile(file, "x");
    const { log, lines } = recorder();
    const push = await startPushNotifications({
      env: env({ JIJI_PUSH_STATE_DIR: path.join(file, "nested") }),
      log,
      resolve: publicDns,
    });
    assert.equal(push.enabled, false);
    assert.match(
      push.reason,
      /^Push state directory is unusable \(E[A-Z]+\)\.$/,
    );
    assert.ok(!lines.join("\n").includes(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Cross-poll ad status dedupe ---------------------------------------------

const approval = (id, extra = {}) => ({
  id,
  type: "advert_approved",
  text: "Your ad was approved",
  advert: { id: 99, title: "Car" },
  ...extra,
});
const car = (status) => ({ id: 99, status, title: "Car" });
// Runs polls in order, threading state, and returns every alert's event id.
function polls(reads, start = 1000, step = 60_000) {
  let state = fresh();
  const ids = [];
  reads.forEach((r, i) => {
    const out = detectEvents(state, r, start + i * step);
    state = out.next;
    ids.push(...out.events.map((e) => e.event_id));
  });
  return { ids, state };
}

test("my_adverts then a later approval notification alerts once", () => {
  const { ids } = polls([
    { notifications: [], adverts: [car("on_review")] },
    { notifications: [], adverts: [car("active")] },
    { notifications: [approval(8)], adverts: [car("active")] },
  ]);
  assert.deepEqual(ids, ["jiji:ad_status:99:1"]);
});

test("an approval notification then a later my_adverts transition alerts once", () => {
  const { ids } = polls([
    { notifications: [], adverts: [car("on_review")] },
    { notifications: [approval(8)], adverts: [car("on_review")] },
    { notifications: [approval(8)], adverts: [car("active")] },
  ]);
  assert.deepEqual(ids, ["jiji:notification:8"]);
});

test("a recorded approval does not hide a later rejection or a later approval", () => {
  const { ids } = polls([
    { notifications: [], adverts: [car("on_review")] },
    { notifications: [approval(8)], adverts: [car("on_review")] },
    { notifications: [approval(8)], adverts: [car("active")] },
    { notifications: [approval(8)], adverts: [car("declined")] },
    {
      notifications: [
        approval(8),
        approval(9, { type: "advert_declined", text: "Your ad was declined" }),
      ],
      adverts: [car("declined")],
    },
    { notifications: [approval(8)], adverts: [car("active")] },
  ]);
  assert.deepEqual(ids, [
    "jiji:notification:8",
    "jiji:ad_status:99:2",
    "jiji:ad_status:99:3",
  ]);
});

test("ad status pairing expires: known outcomes after 48h, unknown after 6h", () => {
  const later = (to, gap) => {
    const { state } = polls([
      { notifications: [], adverts: [car("on_review")] },
      { notifications: [], adverts: [car(to)] },
    ]);
    return detectEvents(
      state,
      { notifications: [approval(8)], adverts: [car(to)] },
      61_000 + gap,
    ).events.length;
  };
  assert.equal(later("active", AD_STATUS_DEDUPE_MS - 1), 0);
  assert.equal(later("active", AD_STATUS_DEDUPE_MS), 1);
  // "status_7" has no known outcome, so it pairs only within the loose window.
  assert.equal(later("status_7", AD_STATUS_LOOSE_DEDUPE_MS - 1), 0);
  assert.equal(later("status_7", AD_STATUS_LOOSE_DEDUPE_MS), 1);
});

test("ad status pairing survives a restart; bad entries are dropped on load", async () => {
  const dir = await tmp();
  try {
    const { state } = polls([
      { notifications: [], adverts: [car("on_review")] },
      { notifications: [], adverts: [car("active")] },
    ]);
    let store = new PushStore(dir, { now: () => 61_000 });
    assert.equal(store.commit(state, []).result, "accepted");
    const file = path.join(dir, "push-state.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(Object.keys(saved.adStatus), ["jiji:ad_status:99:1"]);
    saved.adStatus.bad = { advert: "", via: "x", outcome: 1, at: "y" };
    await writeFile(file, JSON.stringify(saved));
    store = new PushStore(dir, { now: () => 121_000 });
    const loaded = store.snapshot();
    assert.deepEqual(Object.keys(loaded.adStatus), ["jiji:ad_status:99:1"]);
    const { events } = detectEvents(
      loaded,
      { notifications: [approval(8)], adverts: [car("active")] },
      121_000,
    );
    assert.deepEqual(events, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop during pagination reads no further page", async (t) => {
  let release;
  let entered;
  const reached = new Promise((r) => (entered = r));
  const h = await harness(t, {
    responses: {
      chat_rooms: (p) => {
        if (p.page) return ok({ status: "ok", results: [room(p.page, 1)] });
        entered();
        return new Promise((r) => (release = r));
      },
      notifications: ok({ notifications: [] }),
      my_adverts: ok({ adverts: [] }),
    },
  });
  const ticking = h.push.tick();
  await reached;
  const stopping = h.push.stop();
  release(ok({ status: "ok", results: [room(1, 10)], has_more: true }));
  await stopping;
  assert.deepEqual(await ticking, { skipped: "stopped" });
  assert.deepEqual(
    h.browser.calls.map((c) => [c.name, c.parameters.page]),
    [["chat_rooms", undefined]],
  );
});
