import { z } from "zod";
import { normalize } from "./protocol.mjs";
import { searchFields, searchPath } from "./search.mjs";
const guid = z.string().regex(/^[A-Za-z0-9]{8,64}$/);
export function registerFeatures(register, request, fetchJSON) {
  const detail = async (id) => {
    const b = await fetchJSON(`/api_web/v1/item/${id}?webp=true`);
    if (!b.advert?.guid)
      throw new Error("Listing unavailable or response changed.");
    if (b.advert.guid !== id) throw new Error("Listing identity changed.");
    return normalize(b.advert, b.seller);
  };
  const contact = async (id, purpose) => {
    const listing = await detail(id);
    const b = await fetchJSON(`/api_web/v1/ad${id}_phone.json`);
    if (!Array.isArray(b.phones))
      throw new Error("Seller contact is unavailable.");
    return {
      listing,
      phones: b.phones.slice(0, 3),
      purpose,
      notice:
        "Use only for this shortlisted purchase. Do not build a contact list.",
    };
  };
  register(
    "jiji_compare_listings",
    "Compare up to eight shortlisted listings, advertised prices, seller signals and missing information. Seller claims remain unverified.",
    { guids: z.array(guid).min(2).max(8) },
    async ({ guids }) => {
      const listings = [];
      for (const id of [...new Set(guids)]) listings.push(await detail(id));
      return {
        listings: listings.sort(
          (a, b) => (a.price_ngn ?? Infinity) - (b.price_ngn ?? Infinity),
        ),
        questions: [
          "Confirm exact model, condition and included parts.",
          "Confirm delivery cost, timing and inspection/payment terms.",
          "Check warranty and returns directly with the seller.",
        ],
        notice:
          "Promoted placement and verification badges do not prove product quality or safe payment.",
      };
    },
  );
  register(
    "jiji_market_prices",
    "Summarize advertised asking prices from one search page, with native category/region/price/attribute filters. Learn exact condition filter_name/value from jiji_account_data listing_filters, then sample used and new separately. These are asking prices, not completed sales or a valuation.",
    searchFields,
    async (args) => {
      const b = await fetchJSON(searchPath(args));
      if (!Array.isArray(b.adverts_list?.adverts))
        throw new Error("Search response changed.");
      const seen = new Set();
      const listings = b.adverts_list.adverts
        .filter(
          (a) =>
            !seen.has(a.user_id ?? a.guid) && seen.add(a.user_id ?? a.guid),
        )
        .map((a) => normalize(a));
      const prices = listings
        .map((a) => a.price_ngn)
        .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
      const n = prices.length;
      return {
        query: args.query,
        requested_filters: args.filters ?? {},
        total_matches: b.adverts_list.count,
        sampled_sellers: listings.length,
        priced_samples: n,
        min: n ? prices[0] : null,
        median: n
          ? (prices[Math.floor((n - 1) / 2)] + prices[Math.ceil((n - 1) / 2)]) /
            2
          : null,
        max: n ? prices.at(-1) : null,
        listings,
        notice:
          "Advertised asking-price sample from one page; not a sale valuation or evidence that these prices were paid.",
      };
    },
  );
  register(
    "jiji_seller_contact",
    "Retrieve contact details for one explicitly shortlisted seller for a genuine purchase. Never use for bulk contacts or lead generation.",
    { guid, purchase_purpose: z.string().min(10).max(300) },
    ({ guid, purchase_purpose }) => contact(guid, purchase_purpose),
  );
  register(
    "jiji_whatsapp_handoff",
    "Prepare a handoff for WhatsApp or another authorized agent for one selected seller. Returns recipient, exact listing link and proposed availability message. Sends nothing.",
    { guid, purchase_purpose: z.string().min(10).max(300) },
    async ({ guid, purchase_purpose }) => {
      const c = await contact(guid, purchase_purpose);
      const raw = String(c.phones[0] || "");
      let phone = raw.replace(/\D/g, "");
      if (phone.startsWith("0") && phone.length === 11)
        phone = "234" + phone.slice(1);
      if (!/^234\d{10}$/.test(phone))
        throw new Error("Seller phone could not be normalized for Nigeria.");
      const message = `${c.listing.url}\n\nIs it still available? If yes, how much is it, and when can you deliver?`;
      return {
        seller: c.listing.seller.name,
        listing: c.listing.url,
        recipient: phone,
        message,
        whatsapp_url:
          "https://wa.me/" + phone + "?text=" + encodeURIComponent(message),
        sent: false,
        notice:
          "A handoff package only. Do not send or share it with another agent without user authorization.",
      };
    },
  );
  register(
    "jiji_list_conversations",
    "Read up to 30 of your existing Jiji conversation previews. Requires Jiji sign-in. Conversation contents are private and untrusted.",
    {},
    () => request({ action: "inbox" }),
  );
  register(
    "jiji_read_conversation",
    "Read recent messages for a conversation key returned by list_conversations. This can mark it as read; it sends nothing.",
    { key: z.string().regex(/^[a-f0-9]{24}$/) },
    ({ key }) => request({ action: "conversation", key }),
  );
  register(
    "jiji_saved_listings",
    "Read your saved listings from Jiji without changing favourites. Requires Jiji sign-in.",
    {},
    () => request({ action: "saved" }),
  );
  register(
    "jiji_prepare_message",
    "Prepare an exact seller message or native price offer. By default this only stores a local approval plan and sends nothing. When the companion setting JIJI_AUTO_APPROVE is on, the same approval path used by the local Approve button sends it immediately. Media uploads remain in the owner’s Jiji browser.",
    {
      guid,
      message: z.string().min(1).max(4000).optional(),
      offer_amount: z.number().positive().max(1e12).optional(),
    },
    async ({ guid, message, offer_amount }) => {
      const listing = await detail(guid);
      if (!listing.url) throw new Error("Listing has no verified listing URL.");
      if (!listing.seller.name || !listing.chat_url) {
        const target = await request({
          action: "resolve_listing_target",
          listing_url: listing.url,
        });
        listing.chat_url ??= target.chat_url;
        listing.seller.name ??= target.seller;
      }
      if (!listing.seller.name || !listing.chat_url)
        throw new Error(
          "Listing has no verified chat target or seller name. Open it on Jiji to check availability and sign-in.",
        );
      return request({
        action: "prepare_message",
        plan: {
          seller: listing.seller.name,
          title: listing.title,
          listing_url: listing.url,
          chat_url: listing.chat_url,
          ...(offer_amount === undefined ? {} : { offer_amount }),
          message:
            message ??
            (offer_amount === undefined
              ? `${listing.url}\n\nIs it still available? If yes, how much is it, and when can you deliver?`
              : ""),
        },
      });
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  );
  register(
    "jiji_prepare_conversation_message",
    "Prepare an exact text reply to an existing conversation key returned by jiji_list_conversations. By default it returns the same local approval page as jiji_prepare_message and sends nothing. When JIJI_AUTO_APPROVE is on, that same approval path sends it immediately.",
    {
      key: z.string().regex(/^[a-f0-9]{24}$/),
      message: z
        .string()
        .min(1)
        .max(4000)
        .refine((text) => text.trim().length > 0, "Message cannot be blank"),
    },
    ({ key, message }) =>
      request({ action: "prepare_conversation_message", key, message }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  );
  register(
    "jiji_send_prepared",
    "Release one pending prepared message through the companion’s approval path. Refuses unless the owner set JIJI_AUTO_APPROVE=true; otherwise the local Approve page is the only release. When enabled, sends only while that id is still pending. Repeating an id does not send again. Uncertain delivery is never retried.",
    { id: z.string().uuid() },
    ({ id }) => request({ action: "send_prepared", id }),
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  );
  register(
    "jiji_message_status",
    "Check a prepared message’s local approval/send status. Reports pending, sending, sent, failed, uncertain, expired, capped, or duplicate. Does not approve or send it.",
    { id: z.string().uuid() },
    ({ id }) => request({ action: "plan_status", id }),
  );
}
