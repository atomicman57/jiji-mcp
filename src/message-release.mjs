// Message release shares the approval-page path. Preparation itself never sends.
import fs from "node:fs/promises";
import path from "node:path";

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_HOURLY_SEND_CAP = 12;
export const DEFAULT_DEDUPE_MS = 10 * 60 * 1000;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function defined(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}
function flag(value, fallback) {
  if (!defined(value)) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (TRUTHY.has(text)) return true;
  if (FALSY.has(text)) return false;
  throw new Error("JIJI_AUTO_APPROVE must be true or false.");
}
function count(value, fallback, name) {
  if (!defined(value)) return fallback;
  const number =
    typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(number) || number < 0 || number > 100000)
    throw new Error(name + " must be a non-negative integer.");
  return number;
}

export function readSendSettings(env = {}, config = {}) {
  return {
    autoApprove: flag(
      defined(env.JIJI_AUTO_APPROVE)
        ? env.JIJI_AUTO_APPROVE
        : config.JIJI_AUTO_APPROVE,
      false,
    ),
    hourlySendCap: count(
      defined(env.JIJI_HOURLY_SEND_CAP)
        ? env.JIJI_HOURLY_SEND_CAP
        : config.JIJI_HOURLY_SEND_CAP,
      DEFAULT_HOURLY_SEND_CAP,
      "JIJI_HOURLY_SEND_CAP",
    ),
    dedupeMs: count(
      defined(env.JIJI_SEND_DEDUPE_MS)
        ? env.JIJI_SEND_DEDUPE_MS
        : config.JIJI_SEND_DEDUPE_MS,
      DEFAULT_DEDUPE_MS,
      "JIJI_SEND_DEDUPE_MS",
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
      counts: Boolean(prev.counts || row.counts),
      target: row.target ?? prev.target,
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

function fingerprint(plan) {
  return {
    target: plan.chat_url || "",
    text: plan.message ?? "",
    offer: plan.offer_amount === undefined ? null : plan.offer_amount,
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
    const fp = fingerprint(plan);
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
        row.text === fp.text &&
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
    if (used >= settings.hourlySendCap) {
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
      await record({
        id,
        event: "outcome",
        state: current.state,
        counts: false,
        ...fp,
        error: e.message,
      });
      return current;
    }
    await record({
      id,
      event: "outcome",
      state: outcome.state,
      counts: false,
      ...fp,
      error: outcome.result?.error,
    });
    return outcome;
  }
  return { approve };
}

export async function finishPreparedMessage(autoApprove, prepared, release) {
  if (!autoApprove) return prepared;
  return release.approve(prepared.id);
}
