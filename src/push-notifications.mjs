// Notify-only push feed. The companion polls three read-only Jiji resources
// (chat rooms, notifications, your adverts) and POSTs new events to one
// configured HTTPS webhook. It never replies, never marks anything read, and
// never calls a Jiji write, action or workflow. The alert POST is its only
// outbound request.
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";

export const DEFAULT_POLL_MS = 60 * 1000;
export const MIN_POLL_MS = 15 * 1000;
export const MAX_POLL_MS = 15 * 60 * 1000;
export const DEFAULT_OUTBOX_MAX = 1000;
export const OUTBOX_MAX_LIMIT = 100000;
export const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Delivered event ids, and rooms/notifications/adverts not observed for this
// long, are forgotten. Anything still listed by Jiji is refreshed every poll.
export const SEEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// One ad status change can reach both my_adverts and notifications, in either
// order and in different polls. Each ad_status alert sent is remembered this
// long so its counterpart from the other source is dropped. When either side's
// outcome (approved, rejected, under review) is unknown, they pair only within
// the shorter window.
export const AD_STATUS_DEDUPE_MS = 48 * 60 * 60 * 1000;
export const AD_STATUS_LOOSE_DEDUPE_MS = 6 * 60 * 60 * 1000;
export const ALERT_TIMEOUT_MS = 20000;
export const PREVIEW_MAX = 280;
// Page cap for every paged push read (chat rooms, notifications, adverts).
export const MAX_PUSH_PAGES = 5;
// Only these catalog reads are used. None of them marks a chat read: opening a
// room (chat_messages or the conversation page) might, so it is never done.
export const PUSH_READS = Object.freeze([
  "chat_rooms",
  "notifications",
  "my_adverts",
]);
const DRAIN_ERROR_RETRY_MS = 5000;
// Largest delay setTimeout honours; anything above it fires after 1 ms.
const MAX_TIMER_MS = 2 ** 31 - 1;
const STATE_FILE = "push-state.json";
const TYPES = new Set(["chat_message", "offer", "ad_status"]);
const FORBIDDEN_AUTH_HEADERS = new Set([
  "host",
  "content-type",
  "content-length",
  "connection",
  "idempotency-key",
]);

export function backoffSeconds(attempts) {
  return Math.min(300, 2 ** Math.min(attempts + 1, 9));
}

const RETRYABLE_CODES = new Set([
  "webhook_network_error",
  "webhook_timeout",
  "webhook_dns_error",
  "webhook_dns_non_public",
]);
// Transport, DNS, 5xx, 408 and 429 can succeed later. Any other non-2xx (a
// 3xx or a 4xx such as 400, 401, 403, 404) will not, so it is dropped.
export function isRetryableFailure(code) {
  if (RETRYABLE_CODES.has(code)) return true;
  const status = Number(/^webhook_http_(\d{3})$/.exec(code ?? "")?.[1]);
  return status >= 500 || status === 408 || status === 429;
}

// --- Logging -----------------------------------------------------------------

// Log lines carry the webhook host, never its path, query or auth value.
export function consoleLog(level, message, fields = {}) {
  console.error(
    `[jiji-push] ${level} ${message}` +
      (Object.keys(fields).length ? " " + JSON.stringify(fields) : ""),
  );
}

// An error's message can quote a cookie, a token or a chat preview, so only
// its name and a short code are ever logged, and only when they look like
// identifiers. Never the message, the stack or the error itself.
export function safeErrorFields(err) {
  const fields = {};
  const name = err?.name;
  if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(name))
    fields.error_name = name;
  const code = err?.code;
  if (
    (typeof code === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(code)) ||
    (typeof code === "number" && Number.isSafeInteger(code))
  )
    fields.error_code = code;
  return fields;
}

const reasonCode = (err) => {
  const { error_code, error_name } = safeErrorFields(err);
  const code = error_code ?? error_name;
  return code === undefined ? "" : ` (${code})`;
};

// --- Config ------------------------------------------------------------------

function read(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  return text === "" ? undefined : text;
}

// Loopback, private, link-local, CGNAT and ULA ranges, IPv4-mapped included.
const NON_PUBLIC = new net.BlockList();
for (const [subnet, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
])
  NON_PUBLIC.addSubnet(subnet, prefix, "ipv4");
for (const [subnet, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
])
  NON_PUBLIC.addSubnet(subnet, prefix, "ipv6");

// The literal, synchronous check. `hostname` comes from WHATWG URL parsing, so
// IPv4 shorthand such as 0x7f.1 is already a dotted quad.
export function isNonPublicHost(hostname) {
  const host = String(hostname)
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[(.*)\]$/, "$1");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const family = net.isIP(host);
  if (family === 0) return false;
  return NON_PUBLIC.check(host, family === 4 ? "ipv4" : "ipv6");
}

