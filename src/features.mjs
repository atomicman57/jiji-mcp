import { z } from "zod";
import { normalize } from "./protocol.mjs";
const guid = z.string().regex(/^[A-Za-z0-9]{8,64}$/);
export function registerFeatures(register, request, fetchJSON) {
  const detail = async (id) => {
    const b = await fetchJSON(`/api_web/v1/item/${id}?webp=true`);
    if (!b.advert?.guid)
      throw new Error("Listing unavailable or response changed.");
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
    "Summarize advertised prices from one Jiji search page for resale research. These are asking prices, not verified completed sales. Use separate queries for used/new models.",
    { query: z.string().min(2).max(200) },
    async ({ query }) => {
      const b = await fetchJSON(
        "/api_web/v1/listing?" +
          new URLSearchParams({
            query,
            init_page: "true",
            page: "1",
            webp: "false",
            sort: "rel",
          }),
      );
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
        query,
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
    "Prepare an exact seller message or native price offer for local owner review. Never sends by itself. The owner reviews the seller, listing, exact text and any offer amount on the companion approval page; there is no agent-callable send/approve tool. Media uploads remain in the owner’s Jiji browser.",
    {
      guid,
      message: z.string().min(1).max(4000).optional(),
      offer_amount: z.number().positive().max(1e12).optional(),
    },
    async ({ guid, message, offer_amount }) => {
      const listing = await detail(guid);
      if (!listing.seller.name || !listing.chat_url || !listing.url)
        throw new Error("Listing has no verified chat target or seller name.");
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
    "jiji_message_status",
    "Check a prepared message’s local approval/send status. Does not approve or send it.",
    { id: z.string().uuid() },
    ({ id }) => request({ action: "plan_status", id }),
  );
}
