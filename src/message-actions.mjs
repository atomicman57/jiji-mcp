import { chatUrl, listingUrl } from "./protocol.mjs";

// Shared by local and remote requests. Preparing never invokes send/approve.
export async function prepareMessageAction(browser, plans, request) {
  const plan =
    request.action === "prepare_conversation_message"
      ? await browser.run(() =>
          browser.prepareConversationMessage(request.key, request.message),
        )
      : request.plan;
  if (
    !plan ||
    typeof plan.seller !== "string" ||
    !plan.seller.trim() ||
    !listingUrl(plan.listing_url) ||
    !chatUrl(plan.chat_url) ||
    typeof plan.message !== "string" ||
    plan.message.length > 4000 ||
    (!plan.message.trim() && plan.offer_amount === undefined) ||
    (plan.offer_amount !== undefined &&
      (!Number.isFinite(plan.offer_amount) ||
        plan.offer_amount <= 0 ||
        plan.offer_amount > 1e12))
  )
    throw new Error("Message plan is incomplete.");
  return plans.prepare({
    type: "jiji_message",
    seller: plan.seller,
    title: plan.title,
    listing_url: listingUrl(plan.listing_url),
    chat_url: chatUrl(plan.chat_url),
    message: plan.message,
    ...(plan.offer_amount === undefined
      ? {}
      : { offer_amount: plan.offer_amount }),
  });
}