const defaultResolve = (hostname, options) => dns.lookup(hostname, options);

// Every address must be public. A lookup error or empty answer fails closed.
export async function resolvesPublic(hostname, resolve = defaultResolve) {
  let addresses;
  try {
    addresses = await resolve(String(hostname).replace(/^\[(.*)\]$/, "$1"), {
      all: true,
    });
  } catch {
    return "unresolved";
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return "unresolved";
  return addresses.every(
    (a) => net.isIP(a?.address ?? "") !== 0 && !isNonPublicHost(a.address),
  )
    ? "public"
    : "non_public";
}

function readTarget(env) {
  const url = read(env, "JIJI_PUSH_WEBHOOK_URL");
  // The auth value is a secret compared byte for byte; only blank means unset.
  const rawValue = env.JIJI_PUSH_WEBHOOK_AUTH_VALUE;
  const value =
    rawValue === undefined || String(rawValue).trim() === ""
      ? undefined
      : String(rawValue);
  const header = read(env, "JIJI_PUSH_WEBHOOK_AUTH_HEADER") ?? "Authorization";
  if (url === undefined && value === undefined)
    return { reason: "JIJI_PUSH_WEBHOOK_URL is not set." };
  if (url === undefined || value === undefined)
    return {
      reason:
        "JIJI_PUSH_WEBHOOK_URL and JIJI_PUSH_WEBHOOK_AUTH_VALUE must be set together.",
    };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {
      reason: "JIJI_PUSH_WEBHOOK_URL must be an absolute https:// URL.",
    };
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    url.includes("#")
  )
    return {
      reason:
        "JIJI_PUSH_WEBHOOK_URL must be an https:// URL with no credentials and no fragment.",
    };
  if (isNonPublicHost(parsed.hostname))
    return {
      reason:
        "JIJI_PUSH_WEBHOOK_URL must not point at localhost or a loopback, private, link-local, CGNAT or ULA address.",
    };
  if (
    !/^[A-Za-z0-9-]+$/.test(header) ||
    FORBIDDEN_AUTH_HEADERS.has(header.toLowerCase())
  )
    return {
      reason:
        "JIJI_PUSH_WEBHOOK_AUTH_HEADER must be letters, digits and hyphens, and not Host, Content-Type, Content-Length, Connection or Idempotency-Key.",
    };
  if (/[\r\n]/.test(value))
    return {
      reason: "JIJI_PUSH_WEBHOOK_AUTH_VALUE must not contain a line break.",
    };
  return { target: { url: parsed.href, header, value, host: parsed.host } };
}

function bounded(env, name, fallback, min, max, log) {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const number = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(number)) {
    log("warn", `${name} is not an integer; using the default`, {
      default: fallback,
    });
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, number));
  if (clamped !== number)
    log("warn", `${name} is out of range; clamped`, { value: clamped });
  return clamped;
}

// Never throws. A missing or bad value disables the feed with a reason.
export function readPushConfig(
  env = {},
  { runtimeDir, log = consoleLog } = {},
) {
  const { target, reason } = readTarget(env);
  if (!target) return { enabled: false, reason };
  let stateDir = read(env, "JIJI_PUSH_STATE_DIR");
  if (stateDir !== undefined && !path.isAbsolute(stateDir))
    return {
      enabled: false,
      reason: "JIJI_PUSH_STATE_DIR must be an absolute path.",
    };
  if (stateDir === undefined) {
    if (!runtimeDir)
      return { enabled: false, reason: "No companion runtime directory." };
    stateDir = path.join(runtimeDir, "push-notifications");
  }
  return {
    enabled: true,
    target,
    stateDir,
    pollMs: bounded(
      env,
      "JIJI_PUSH_POLL_INTERVAL_MS",
      DEFAULT_POLL_MS,
      MIN_POLL_MS,
      MAX_POLL_MS,
      log,
    ),
    outboxMax: bounded(
      env,
      "JIJI_PUSH_WEBHOOK_OUTBOX_MAX",
      DEFAULT_OUTBOX_MAX,
      1,
      OUTBOX_MAX_LIMIT,
      log,
    ),
  };
}

// --- Payload -----------------------------------------------------------------

const isRecord = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v !== "";
const finite = (v) => typeof v === "number" && Number.isFinite(v);

export function isAlertPayload(value) {
  return (
    isRecord(value) &&
    value.source === "jiji" &&
    TYPES.has(value.type) &&
    nonEmpty(value.event_id) &&
    value.event_id.length <= 200 &&
    nonEmpty(value.occurred_at) &&
    typeof value.summary === "string" &&
    isRecord(value.data)
  );
}

