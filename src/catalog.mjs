// Endpoint and route names were checked against Jiji's public web application
// and help centre on 2026-10-27. They are not a supported public Jiji API.
import { z } from "zod";
const integer = z.number().int().positive();
const identifier = z.union([
  integer,
  z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
]);
const empty = z.object({}).strict();
const page = z
  .object({ page: integer.optional(), size: integer.max(30).optional() })
  .strict();
const withId = z.object({ id: identifier }).strict();
const withGuid = z
  .object({ guid: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/) })
  .strict();
const api = "/api_web/v1";
const read = (
  title,
  path,
  schema = empty,
  query = () => ({}),
  workflow = "profile",
) => ({
  title,
  path: typeof path === "function" ? path : () => path,
  schema,
  query,
  workflow,
});
export const accountResources = {
  search_suggestions: read(
    "Search suggestions",
    `${api}/search_suggest`,
    z
      .object({
        term: z.string().min(1).max(200),
        slug: z.string().max(150).optional(),
      })
      .strict(),
    (a) => a,
  ),
  listing_filters: read(
    "Category and region filter definitions",
    `${api}/attributes/update-filters`,
    z
      .object({
        slug: z.string().max(150).optional(),
        region_id: integer.optional(),
      })
      .strict(),
    (a) => a,
  ),
  top_searches: read(
    "Popular searches",
    `${api}/top_searches.json`,
    page,
    (a) => a,
  ),
  recent_searches: read(
    "Your recent searches",
    `${api}/user-recently-searches.json`,
    z.object({ type: z.string().max(40).optional() }).strict(),
    (a) => a,
    "searches",
  ),
  recently_viewed: read(
    "Your recently viewed adverts",
    `${api}/user-recently-visited-adverts.json`,
    empty,
    () => ({ detailed: true }),
    "recently_viewed",
  ),
  navigation: read("Account navigation", `${api}/profile/menu.json`),
  personal_details: read(
    "Personal details",
    `${api}/profile/contact-details.json`,
  ),
  business_details: read(
    "Business profile",
    `${api}/profile/business-details/company.json`,
  ),
  stores: read(
    "Store locations and opening hours",
    `${api}/profile/business-details/stores.json`,
  ),
  store_form: read(
    "Store form",
    `${api}/profile/business-details/store.json`,
    z.object({ id: identifier.optional() }).strict(),
    (a) => ({ store_id: a.id }),
  ),
  deliveries: read(
    "Business delivery options",
    `${api}/profile/business-details/deliveries.json`,
  ),
  delivery_form: read(
    "Business delivery form",
    `${api}/profile/business-details/delivery.json`,
    z.object({ id: identifier.optional() }).strict(),
    (a) => ({ delivery_id: a.id }),
  ),
  my_adverts: read(
    "Your adverts",
    `${api}/profile/my-ads.json`,
    z
      .object({
        page: integer.optional(),
        status: z.string().max(30).optional(),
      })
      .strict(),
    (a) => a,
    "adverts",
  ),
  saved_adverts: read(
    "Saved adverts",
    `${api}/profile/my-favorite-adverts.json`,
    page,
    (a) => a,
    "favorites",
  ),
  saved_searches: read(
    "Saved searches",
    `${api}/profile/my-favorite-searches.json`,
    z.object({ size: integer.max(30).optional() }).strict(),
    (a) => a,
    "searches",
  ),
  notifications: read(
    "Notifications",
    `${api}/profile/notifications.json`,
    z.object({ page: integer.optional() }).strict(),
    (a) => a,
    "notifications",
  ),
  notification_settings: read(
    "Notification settings",
    `${api}/profile/notification-settings.json`,
    empty,
    () => ({}),
    "notification_settings",
  ),
  chat_settings: read("Chat settings", `${api}/chat/settings`),
  contact_settings: read(
    "Contact visibility settings",
    `${api}/contacts/settings`,
  ),
  feedback_settings: read(
    "Feedback settings",
    `${api}/profile/feedback-settings.json`,
  ),
  whatsapp_settings: read(
    "Business WhatsApp settings",
    `${api}/profile/whatsapp-settings.json`,
  ),
  balance: read(
    "Balance and active packages",
    `${api}/profile/balance_v2`,
    empty,
    () => ({}),
    "balance",
  ),
  transactions: read(
    "Transaction history",
    `${api}/profile/transactions-history`,
    z
      .object({ page: integer.optional(), type: z.string().max(30).optional() })
      .strict(),
    (a) => a,
    "transactions",
  ),
  latest_transactions: read(
    "Recent transactions",
    `${api}/profile/latest-transactions`,
    empty,
    () => ({}),
    "transactions",
  ),
  sent_feedback: read(
    "Feedback you submitted",
    `${api}/profile/opinions/sent/1.json`,
    empty,
    () => ({}),
    "feedback",
  ),
  feedback_suggestions: read(
    "Items eligible for feedback",
    `${api}/opinions/ads_cv.json`,
    empty,
    () => ({ limit: 10 }),
    "feedback",
  ),
  appealed_feedback: read(
    "Appealed feedback",
    `${api}/opinions/successful-appealed.json`,
    empty,
    () => ({}),
    "feedback",
  ),
  followers: read(
    "Your followers",
    (a) => `${api}/profile/followers/${a.page || 1}.json`,
    z.object({ page: integer.optional() }).strict(),
    () => ({}),
    "followers",
  ),
  following: read(
    "Sellers you follow",
    (a) => `${api}/profile/following/${a.page || 1}.json`,
    z.object({ page: integer.optional() }).strict(),
    () => ({}),
    "following",
  ),
  orders: read(
    "Safe Deal orders",
    `${api}/delivery/orders.json`,
    z
      .object({
        type: z.enum(["sold", "bought"]).optional(),
        page: integer.optional(),
      })
      .strict(),
    (a) => a,
    "orders",
  ),
  order: read(
    "Safe Deal order and tracking",
    `${api}/delivery/order-info.json`,
    withGuid,
    (a) => ({ guid: a.guid }),
    "orders",
  ),
  order_checkout: read(
    "Safe Deal checkout details",
    `${api}/delivery/create-order.json`,
    withGuid,
    (a) => ({ guid: a.guid }),
    "orders",
  ),
  order_cancellation: read(
    "Safe Deal buyer cancellation options",
    `${api}/delivery/buyer-cancel-order.json`,
    withGuid,
    (a) => ({ guid: a.guid }),
    "orders",
  ),
  seller_order_cancellation: read(
    "Safe Deal seller cancellation options",
    `${api}/delivery/seller-cancel-order.json`,
    withGuid,
    (a) => ({ guid: a.guid }),
    "orders",
  ),
  inspections: read(
    "Your vehicle inspections",
    `${api}/profile/inspections`,
    empty,
    () => ({}),
    "inspections",
  ),
  inspection: read(
    "Inspection details",
    (a) => `${api}/profile/inspections/${a.id}`,
    withId,
    () => ({}),
    "inspections",
  ),
  advert_delete_reasons: read(
    "Advert close/delete reasons",
    (a) => `${api}/aditem/delete/${a.id}`,
    withId,
    () => ({}),
    "adverts",
  ),
  advert_publish_check: read(
    "Advert publication requirements",
    (a) => `${api}/advert/publish/${a.id}`,
    withId,
    () => ({}),
    "adverts",
  ),
  advert_edit_form: read(
    "Edit advert form",
    (a) => `${api}/item-create/edit-${a.id}.json`,
    withId,
    () => ({}),
    "adverts",
  ),
  advert_create_form: read(
    "New advert form",
    `${api}/item-create/add.json`,
    empty,
    () => ({}),
    "post_ad",
  ),
  advert_category_fields: read(
    "Category-specific advert fields",
    `${api}/item-create/form_fields.json`,
    z
      .object({
        advert_id: integer,
        category_id: integer,
        title: z.string().max(200).optional(),
      })
      .strict(),
    (a) => a,
    "post_ad",
  ),
  seller_recommendations: read(
    "Seller recommendations",
    `${api}/seller-recommendations`,
  ),
  seller_attribute_stats: read(
    "Advert quality recommendations",
    `${api}/seller-recommendations/adv-attr-stats`,
    z.object({ page: integer.optional() }).strict(),
    (a) => a,
  ),
  seller_price_recommendations: read(
    "Advert price recommendations",
    `${api}/seller-recommendations/adv-recommended-prices`,
    z.object({ page: integer.optional() }).strict(),
    (a) => a,
  ),
  unanswered_chats: read(
    "Unanswered seller chats",
    `${api}/seller-recommendations/unanswered-chats`,
    z.object({ page: integer.optional() }).strict(),
    (a) => a,
    "messages",
  ),
  client_stats: read(
    "Inbound client statistics",
    `${api}/potential-clients/stats`,
    empty,
    () => ({}),
    "clients",
  ),
  premium_categories: read(
    "Promotion categories",
    `${api}/ps-categories-data`,
    empty,
    () => ({}),
    "premium",
  ),
  premium_packages: read(
    "Promotion package information",
    `${api}/ps-packages-data`,
    z.object({ category: z.string().max(80) }).strict(),
    (a) => a,
    "premium",
  ),
  chat_stickers: read(
    "Available chat stickers",
    `${api}/chat/sticker-sprites.json`,
    empty,
    () => ({}),
    "messages",
  ),
  unread_messages: read(
    "Unread message count",
    `${api}/chat/messages/unread.json`,
    empty,
    () => ({}),
    "messages",
  ),
  chat_rooms: read(
    "Jiji chat rooms",
    `${api}/chat/rooms.json`,
    z
      .object({
        page: integer.optional(),
        sort: z.string().max(30).optional(),
      })
      .strict(),
    (a) => a,
    "messages",
  ),
  chat_messages: read(
    "Chat history including media references",
    (a) => `${api}/chat/room/${a.id}.json`,
    z
      .object({
        id: identifier,
        last_msg_id: identifier.optional(),
        order: z.enum(["next", "prev"]).optional(),
      })
      .strict(),
    (a) => ({ last_msg_id: a.last_msg_id, order: a.order }),
    "messages",
  ),
  chat_search: read(
    "Search your Jiji conversations",
    `${api}/chat/search.json`,
    z
      .object({
        query: z.string().min(1).max(200),
        group: z.string().max(40).optional(),
      })
      .strict(),
    (a) => a,
    "messages",
  ),
  seller_feedback: read(
    "Seller feedback",
    (a) => `${api}/opinions/${a.guid}/${a.page || 1}.json`,
    z
      .object({
        guid: z.string().regex(/^[A-Za-z0-9]{8,64}$/),
        page: integer.optional(),
        size: integer.max(20).optional(),
        rating: integer.max(5).optional(),
      })
      .strict(),
    (a) => ({ reply_limit: 1, size: a.size, rating: a.rating }),
    "feedback",
  ),
  feedback_create_form: read(
    "New feedback form",
    (a) => `${api}/create-opinion/${a.guid}`,
    withGuid,
    () => ({}),
    "feedback",
  ),
  feedback_edit_form: read(
    "Edit feedback form",
    (a) => `${api}/edit-opinion/${a.id}`,
    withId,
    () => ({}),
    "feedback",
  ),
  similar_adverts: read(
    "Related adverts",
    (a) => `${api}/lp/similar-ads/${a.id}.json`,
    z.object({ id: identifier, page: integer.optional() }).strict(),
    (a) => ({ page: a.page }),
  ),
  report_form: read(
    "Advert report reasons",
    (a) => `${api}/advert/report/${a.id}.json`,
    withId,
  ),
  category_help: read(
    "Category posting guidance",
    (a) => `${api}/category_manual/${a.id}.json`,
    withId,
  ),
  category_counts: read(
    "Category listing counts",
    `${api}/categories_counts.json`,
  ),
  seller_profile: read(
    "Public seller profile",
    (a) => `${api}/seller/${a.guid}/data-by-identifier.json`,
    withGuid,
    () => ({ hide_phone: 1 }),
  ),
  seller_shop: read(
    "Public seller shop",
    (a) => `${api}/seller/${a.id}/data-by-slug.json`,
    withId,
    () => ({ hide_phone: 1 }),
  ),
  seller_categories: read(
    "Seller top categories",
    (a) => `${api}/seller/${a.guid}/top_category.json`,
    withGuid,
  ),
  social_connection_status: read(
    "Connected sign-in providers (status only)",
    `${api}/profile/social-connections.json`,
  ),
  business_verification_status: read(
    "Business verification status",
    `${api}/profile/company-verification/status`,
  ),
  ad_sharing_pages: read(
    "Available advert-sharing pages",
    `${api}/auto-publishing/pages`,
  ),
  ad_sharing_active: read(
    "Active advert-sharing pages",
    `${api}/auto-publishing/active-pages`,
  ),
  pro_sales_overview: read(
    "Pro Sales campaign overview",
    `${api}/pro_sales_v3`,
    empty,
    () => ({}),
    "pro_sales",
  ),
  pro_sales_groups: read(
    "Pro Sales bid groups",
    `${api}/pro_sales_v3/groups`,
    page,
    (a) => a,
    "pro_sales_bids",
  ),
  pro_sales_group: read(
    "Pro Sales group details",
    (a) => `${api}/pro_sales_v3/groups/${a.id}`,
    withId,
    () => ({}),
    "pro_sales_bids",
  ),
  discounts: read(
    "Your advert discounts",
    `${api}/apply-discount`,
    empty,
    () => ({}),
    "adverts",
  ),
  job_applications: read(
    "Applications to your job advert",
    (a) => `${api}/job/cvs/${a.id}.json`,
    withId,
    () => ({}),
    "jobs",
  ),
  advert_statistics: {
    ...read(
      "Your advert statistics",
      `${api}/get_statistics_v2.json`,
      empty,
      () => ({}),
      "statistics",
    ),
    method: "POST",
    body: () => ({}),
  },
};
export const workflows = {
  sign_in: {
    title: "Jiji sign-in and social login",
    path: "/login.html",
    mode: "owner_handoff",
  },
  register: {
    title: "Create a Jiji account using the site registration controls",
    path: "/",
    mode: "owner_handoff",
  },
  profile: { title: "Your profile", path: "/profile", mode: "owner_review" },
  personal_settings: {
    title: "Personal details",
    path: "/profile/settings/contact-details",
    mode: "owner_review",
  },
  business: {
    title: "Business name, description and links",
    path: "/profile/settings/company-about",
    mode: "owner_review",
  },
  stores: {
    title: "Store addresses, hours and photos",
    path: "/profile/settings/stores",
    mode: "owner_review",
  },
  delivery: {
    title: "Business delivery and Safe Deal setup",
    path: "/profile/settings/delivery",
    mode: "owner_review",
  },
  adverts: {
    title: "Manage adverts: edit, renew, close, mark sold, delete",
    path: "/profile/adverts",
    mode: "owner_review",
  },
  post_ad: {
    title: "Create an advert, select category, upload photos/video",
    path: "/add-free-ad.html",
    mode: "owner_review",
  },
  favorites: {
    title: "Saved adverts",
    path: "/profile/saved/favorites",
    mode: "owner_review",
  },
  searches: {
    title: "Saved searches and alerts",
    path: "/profile/saved/searches",
    mode: "owner_review",
  },
  messages: {
    title: "Chats, media, offers, block/spam and message management",
    path: "/profile-messages",
    mode: "owner_review",
  },
  feedback: {
    title: "Feedback, replies, reactions and appeals",
    path: "/profile/feedback",
    mode: "owner_review",
  },
  followers: {
    title: "Your followers",
    path: "/profile/followers",
    mode: "owner_review",
  },
  following: {
    title: "Sellers you follow",
    path: "/profile/following",
    mode: "owner_review",
  },
  notifications: {
    title: "Notifications",
    path: "/profile/notifications",
    mode: "owner_review",
  },
  notification_settings: {
    title: "Notification preferences",
    path: "/profile/settings/notification",
    mode: "owner_review",
  },
  language: {
    title: "Interface language",
    path: "/profile/settings/language",
    mode: "owner_review",
  },
  chat_settings: {
    title: "Chat and contact preferences",
    path: "/profile/settings/contact-channels",
    mode: "owner_review",
  },
  feedback_settings: {
    title: "Feedback preferences",
    path: "/profile/settings/feedback",
    mode: "owner_review",
  },
  whatsapp: {
    title: "Business WhatsApp settings",
    path: "/profile/settings/whatsapp",
    mode: "owner_review",
  },
  ad_sharing: {
    title: "Automatic advert sharing",
    path: "/profile/settings/auto-publisher",
    mode: "owner_review",
  },
  statistics: {
    title: "Advert statistics",
    path: "/profile/statistics",
    mode: "owner_review",
  },
  clients: {
    title: "Inbound clients and follow-up dashboard",
    path: "/profile/my-clients",
    mode: "owner_review",
  },
  orders: {
    title: "Safe Deal orders, checkout, tracking, disputes and refunds",
    path: "/profile/orders",
    mode: "owner_handoff",
  },
  premium: {
    title: "Premium packages, Top Ads and Boost",
    path: "/sc/premium-services",
    mode: "owner_handoff",
  },
  pro_sales: {
    title: "Pro Sales campaigns, budgets and bids",
    path: "/profile/pro_sales",
    mode: "owner_handoff",
  },
  pro_sales_bids: {
    title: "Pro Sales bid groups",
    path: "/profile/pro_sales_v3/bids",
    mode: "owner_handoff",
  },
  balance: {
    title: "Balance, top-up, credit and payment methods",
    path: "/sc/my-balance",
    mode: "owner_handoff",
  },
  transactions: {
    title: "Transaction history and invoices",
    path: "/profile/transactions",
    mode: "owner_handoff",
  },
  inspections: {
    title: "Vehicle inspection bookings",
    path: "/profile/inspections",
    mode: "owner_handoff",
  },
  auction: {
    title: "Cars45 selling and auctions",
    path: "/auction-for-sellers",
    mode: "owner_handoff",
  },
  price_statistics: {
    title: "Marketplace price statistics",
    path: "/price-statistics",
    mode: "owner_review",
  },
  recently_viewed: {
    title: "Recently viewed listings",
    path: "/recently-viewed",
    mode: "owner_review",
  },
  jobs: {
    title: "Job search, applications and CVs",
    path: "/jobs",
    mode: "owner_handoff",
  },
  identity: {
    title: "ID and business verification",
    path: "/profile/kyc/id_verify",
    mode: "owner_handoff",
  },
  phone: {
    title: "Change account phone",
    path: "/profile/settings/phone",
    mode: "owner_handoff",
  },
  email: {
    title: "Change account email",
    path: "/profile/settings/email",
    mode: "owner_handoff",
  },
  password: {
    title: "Change account password",
    path: "/profile/settings/change-password",
    mode: "owner_handoff",
  },
  security: {
    title: "Account security and passkeys",
    path: "/profile/settings/security",
    mode: "owner_handoff",
  },
  delete_account: {
    title: "Permanent account deletion",
    path: "/profile/settings/delete",
    mode: "owner_handoff",
  },
  support: {
    title: "Jiji help, refunds, reports and support",
    path: "/faq",
    mode: "owner_handoff",
  },
};
const data = z.record(z.string(), z.unknown());
const action = (
  title,
  path,
  schema,
  body = () => ({}),
  method = "POST",
  workflow = "profile",
) => ({
  title,
  path: typeof path === "function" ? path : () => path,
  schema,
  body,
  method,
  workflow,
});
export const actions = {
  save_search: action(
    "Save a search and subscribe to its alerts",
    `${api}/subscribe_search`,
    z.object({ search_params: data }).strict(),
    (a) => ({ search_params: a.search_params }),
    "POST",
    "searches",
  ),
  unsubscribe_search: action(
    "Unsubscribe from saved-search alerts",
    `${api}/unsubscribe_search`,
    withId,
    (a) => ({ user_search_id: a.id }),
    "POST",
    "searches",
  ),
  clear_recent_searches: action(
    "Clear your recent-search history",
    `${api}/user-recently-searches.json`,
    empty,
    () => ({}),
    "DELETE",
    "searches",
  ),
  clear_recently_viewed: action(
    "Clear your recently viewed history",
    `${api}/user-recently-visited-adverts.json`,
    empty,
    () => ({}),
    "DELETE",
    "recently_viewed",
  ),
  save_advert: action(
    "Save advert",
    (a) => `${api}/fav/add/${a.id}.json`,
    withId,
  ),
  unsave_advert: action(
    "Remove saved advert",
    (a) => `${api}/fav/delete/${a.id}.json`,
    withId,
  ),
  remove_saved_search: action(
    "Delete saved search",
    (a) => `${api}/user-search/${a.id}.json`,
    withId,
    () => ({}),
    "DELETE",
    "searches",
  ),
  follow_seller: action(
    "Follow seller",
    `${api}/profile/follow_unfollow.json`,
    withId,
    (a) => ({ user_id: a.id, is_follow: true }),
  ),
  unfollow_seller: action(
    "Unfollow seller",
    `${api}/profile/follow_unfollow.json`,
    withId,
    (a) => ({ user_id: a.id, is_follow: false }),
  ),
  mark_notifications: action(
    "Change notification read status",
    `${api}/profile/notifications/track.json`,
    z
      .object({ ids: z.array(identifier).min(1).max(30), read: z.boolean() })
      .strict(),
    (a) => a,
    "POST",
    "notifications",
  ),
  update_personal_details: action(
    "Update personal details",
    `${api}/profile/contact-details.json`,
    z.object({ details: data }).strict(),
    (a) => a.details,
    "POST",
    "personal_settings",
  ),
  update_business: action(
    "Update business profile",
    `${api}/profile/business-details/company.json`,
    z.object({ details: data }).strict(),
    (a) => a.details,
    "POST",
    "business",
  ),
  update_store: action(
    "Create or update store",
    `${api}/profile/business-details/store.json`,
    z.object({ details: data }).strict(),
    (a) => a.details,
    "POST",
    "stores",
  ),
  delete_store: action(
    "Delete store",
    (a) => `${api}/profile/business-details/store/${a.id}.json`,
    withId,
    () => ({}),
    "DELETE",
    "stores",
  ),
  update_delivery: action(
    "Create or update business delivery option",
    `${api}/profile/business-details/delivery.json`,
    z.object({ details: data }).strict(),
    (a) => a.details,
    "POST",
    "delivery",
  ),
  delete_delivery: action(
    "Delete business delivery option",
    (a) => `${api}/profile/business-details/delivery/${a.id}.json`,
    withId,
    () => ({}),
    "DELETE",
    "delivery",
  ),
  update_notifications: action(
    "Update notification preferences",
    `${api}/profile/notification-settings.json`,
    z.object({ settings: data }).strict(),
    (a) => ({ settings: a.settings }),
    "POST",
    "notification_settings",
  ),
  set_chat_enabled: action(
    "Enable or disable Jiji chats",
    `${api}/chat/settings`,
    z.object({ value: z.boolean() }).strict(),
    (a) => a,
    "POST",
    "chat_settings",
  ),
  set_contacts_enabled: action(
    "Change contact visibility",
    `${api}/contacts/settings`,
    z.object({ value: z.boolean() }).strict(),
    (a) => a,
    "POST",
    "chat_settings",
  ),
  set_feedback_enabled: action(
    "Enable or disable feedback",
    `${api}/profile/feedback-settings.json`,
    z.object({ value: z.boolean() }).strict(),
    (a) => a,
    "POST",
    "feedback_settings",
  ),
  update_whatsapp: action(
    "Update business WhatsApp settings",
    `${api}/profile/whatsapp-settings.json`,
    z.object({ settings: data }).strict(),
    (a) => a.settings,
    "POST",
    "whatsapp",
  ),
  update_ad_sharing: action(
    "Update automatic advert sharing",
    `${api}/auto-publishing/active-pages`,
    z.object({ settings: data }).strict(),
    (a) => a.settings,
    "POST",
    "ad_sharing",
  ),
  reactivate_advert: action(
    "Reactivate advert",
    (a) => `${api}/aditem/reactivate/${a.id}`,
    withId,
    () => ({}),
    "POST",
    "adverts",
  ),
  close_advert: action(
    "Close advert / mark unavailable",
    (a) => `${api}/aditem/close/${a.id}`,
    z.object({ id: identifier, reason: z.unknown() }).strict(),
    (a) => ({ db: a.reason }),
    "POST",
    "adverts",
  ),
  delete_advert: action(
    "Permanently delete advert",
    (a) => `${api}/aditem/delete/${a.id}`,
    z.object({ id: identifier, reason: z.unknown() }).strict(),
    (a) => ({ db: a.reason }),
    "POST",
    "adverts",
  ),
  publish_advert: action(
    "Publish an existing advert draft",
    (a) => `${api}/advert/publish/${a.id}`,
    withId,
    () => ({}),
    "POST",
    "adverts",
  ),
  feedback_create: action(
    "Submit seller feedback",
    (a) => `${api}/create-opinion/${a.guid}`,
    z.object({ guid: withGuid.shape.guid, details: data }).strict(),
    (a) => a.details,
    "POST",
    "feedback",
  ),
  feedback_edit: action(
    "Edit your feedback",
    (a) => `${api}/edit-opinion/${a.id}`,
    z.object({ id: identifier, details: data }).strict(),
    (a) => a.details,
    "POST",
    "feedback",
  ),
  feedback_react: action(
    "React to feedback",
    (a) => `${api}/opinions/${a.id}/like`,
    z.object({ id: identifier, value: z.boolean() }).strict(),
    (a) => ({ value: a.value }),
    "POST",
    "feedback",
  ),
  feedback_reply: action(
    "Reply to feedback",
    (a) => `${api}/opinions/reply/create/${a.id}`,
    z
      .object({
        id: identifier,
        text: z.string().min(1).max(4000),
        reply_id: identifier.optional(),
        image_ids: z.array(identifier).max(5).optional(),
      })
      .strict(),
    (a) => ({ text: a.text, reply_id: a.reply_id, image_ids: a.image_ids }),
    "POST",
    "feedback",
  ),
  feedback_appeal: action(
    "Appeal feedback",
    (a) => `${api}/opinions/${a.id}/appeal`,
    z.object({ id: identifier, details: data }).strict(),
    (a) => a.details,
    "POST",
    "feedback",
  ),
  report_advert: action(
    "Report an advert",
    (a) => `${api}/advert/report/${a.id}.json`,
    z.object({ id: identifier, details: data }).strict(),
    (a) => a.details,
  ),
  request_callback: action(
    "Request a seller callback",
    (a) => `${api}/advert/call-back/${a.id}.json`,
    z.object({ id: identifier, details: data }).strict(),
    (a) => a.details,
  ),
  delete_chat_message: action(
    "Delete a chat message",
    (a) => `${api}/chat/message/${a.id}`,
    withId,
    () => ({}),
    "DELETE",
    "messages",
  ),
  set_chat_status: action(
    "Change chat status / block or spam handling",
    `${api}/chat/rooms/status`,
    z
      .object({
        room_ids: z.array(identifier).min(1).max(10),
        status: z.string().min(1).max(40),
      })
      .strict(),
    (a) => a,
    "POST",
    "messages",
  ),
};
function checkValues(value, depth = 0) {
  if (depth > 8) throw new Error("Parameters are too deeply nested.");
  if (typeof value === "string" && value.length > 10000)
    throw new Error("Parameter value too large.");
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (
        /^(?:__proto__|prototype|constructor)$/.test(key) ||
        /password|csrf|token|secret|credential|passkey|webauthn|cookie|verification.?code|otp|card.?number|cvv|private.?key|paid_package|use_balance/i.test(
          key,
        )
      )
        throw new Error(
          "Credentials and payment authorization fields must be handled directly on Jiji.",
        );
      checkValues(v, depth + 1);
    }
  }
}
export function buildRead(name, args = {}) {
  checkValues(args);
  const r = accountResources[name];
  if (!r) throw new Error("Unknown Jiji data resource.");
  const params = r.schema.parse(args);
  const u = new URL(r.path(params), "https://jiji.ng");
  for (const [k, v] of Object.entries(r.query(params)))
    if (v !== undefined) u.searchParams.set(k, String(v));
  return {
    path: u.pathname + u.search,
    title: r.title,
    method: r.method || "GET",
    ...(r.body ? { body: r.body(params) } : {}),
  };
}
export function buildAction(name, args = {}) {
  checkValues(args);
  const a = actions[name];
  if (!a)
    throw new Error(
      "Unknown action. Use an owner workflow for payments, identity, passwords or account deletion.",
    );
  const params = a.schema.parse(args);
  checkValues(params);
  if (JSON.stringify(params).length > 20000)
    throw new Error("Action parameters too large.");
  return {
    operation: name,
    parameters: params,
    title: a.title,
    path: a.path(params),
    method: a.method,
    body: a.body(params),
    workflow: a.workflow,
  };
}
export function featureMap() {
  return {
    audited_at: "2026-10-27",
    read_resources: Object.entries(accountResources).map(([name, r]) => ({
      name,
      title: r.title,
      parameters: z.toJSONSchema(r.schema),
    })),
    owner_approved_actions: Object.entries(actions).map(([name, a]) => ({
      name,
      title: a.title,
      parameters: z.toJSONSchema(a.schema),
    })),
    workflows: Object.entries(workflows).map(([name, w]) => ({ name, ...w })),
    verification:
      "Catalog entries are mapped to the current web client. Availability is account-dependent; executable writes require local owner approval and are not all live-tested.",
    sources: ["https://jiji.ng/faq", "https://jiji.ng/faq/app-vs-website"],
  };
}
export { checkValues as validateUserData };
