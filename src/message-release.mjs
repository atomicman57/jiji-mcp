// Message release shares the approval-page path. Preparation itself never sends.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_DEDUPE_MS = 10 * 60 * 1000;
export const MAX_DEDUPE_MS = 24 * HOUR_MS;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function defined(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}
function flag(value, fallback, name) {
  if (!defined(value)) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (TRUTHY.has(text)) return true;
  if (FALSY.has(text)) return false;
  throw new Error(name + " must be true or false.");
}
function count(value, fallback, name, { max = 100000 } = {}) {
  if (!defined(value)) return fallback;
  const number =
    typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(number) || number < 0 || number > max)
    throw new Error(name + ` must be a non-negative integer up to ${max}.`);
  return number;
}

export function readSendSettings(env = {}, config = {}) {
  return {
    autoApprove: flag(
      defined(env.JIJI_AUTO_APPROVE)
        ? env.JIJI_AUTO_APPROVE
        : config.JIJI_AUTO_APPROVE,
      false,
      "JIJI_AUTO_APPROVE",
    ),
    logText: flag(
      defined(env.JIJI_SEND_LOG_TEXT)
        ? env.JIJI_SEND_LOG_TEXT
        : config.JIJI_SEND_LOG_TEXT,
      false,
      "JIJI_SEND_LOG_TEXT",
    ),
    hourlySendCap: count(
      defined(env.JIJI_HOURLY_SEND_CAP)
        ? env.JIJI_HOURLY_SEND_CAP
        : config.JIJI_HOURLY_SEND_CAP,
      null,
      "JIJI_HOURLY_SEND_CAP",
    ),
    dedupeMs: count(
      defined(env.JIJI_SEND_DEDUPE_MS)
        ? env.JIJI_SEND_DEDUPE_MS
        : config.JIJI_SEND_DEDUPE_MS,
      DEFAULT_DEDUPE_MS,
      "JIJI_SEND_DEDUPE_MS",
      { max: MAX_DEDUPE_MS },
    ),
  };
}

export function projectSendLog(entries, now, dedupeMs) {
  const keep = now - Math.max(HOUR_MS, dedupeMs);
  const byId = new Map();
  for (const row of entries) {
    if (!row || typeof row.at !== "number" || row.at < keep || !row.id)
      continue;
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, { ...row });
      continue;
    }
    byId.set(row.id, {
      ...prev,
      ...row,
      at: prev.counts ? prev.at : row.at,
      // A later outcome can drop a pre-send reservation. Idempotent rows do not.
      counts: row.revokeCount ? false : Boolean(prev.counts || row.counts),
      target: row.target ?? prev.target,
      text_sha256: row.text_sha256 ?? prev.text_sha256,
      text_length: Object.hasOwn(row, "text_length")
        ? row.text_length
        : prev.text_length,
      text: row.text ?? prev.text,
      offer: Object.hasOwn(row, "offer") ? row.offer : prev.offer,
    });
  }
  return [...byId.values()];
}

export function createMemoryLog(entries = []) {
  return {
    entries,
    async append(row) {
      this.entries.push(row);
    },
  };
}