function toOutboxItem(raw) {
  if (!isRecord(raw)) return undefined;
  const { id, payload, attempts, nextAttemptAt, enqueuedAt } = raw;
  if (
    !nonEmpty(id) ||
    !isAlertPayload(payload) ||
    payload.event_id !== id ||
    !finite(attempts) ||
    attempts < 0 ||
    !finite(nextAttemptAt) ||
    !finite(enqueuedAt)
  )
    return undefined;
  return { id, payload, attempts, nextAttemptAt, enqueuedAt };
}

// --- Store -------------------------------------------------------------------

const emptyState = () => ({
  version: 1,
  baselined: {},
  rooms: {},
  notifications: {},
  adverts: {},
  adStatus: {},
  seen: {},
  outbox: [],
});

function cleanMap(raw, valid) {
  const out = {};
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (k && valid(v)) out[k] = v;
  return out;
}

// Poll state, dedupe set and outbox in one 0600 JSON file, replaced
// atomically. Every method is synchronous, so writers never interleave.
// The outbox is bounded by count and by age. At the count cap a poll's new
// events are refused and its state is not advanced, so the next poll after
// the outbox drains detects them again.
export class PushStore {
  constructor(
    dir,
    {
      now = Date.now,
      log = consoleLog,
      outboxMax = DEFAULT_OUTBOX_MAX,
      outboxMaxAgeMs = OUTBOX_MAX_AGE_MS,
    } = {},
  ) {
    this.dir = dir;
    this.file = path.join(dir, STATE_FILE);
    this.now = now;
    this.log = log;
    this.outboxMax = outboxMax;
    this.outboxMaxAgeMs = outboxMaxAgeMs;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    this.state = this.load();
  }
  load() {
    if (!fs.existsSync(this.file)) return emptyState();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!isRecord(parsed) || !Array.isArray(parsed.outbox))
        throw new Error("bad shape");
      const outbox = [];
      let dropped = false;
      for (const [index, raw] of parsed.outbox.entries()) {
        const item = toOutboxItem(raw);
        if (item) outbox.push(item);
        else {
          dropped = true;
          // Never log the payload; it can hold message previews.
          this.log("warn", "invalid push outbox item dropped", { index });
        }
      }
      const atMap = (v) => isRecord(v) && finite(v.at);
      const clean = {
        version: 1,
        baselined: cleanMap(parsed.baselined, (v) => v === true),
        rooms: cleanMap(parsed.rooms, (v) => atMap(v) && nonEmpty(v.marker)),
        notifications: cleanMap(parsed.notifications, atMap),
        adverts: cleanMap(
          parsed.adverts,
          (v) => atMap(v) && nonEmpty(v.status) && Number.isInteger(v.rev),
        ),
        adStatus: cleanMap(
          parsed.adStatus,
          (v) =>
            atMap(v) &&
            nonEmpty(v.advert) &&
            AD_STATUS_SOURCES.has(v.via) &&
            (v.outcome === null || AD_OUTCOMES.has(v.outcome)),
        ),
        seen: cleanMap(parsed.seen, finite),
        outbox,
      };
      if (dropped) this.persist(clean);
      return clean;
    } catch {
      // Keep the unreadable file for the operator. Starting empty means a
      // fresh baseline (no alerts), never a flood of old items.
      const aside = `${this.file}.corrupt-${this.now()}`;
      fs.renameSync(this.file, aside);
      this.log(
        "error",
        "push state was unreadable; set aside and started empty",
        {
          file: aside,
        },
      );
      return emptyState();
    }
  }
  persist(next) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.state = next;
  }
  snapshot() {
    return structuredClone(this.state);
  }
  pruneAged() {
    const now = this.now();
    const kept = this.state.outbox.filter((item) => {
      if (now - item.enqueuedAt < this.outboxMaxAgeMs) return true;
      this.log("warn", "push alert expired undelivered; dropped", {
        event_id: item.id,
        attempts: item.attempts,
      });
      return false;
    });
    if (kept.length !== this.state.outbox.length)
      this.persist({ ...this.state, outbox: kept });
  }
  // Commit one poll: the next tracking state plus new alert payloads. All or
  // nothing. Returns "outbox_full" without recording anything at the cap.
  commit(next, payloads) {
    this.pruneAged();
    const now = this.now();
    const seen = {};
    for (const [id, at] of Object.entries(this.state.seen))
      if (now - at < SEEN_RETENTION_MS) seen[id] = at;
    const queued = this.state.outbox.map((item) => item.id);
    const fresh = [];
    for (const payload of payloads)
      if (
        !(payload.event_id in seen) &&
        !queued.includes(payload.event_id) &&
        !fresh.some((p) => p.event_id === payload.event_id)
      )
        fresh.push(payload);
    if (
      fresh.length &&
      this.state.outbox.length + fresh.length > this.outboxMax
    )
      return { result: "outbox_full", queued: 0 };
    for (const payload of fresh) seen[payload.event_id] = now;
    this.persist({
      version: 1,
      baselined: next.baselined,
      rooms: next.rooms,
      notifications: next.notifications,
      adverts: next.adverts,
      adStatus: next.adStatus ?? {},
      seen,
      outbox: [
        ...this.state.outbox,
        ...fresh.map((payload) => ({
          id: payload.event_id,
          payload,
          attempts: 0,
          nextAttemptAt: now,
          enqueuedAt: now,
        })),
      ],
    });
    return { result: "accepted", queued: fresh.length };
  }
  due() {
    this.pruneAged();
    const now = this.now();
    return this.state.outbox.find((item) => item.nextAttemptAt <= now);
  }
  nextDueAt() {
    let next;
    for (const { nextAttemptAt } of this.state.outbox)
      if (finite(nextAttemptAt) && (next === undefined || nextAttemptAt < next))
        next = nextAttemptAt;
    return next;
  }
  depth() {
    return this.state.outbox.length;
  }
  delivered(id) {
    this.persist({
      ...this.state,
      outbox: this.state.outbox.filter((item) => item.id !== id),
    });
  }
  failed(id) {
    this.persist({
      ...this.state,
      outbox: this.state.outbox.map((item) =>
        item.id === id
          ? {
              ...item,
              attempts: item.attempts + 1,
              nextAttemptAt: this.now() + backoffSeconds(item.attempts) * 1000,
            }
          : item,
      ),
    });
  }
}

