import { randomUUID } from "node:crypto";
import { scrubProxySecrets } from "./runtime-policy.mjs";
export class ApprovalPlans {
  constructor() {
    this.plans = new Map();
  }
  prepare(value) {
    for (const [id, p] of this.plans)
      if (p.expires < Date.now() && p.state !== "sending")
        this.plans.delete(id);
    if (this.plans.size >= 100) throw new Error("Too many pending plans.");
    const plan = {
      ...value,
      id: randomUUID(),
      state: "pending",
      created: Date.now(),
      expires: Date.now() + 10 * 60000,
    };
    this.plans.set(plan.id, plan);
    return this.public(plan);
  }
  public(p) {
    const state =
      p.state === "pending" && p.expires <= Date.now() ? "expired" : p.state;
    return {
      id: p.id,
      type: p.type,
      seller: p.seller,
      title: p.title,
      listing_url: p.listing_url,
      message: p.message,
      offer_amount: p.offer_amount,
      state,
      ...(state === "capped" ? { blocked: true, limited: true } : {}),
      ...(state === "duplicate" ? { blocked: true } : {}),
      expires_at: new Date(p.expires).toISOString(),
      result: p.result,
      operation: p.operation,
      parameters: p.parameters,
      purpose: p.purpose,
      preview: p.preview,
      payload_hash: p.payload_hash,
    };
  }
  get(id) {
    const p = this.plans.get(id);
    if (!p) throw new Error("Plan not found.");
    return p;
  }
  async approve(id, send) {
    const p = this.get(id);
    if (p.state !== "pending")
      throw new Error(
        "This plan was already handled. It cannot be sent again.",
      );
    if (p.expires < Date.now()) {
      p.state = "expired";
      throw new Error("Plan expired. Prepare a new one.");
    }
    p.state = "sending";
    try {
      p.result = await send(p);
      p.state = p.type === "jiji_message" ? "sent" : "submitted";
      return this.public(p);
    } catch (e) {
      const nothingSent = e?.nothingSent === true;
      p.state = nothingSent ? "failed" : "uncertain";
      p.result = {
        error: scrubProxySecrets(String(e?.message), process.env),
        message: nothingSent
          ? "Nothing was sent. This plan will not be retried."
          : "No automatic retry. Check the result on Jiji before preparing another action.",
      };
      return this.public(p);
    }
  }
}
