// Two-step advert writes: a preview plan carries a single-use approval token
// (only its hash is stored) and the canonical payload hash. Confirming needs
// both; the write re-checks the hash against Jiji's live form before sending.
// Advert plans are never released by JIJI_AUTO_APPROVE.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const digest = (token) => createHash("sha256").update(String(token)).digest();

export function prepareAdvertPlan(plans, prepared) {
  const token = randomBytes(24).toString("base64url");
  const plan = plans.prepare({
    type: "jiji_advert",
    operation: prepared.operation,
    parameters: prepared.parameters,
    title: prepared.title,
    purpose: prepared.notice,
    preview: prepared.preview,
    payload_hash: prepared.payload_hash,
    token_hash: digest(token).toString("hex"),
  });
  return { ...plan, approval_token: token };
}

function findPlan(plans, token, id) {
  const want = digest(token);
  // A stored hash of the wrong length makes timingSafeEqual throw; treat it
  // as no match so the caller sees the usual unknown-token error.
  const matches = (p) => {
    if (p.type !== "jiji_advert" || typeof p.token_hash !== "string")
      return false;
    try {
      return timingSafeEqual(Buffer.from(p.token_hash, "hex"), want);
    } catch {
      return false;
    }
  };
  if (id !== undefined) {
    const p = plans.plans.get(id);
    if (!p || !matches(p))
      throw new Error(
        "Approval token does not match this advert plan. Nothing was sent.",
      );
    return p;
  }
  for (const p of plans.plans.values()) if (matches(p)) return p;
  throw new Error(
    "Unknown or expired approval token. Nothing was sent; prepare a fresh preview.",
  );
}

// `send(plan)` performs the write; it must re-check plan.payload_hash.
export async function confirmAdvert(
  plans,
  send,
  { approval_token, payload_hash, id },
) {
  if (typeof approval_token !== "string" || approval_token.length < 16)
    throw new Error("approval_token is required. Nothing was sent.");
  const p = findPlan(plans, approval_token, id);
  if (p.state !== "pending")
    throw new Error(
      "This approval token was already used. It cannot submit again.",
    );
  if (p.expires <= Date.now()) {
    p.state = "expired";
    throw new Error(
      "Approval token expired. Nothing was sent; prepare a fresh preview.",
    );
  }
  if (payload_hash !== p.payload_hash) {
    p.state = "failed";
    p.result = {
      error: "payload_hash mismatch",
      message: "Nothing was sent. Prepare a fresh preview.",
    };
    throw new Error(
      "payload_hash does not match the previewed advert. Nothing was sent; this token is now void.",
    );
  }
  return plans.approve(p.id, send);
}