// --- Outbound ------------------------------------------------------------------

// 2xx = accepted. A 3xx is a failure and is never followed. The host is
// resolved again first; a non-public or unresolved answer sends nothing.
export async function sendAlert(
  target,
  payload,
  {
    fetch: fetchImpl = globalThis.fetch,
    resolve = defaultResolve,
    timeoutMs = ALERT_TIMEOUT_MS,
  } = {},
) {
  let verdict;
  try {
    verdict = await resolvesPublic(new URL(target.url).hostname, resolve);
  } catch {
    verdict = "unresolved";
  }
  if (verdict !== "public")
    return {
      ok: false,
      code:
        verdict === "non_public"
          ? "webhook_dns_non_public"
          : "webhook_dns_error",
    };
  let response;
  try {
    response = await fetchImpl(target.url, {
      method: "POST",
      headers: {
        [target.header]: target.value,
        "Content-Type": "application/json",
        "Idempotency-Key": payload.event_id,
      },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel?.();
  } catch (e) {
    return {
      ok: false,
      code:
        e?.name === "TimeoutError"
          ? "webhook_timeout"
          : "webhook_network_error",
    };
  }
  return response.status >= 200 && response.status < 300
    ? { ok: true }
    : { ok: false, code: `webhook_http_${response.status}` };
}

// Drains one alert at a time, oldest first, then arms a timer for the next due.
export class AlertOutbox {
  constructor(
    store,
    target,
    { fetch, resolve, log = consoleLog, now = Date.now, timeoutMs } = {},
  ) {
    this.store = store;
    this.target = target;
    this.send = { fetch, resolve, timeoutMs };
    this.log = log;
    this.now = now;
    this.draining = undefined;
    this.again = false;
    this.timer = undefined;
    this.closed = false;
  }
  kick() {
    if (this.closed) return Promise.resolve();
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.again) {
        this.again = false;
        void this.kick();
      } else this.schedule();
    });
    return this.draining;
  }
  async drain() {
    try {
      for (let item = this.store.due(); item; item = this.store.due()) {
        if (this.closed) return;
        const result = await sendAlert(this.target, item.payload, this.send);
        const fields = { event_id: item.id, type: item.payload.type };
        if (result.ok) {
          this.store.delivered(item.id);
          this.log("info", "push alert accepted", fields);
        } else if (!isRetryableFailure(result.code)) {
          this.store.delivered(item.id);
          this.log("warn", "push alert rejected; dropped", {
            ...fields,
            code: result.code,
            attempts: item.attempts + 1,
          });
        } else {
          this.store.failed(item.id);
          this.log("warn", "push alert failed; will retry", {
            ...fields,
            code: result.code,
            attempts: item.attempts + 1,
          });
        }
      }
    } catch (e) {
      // Local state failed (disk full, permissions). Retry later, never spin.
      this.log("error", "push alert outbox failed", safeErrorFields(e));
      this.arm(DRAIN_ERROR_RETRY_MS);
    }
  }
  schedule() {
    if (this.closed || this.timer !== undefined) return;
    const next = this.store.nextDueAt();
    if (next === undefined) return;
    this.arm(next - this.now());
  }
  // Never hand setTimeout a non-finite or oversized delay: both fire in 1 ms.
  arm(delayMs) {
    clearTimeout(this.timer);
    const delay = Number.isFinite(delayMs)
      ? Math.min(Math.max(0, delayMs), MAX_TIMER_MS)
      : DRAIN_ERROR_RETRY_MS;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.kick();
    }, delay);
    this.timer.unref?.();
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.draining;
  }
}