export async function openSendLog(file, storage = fs) {
  const entries = [];
  try {
    const raw = await storage.readFile(file, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Ignore a torn final line from an interrupted append.
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return {
    entries,
    async append(row) {
      this.entries.push(row);
      await storage.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await storage.appendFile(file, JSON.stringify(row) + "\n", {
        mode: 0o600,
      });
      await storage.chmod(file, 0o600);
    },
  };
}

export function messageDigest(text) {
  const value = text ?? "";
  return {
    text_sha256: createHash("sha256").update(value).digest("hex"),
    text_length: value.length,
  };
}

function rowDigest(row) {
  if (row.text_sha256) return row.text_sha256;
  if (typeof row.text === "string") return messageDigest(row.text).text_sha256;
  return "";
}

// Sent and uncertain deliveries use a cap slot. A reservation is cleared when
// nothing was sent, including a plan that expires before the send starts.
function capOutcome(state, fields) {
  const counts = state === "sent" || state === "uncertain";
  return {
    ...fields,
    event: "outcome",
    state,
    counts,
    revokeCount: !counts,
  };
}

function fingerprint(plan, logText) {
  const text = plan.message ?? "";
  return {
    target: plan.chat_url || "",
    offer: plan.offer_amount === undefined ? null : plan.offer_amount,
    ...messageDigest(text),
    ...(logText ? { text } : {}),
  };
}

export function createRelease({ plans, send, log, settings, now = Date.now }) {
  const inflight = new Map();
  async function approve(id) {
    const current = inflight.get(id);
    if (current) return current;
    const run = approveOnce(id);
    inflight.set(id, run);
    try {
      return await run;
    } finally {
      if (inflight.get(id) === run) inflight.delete(id);
    }
  }
  async function record(row) {
    await log.append({ at: now(), ...row });
  }
  async function approveOnce(id) {
    const plan = plans.get(id);
    if (plan.type !== "jiji_message") return plans.approve(id, send);
    const fp = fingerprint(plan, settings.logText === true);
    if (plan.state !== "pending") {
      const current = plans.public(plan);
      await record({
        id,
        event: "idempotent",
        state: current.state,
        counts: false,
        ...fp,
      });
      return current;
    }
    if (plan.expires <= now()) {
      plan.state = "expired";
      await record({
        id,
        event: "outcome",
        state: "expired",
        counts: false,
        ...fp,
      });
      return plans.public(plan);
    }
    const recent = projectSendLog(log.entries, now(), settings.dedupeMs);
    const duplicate = recent.find(
      (row) =>
        row.id !== id &&
        row.target === fp.target &&
        rowDigest(row) === fp.text_sha256 &&
        row.offer === fp.offer &&
        row.at >= now() - settings.dedupeMs &&
        ["sending", "sent", "uncertain"].includes(row.state),
    );
    if (duplicate) {
      plan.state = "duplicate";
      plan.result = {
        blocked: true,
        duplicate_of: duplicate.id,
        message:
          "Identical text was already sent to this chat within the dedupe window. Nothing was sent.",
      };
      await record({
        id,
        event: "outcome",
        state: "duplicate",
        counts: false,
        blocked: true,
        duplicate_of: duplicate.id,
        ...fp,
      });
      return plans.public(plan);
    }
    const used = recent.filter(
      (row) => row.counts && row.at >= now() - HOUR_MS,
    ).length;
    if (
      Number.isInteger(settings.hourlySendCap) &&
      used >= settings.hourlySendCap
    ) {
      plan.state = "capped";
      plan.result = {
        blocked: true,
        limited: true,
        cap: settings.hourlySendCap,
        message: `Hourly send cap of ${settings.hourlySendCap} reached. Nothing was sent.`,
      };
      await record({
        id,
        event: "outcome",
        state: "capped",
        counts: false,
        blocked: true,
        limited: true,
        ...fp,
      });
      return plans.public(plan);
    }
    await record({
      id,
      event: "attempt",
      state: "sending",
      counts: true,
      seller: plan.seller,
      listing_url: plan.listing_url,
      ...fp,
    });
    let outcome;
    try {
      outcome = await plans.approve(id, send);
    } catch (e) {
      if (!/expired|already handled/.test(e.message)) throw e;
      const current = plans.public(plans.get(id));
      await record(capOutcome(current.state, { id, ...fp, error: e.message }));
      return current;
    }
    await record(
      capOutcome(outcome.state, { id, ...fp, error: outcome.result?.error }),
    );
    return outcome;
  }
  return { approve };
}

export async function finishPreparedMessage(autoApprove, prepared, release) {
  if (!autoApprove) return prepared;
  return release.approve(prepared.id);
}

export const SEND_PREPARED_DISABLED =
  "jiji_send_prepared requires JIJI_AUTO_APPROVE=true on the companion. Approve this message on the local approval page.";

export async function releasePrepared(autoApprove, release, id) {
  if (!autoApprove) throw new Error(SEND_PREPARED_DISABLED);
  return release.approve(id);
}