// --- Detection -----------------------------------------------------------------
// Jiji's private web API is not documented. Rooms are read from the same
// `{status: "ok", results: [...]}` shape listingRoom already relies on. Field
// names for the last message, unread count, offers, notification kind and
// advert status are tried in the order below; anything not found is treated
// as unknown rather than guessed.

const short = (v, max = PREVIEW_MAX) => {
  if (typeof v !== "string") return null;
  const text = v.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
};
const first = (obj, keys) => {
  if (!isRecord(obj)) return undefined;
  for (const k of keys)
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
};
const idOf = (v) =>
  (typeof v === "number" && Number.isSafeInteger(v)) ||
  (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(v))
    ? String(v)
    : null;
const digest = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 24);
const isoTime = (v, fallback) => {
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v < 1e12 ? v * 1000 : v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date(fallback).toISOString();
};
const countOf = (v) => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
function amountOf(v) {
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) v = Number(v);
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (isRecord(v)) return amountOf(first(v, ["amount", "price", "value"]));
  return null;
}
// An offer is `true`, a positive amount, or an offer-typed message. A present
// but false, zero or empty field (offer: false, 0, "") is not an offer.
function offerSignal(obj) {
  if (!isRecord(obj)) return null;
  const raw = first(obj, [
    "offer",
    "make_an_offer",
    "offer_amount",
    "offer_price",
    "price_offer",
  ]);
  const amount = amountOf(raw);
  if (amount !== null) return { amount };
  const kind = first(obj, ["type", "message_type", "kind"]);
  if (raw === true || (typeof kind === "string" && /offer/i.test(kind)))
    return { amount: null };
  return null;
}

export function roomRows(body) {
  return isRecord(body) && body.status === "ok" && Array.isArray(body.results)
    ? body.results
    : null;
}

export function readRoom(row) {
  if (!isRecord(row)) return null;
  const roomId = idOf(first(row, ["room_id", "id"]));
  if (!roomId) return null;
  let last = first(row, ["last_message", "message", "last_msg"]);
  if (typeof last === "string") last = { text: last };
  if (!isRecord(last)) last = {};
  const lastId = idOf(first(last, ["id", "msg_id", "message_id"]));
  const rawText =
    first(last, ["text", "message", "body"]) ??
    first(row, ["last_message_text", "preview", "text"]);
  const preview = short(typeof rawText === "string" ? rawText : null);
  const at =
    first(last, ["created_at", "date", "created", "timestamp"]) ??
    first(row, ["last_message_date", "updated_at", "date"]);
  const unread = countOf(
    first(row, [
      "unread_count",
      "unread",
      "new_messages_count",
      "unread_messages_count",
      "unread_messages",
    ]),
  );
  const outgoing =
    [last.is_my, last.is_own, last.mine, last.own, last.is_owner].includes(
      true,
    ) ||
    last.direction === "out" ||
    last.direction === "outgoing";
  const basis =
    lastId ??
    [
      typeof at === "string" || typeof at === "number" ? String(at) : "",
      preview ?? "",
      at === undefined && !preview ? String(unread ?? "") : "",
    ].join("\n");
  if (!basis.trim()) return null;
  return {
    roomId,
    marker: lastId ? "id:" + lastId : "h:" + digest(basis),
    unread,
    outgoing,
    offer: offerSignal(last) ?? offerSignal(row),
    preview,
    at,
    peer: short(first(row.user, ["user_name", "name", "full_name"]), 80),
    listingTitle: short(first(row.advert, ["title"]), 140),
    listingUrl: typeof row.advert?.url === "string" ? row.advert.url : null,
  };
}

export function notificationRows(body) {
  if (!isRecord(body)) return null;
  for (const key of ["notifications", "results", "items", "data", "list"]) {
    const v = body[key];
    if (Array.isArray(v)) return v;
    if (isRecord(v) && Array.isArray(v.notifications)) return v.notifications;
  }
  return null;
}

const AD_STATUS = /(approv|reject|declin|block|banned|moderat|publish)/i;
export function readNotification(row) {
  if (!isRecord(row)) return null;
  const id = idOf(first(row, ["id", "guid", "notification_id"]));
  if (!id) return null;
  const kind = String(first(row, ["type", "kind", "event", "category"]) ?? "");
  const text = short(
    [first(row, ["title"]), first(row, ["text", "message", "body"])]
      .filter((v) => typeof v === "string")
      .join(" — "),
  );
  const both = kind + " " + (text ?? "");
  const type = /offer/i.test(both)
    ? "offer"
    : AD_STATUS.test(both)
      ? "ad_status"
      : null;
  const advert = isRecord(row.advert) ? row.advert : {};
  return {
    id,
    type,
    kind: short(kind, 60),
    text,
    at: first(row, ["created_at", "date", "created", "timestamp"]),
    offer: offerSignal(row),
    advertId: idOf(first(advert, ["id", "guid"]) ?? row.advert_id),
    advertTitle: short(first(advert, ["title"]), 140),
  };
}

export function advertRows(body) {
  if (!isRecord(body)) return null;
  for (const v of [
    body.adverts,
    body.adverts_list?.adverts,
    body.results,
    body.data?.adverts,
    body.items,
  ])
    if (Array.isArray(v)) return v;
  return null;
}

export function readAdvert(row) {
  if (!isRecord(row)) return null;
  const id = idOf(first(row, ["id", "guid", "advert_id"]));
  let status = first(row, [
    "status",
    "state",
    "moderation_status",
    "advert_status",
  ]);
  if (isRecord(status))
    status = first(status, ["name", "value", "code", "title"]);
  status = short(typeof status === "string" ? status.toLowerCase() : null, 60);
  if (!id || !status) return null;
  return {
    id,
    status,
    title: short(first(row, ["title"]), 140),
    url: typeof row.url === "string" ? row.url : null,
  };
}

function payload(type, eventId, occurredAt, summary, data) {
  return {
    source: "jiji",
    type,
    event_id: eventId,
    occurred_at: occurredAt,
    summary: short(summary, 400) ?? "",
    data,
  };
}

// Coarse outcome of an ad status, so an approval never cancels a later
// rejection. Rejection words are checked first: "declined after moderation".
const AD_OUTCOMES = new Set(["rejected", "approved", "review"]);
const AD_STATUS_SOURCES = new Set(["my_adverts", "notifications"]);
function adOutcome(text) {
  if (typeof text !== "string") return null;
  if (/reject|declin|block|banned/i.test(text)) return "rejected";
  if (/inactiv|deactiv/i.test(text)) return null;
  if (/approv|publish|activ|\blive\b/i.test(text)) return "approved";
  if (/review|moderat|pending/i.test(text)) return "review";
  return null;
}

// Drops an ad_status alert whose counterpart from the other source was sent
// recently, consuming that record so it pairs once. Otherwise records it.
function pairAdStatus(recent, event, outcome, now) {
  const advert = event.data.advert_id;
  for (const [key, r] of Object.entries(recent)) {
    if (r.advert !== advert || r.via === event.data.via) continue;
    const known = r.outcome !== null && outcome !== null;
    if (known && r.outcome !== outcome) continue;
    if (now - r.at >= (known ? AD_STATUS_DEDUPE_MS : AD_STATUS_LOOSE_DEDUPE_MS))
      continue;
    delete recent[key];
    return false;
  }
  recent[event.event_id] = { advert, via: event.data.via, outcome, at: now };
  return true;
}

const forget = (map, now) =>
  Object.fromEntries(
    Object.entries(map).filter(([, v]) => now - v.at < SEEN_RETENTION_MS),
  );

// Pure: previous tracking state + fresh reads → next state and alerts. A
// source that failed to read (null) is left untouched. A source seen for the
// first time is baselined: everything is recorded and nothing alerts.
export function detectEvents(state, reads, now) {
  const next = {
    baselined: { ...state.baselined },
    rooms: { ...state.rooms },
    notifications: { ...state.notifications },
    adverts: { ...state.adverts },
  };
  const events = [];
  if (reads.rooms) {
    const alert = next.baselined.rooms === true;
    for (const raw of reads.rooms) {
      const room = readRoom(raw);
      if (!room) continue;
      const prev = state.rooms[room.roomId];
      next.rooms[room.roomId] = { marker: room.marker, at: now };
      // Unknown unread (no count field) never alerts: without it a reply
      // sent from another device would look like a new incoming message.
      if (
        !alert ||
        prev?.marker === room.marker ||
        room.outgoing ||
        room.unread === null ||
        room.unread === 0
      )
        continue;
      const type = room.offer ? "offer" : "chat_message";
      const who = room.peer ?? "a Jiji user";
      const about = room.listingTitle ? ` about "${room.listingTitle}"` : "";
      events.push(
        payload(
          type,
          `jiji:${type}:${room.roomId}:${room.marker}`,
          isoTime(room.at, now),
          type === "offer"
            ? `Offer${room.offer.amount ? ` of ₦${room.offer.amount}` : ""} from ${who}${about}`
            : `New Jiji message from ${who}${about}`,
          {
            via: "chat_rooms",
            room_id: room.roomId,
            chat_url: `/profile-messages/${room.roomId}`,
            peer: room.peer,
            listing_title: room.listingTitle,
            listing_url: room.listingUrl,
            unread: room.unread,
            preview: room.preview,
            ...(room.offer ? { offer_amount: room.offer.amount } : {}),
          },
        ),
      );
    }
    next.baselined.rooms = true;
  }
  if (reads.notifications) {
    const alert = next.baselined.notifications === true;
    for (const raw of reads.notifications) {
      const n = readNotification(raw);
      if (!n) continue;
      const known = n.id in state.notifications;
      next.notifications[n.id] = { at: now };
      if (!alert || known || !n.type) continue;
      events.push(
        payload(
          n.type,
          `jiji:notification:${n.id}`,
          isoTime(n.at, now),
          n.text ??
            `Jiji ${n.type === "offer" ? "offer" : "ad status"} notification`,
          {
            via: "notifications",
            notification_id: n.id,
            kind: n.kind,
            text: n.text,
            advert_id: n.advertId,
            advert_title: n.advertTitle,
            ...(n.offer ? { offer_amount: n.offer.amount } : {}),
          },
        ),
      );
    }
    next.baselined.notifications = true;
  }
  if (reads.adverts) {
    const alert = next.baselined.adverts === true;
    for (const raw of reads.adverts) {
      const ad = readAdvert(raw);
      if (!ad) continue;
      const prev = state.adverts[ad.id];
      if (!prev || prev.status === ad.status) {
        next.adverts[ad.id] = {
          status: ad.status,
          rev: prev?.rev ?? 0,
          at: now,
        };
        continue;
      }
      // rev keeps a repeated transition (rejected → active → rejected) distinct.
      const rev = prev.rev + 1;
      next.adverts[ad.id] = { status: ad.status, rev, at: now };
      if (!alert) continue;
      events.push(
        payload(
          "ad_status",
          `jiji:ad_status:${ad.id}:${rev}`,
          new Date(now).toISOString(),
          `Ad${ad.title ? ` "${ad.title}"` : ""} status: ${prev.status} → ${ad.status}`,
          {
            via: "my_adverts",
            advert_id: ad.id,
            title: ad.title,
            url: ad.url,
            from: prev.status,
            to: ad.status,
          },
        ),
      );
    }
    next.baselined.adverts = true;
  }
  // One approval can show up as both an advert status change and a
  // notification. In the same poll the my_adverts transition always wins;
  // across polls whichever alerted first wins (see AD_STATUS_DEDUPE_MS).
  const recent = Object.fromEntries(
    Object.entries(state.adStatus ?? {}).filter(
      ([, r]) => now - r.at < AD_STATUS_DEDUPE_MS,
    ),
  );
  const isAd = (e, via) =>
    e.type === "ad_status" && e.data.via === via && e.data.advert_id;
  const dropped = new Set();
  const changed = new Set();
  for (const e of events.filter((e) => isAd(e, "my_adverts"))) {
    changed.add(e.data.advert_id);
    if (!pairAdStatus(recent, e, adOutcome(e.data.to), now)) dropped.add(e);
  }
  for (const e of events.filter((e) => isAd(e, "notifications")))
    if (
      changed.has(e.data.advert_id) ||
      !pairAdStatus(
        recent,
        e,
        adOutcome(`${e.data.kind ?? ""} ${e.data.text ?? ""}`),
        now,
      )
    )
      dropped.add(e);
  next.adStatus = recent;
  next.rooms = forget(next.rooms, now);
  next.notifications = forget(next.notifications, now);
  next.adverts = forget(next.adverts, now);
  return { next, events: events.filter((e) => !dropped.has(e)) };
}

// --- Polling -------------------------------------------------------------------

// Each source fails independently: a failed read returns null and keeps the
// stored state for that source. Only PUSH_READS go through the browser.
export async function pollJiji(browser, log = consoleLog) {
  const get = async (name, parameters = {}) => {
    if (!PUSH_READS.includes(name)) throw new Error("Not a push read.");
    const r = await browser.readResource(name, parameters);
    if (r?.error || r?.status !== 200) {
      log("warn", "push poll read skipped", {
        resource: name,
        ...(r?.status ? { status: r.status } : {}),
      });
      return null;
    }
    return r.body;
  };
  const guard = async (name, fn) => {
    try {
      return await fn();
    } catch (e) {
      log("warn", "push poll read failed", {
        resource: name,
        ...safeErrorFields(e),
      });
      return null;
    }
  };
  // Up to MAX_PUSH_PAGES pages. Follows only an explicit next-page signal; a
  // page with no new ids stops it. A failed later page keeps earlier pages.
  const paged = (name, rowsOf, idOfRow) =>
    guard(name, async () => {
      const all = [];
      const ids = new Set();
      for (let page = 1; page <= MAX_PUSH_PAGES; page++) {
        const body = await get(name, page === 1 ? {} : { page });
        const rows = body && rowsOf(body);
        if (!rows) return page === 1 ? null : all;
        const fresh = rows.filter((r) => {
          const id = idOfRow(r);
          if (!id || ids.has(id)) return false;
          ids.add(id);
          return true;
        });
        all.push(...fresh);
        const more =
          body.next_url ||
          body.adverts_list?.next_url ||
          body.has_more === true;
        if (!fresh.length || !more) break;
      }
      return all;
    });
  const rooms = await paged("chat_rooms", roomRows, (r) => readRoom(r)?.roomId);
  const notifications = await paged(
    "notifications",
    notificationRows,
    (r) => readNotification(r)?.id,
  );
  const adverts = await paged(
    "my_adverts",
    advertRows,
    (r) => readAdvert(r)?.id,
  );
  return { rooms, notifications, adverts };
}

// Never throws. Returns a handle whose stop() clears every timer.
export async function startPushNotifications({
  env = process.env,
  runtimeDir,
  browser,
  isEnabled = () => true,
  log = consoleLog,
  fetch: fetchImpl = globalThis.fetch,
  resolve = defaultResolve,
  now = Date.now,
  firstPollMs = 0,
} = {}) {
  const off = (reason) => {
    log("info", "push notifications disabled", { reason });
    return {
      enabled: false,
      reason,
      status: () => ({ enabled: false, reason }),
      tick: async () => ({ skipped: "disabled" }),
      stop: async () => {},
    };
  };
  let config;
  try {
    config = readPushConfig(env, { runtimeDir, log });
  } catch (e) {
    return off(`Push config could not be read${reasonCode(e)}.`);
  }
  if (!config.enabled) return off(config.reason);
  const { target } = config;
  const verdict = await resolvesPublic(new URL(target.url).hostname, resolve);
  if (verdict !== "public")
    return off(
      verdict === "non_public"
        ? `Webhook host ${target.host} resolves to a non-public address.`
        : `Webhook host ${target.host} did not resolve.`,
    );
  let store;
  try {
    store = new PushStore(config.stateDir, {
      now,
      log,
      outboxMax: config.outboxMax,
    });
  } catch (e) {
    return off(`Push state directory is unusable${reasonCode(e)}.`);
  }
  const outbox = new AlertOutbox(store, target, {
    fetch: fetchImpl,
    resolve,
    log,
    now,
  });
  let timer;
  let closed = false;
  // stop() waits for these so a tick never persists after the outbox closes.
  const running = new Set();
  function tick() {
    const run = poll();
    running.add(run);
    const clear = () => running.delete(run);
    run.then(clear, clear);
    return run;
  }
  async function poll() {
    if (closed) return { skipped: "stopped" };
    if (!isEnabled()) {
      log("info", "push poll skipped; companion is disconnected");
      return { skipped: "disconnected" };
    }
    let reads;
    try {
      reads = await browser.run(async () => {
        const status = await browser.status();
        if (status.browser_open && !status.signed_in) return null;
        return pollJiji(browser, log);
      });
    } catch (e) {
      log("warn", "push poll skipped; browser error", safeErrorFields(e));
      return { skipped: "browser_error" };
    }
    if (!reads) {
      log("info", "push poll skipped; Jiji is not signed in");
      return { skipped: "signed_out" };
    }
    if (closed) return { skipped: "stopped" };
    const { next, events } = detectEvents(store.snapshot(), reads, now());
    const done = store.commit(next, events);
    if (done.result === "outbox_full")
      log("warn", "push outbox is full; new events wait for the next poll", {
        depth: store.depth(),
        max: config.outboxMax,
      });
    else if (done.queued) void outbox.kick();
    return { ...done, events: events.length };
  }
  function schedule(delay) {
    if (closed) return;
    timer = setTimeout(async () => {
      timer = undefined;
      await tick().catch((e) =>
        log("error", "push poll failed", safeErrorFields(e)),
      );
      schedule(config.pollMs);
    }, delay);
    timer.unref?.();
  }
  log("info", "push notifications enabled", {
    host: target.host,
    poll_ms: config.pollMs,
    outbox_max: config.outboxMax,
  });
  void outbox.kick();
  schedule(firstPollMs);
  return {
    enabled: true,
    status: () => ({
      enabled: true,
      host: target.host,
      poll_ms: config.pollMs,
      outbox_depth: store.depth(),
    }),
    tick,
    store,
    outbox,
    async stop() {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      await Promise.allSettled(running);
      await outbox.close();
    },
  };
}
