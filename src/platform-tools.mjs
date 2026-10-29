import { z } from "zod";
import {
  accountResources,
  actions,
  workflows,
  featureMap,
  buildRead,
  buildAction,
  validateUserData,
} from "./catalog.mjs";
export function registerPlatformTools(register, request) {
  const record = z.record(z.string(), z.unknown());
  const write = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };
  register(
    "jiji_capabilities",
    "Inspect the full mapped feature catalog, supported read resources, owner-approved action schemas, and owner handoffs. A mapped feature is not a claim that every write was live-tested.",
    {
      section: z
        .enum(["overview", "reads", "actions", "workflows"])
        .default("overview"),
      name: z.string().max(80).optional(),
    },
    ({ section, name }) => {
      const map = featureMap();
      const group =
        section === "reads"
          ? map.read_resources
          : section === "actions"
            ? map.owner_approved_actions
            : section === "workflows"
              ? map.workflows
              : null;
      if (group)
        return name
          ? group.find((x) => x.name === name) || {
              error: "Unknown catalog name",
            }
          : group.map(({ name, title, mode }) => ({ name, title, mode }));
      return {
        read_resources: map.read_resources.length,
        owner_approved_actions: map.owner_approved_actions.length,
        workflows: map.workflows.length,
        verification: map.verification,
        sources: map.sources,
        instructions:
          "List a section, then request its name to see the exact parameter schema. Payments, credentials and identity uploads use owner handoff.",
      };
    },
  );
  register(
    "jiji_account_data",
    "Read a mapped Jiji resource: your adverts/forms, favourites/searches, profile/business/store/delivery settings, notifications, follows, feedback, chats/media, orders/tracking, inspections, balance/history or promotion information. Use capabilities to discover each exact parameter schema. Never requests passwords, session credentials or bulk seller contacts.",
    {
      resource: z.enum(Object.keys(accountResources)),
      parameters: record.default({}),
    },
    async ({ resource, parameters }) => {
      buildRead(resource, parameters);
      const result = await request({
        action: "resource",
        resource,
        parameters,
      });
      if (result.error) throw new Error(result.error);
      if (result.status !== 200)
        throw new Error(
          `Jiji returned HTTP ${result.status}. Complete login or resolve access restrictions in Jiji; no retry was attempted.`,
        );
      return result.body;
    },
  );
  register(
    "jiji_prepare_action",
    "Prepare a mapped account/marketplace change for exact local owner review. Examples: save/follow, notifications, business details, advert close/delete/publish, feedback/report/callback and chat status. Preparing sends no mutation. No MCP tool can approve it. Discover exact parameter schemas with capabilities. Payments, passwords, identity and permanent account deletion are owner handoffs.",
    {
      operation: z.enum(Object.keys(actions)),
      parameters: record,
      purpose: z.string().min(5).max(500),
    },
    ({ operation, parameters, purpose }) => {
      buildAction(operation, parameters);
      return request({
        action: "prepare_action",
        operation,
        parameters,
        purpose,
      });
    },
    write,
  );
  const photo = z.union([
    z
      .object({ existing_id: z.union([z.string().max(80), z.number()]) })
      .strict(),
    z.object({ path: z.string().min(2).max(1000) }).strict(),
    z.object({ url: z.string().url().max(2000) }).strict(),
  ]);
  register(
    "jiji_prepare_advert",
    'Preview a new or edited advert against Jiji\'s current create/edit and category forms. Sends nothing. Supports category_id or category_path (e.g. solar panels: ["Repair & Construction", "Electrical Equipment"]), category attributes in fields, brand (unknown brands use Other + Specify Brand), price, negotiable, and an ordered photos list from absolute local paths, https URLs or existing photo ids (order = final order; on edit, existing photos left out are deleted). Promotion is always No promo (free): any pre-selected promo or 14-day free trial is switched off and paid promo fields are rejected. Returns a preview, payload_hash and a single-use approval_token valid for 10 minutes. Show the preview to the owner and call jiji_confirm_advert only after they approve it.',
    {
      advert_id: z.number().int().positive().optional(),
      category_id: z.number().int().positive().optional(),
      category_path: z
        .array(z.string().min(1).max(120))
        .min(1)
        .max(6)
        .optional(),
      region_id: z.number().int().positive(),
      fields: record,
      brand: z.string().min(1).max(120).optional(),
      price: z.number().nonnegative().max(1e12).optional(),
      negotiable: z.boolean().optional(),
      photos: z.array(photo).max(20).optional(),
      promo: z.literal("free").default("free"),
    },
    ({ promo, ...args }) => {
      if (!args.category_id === !args.category_path)
        throw new Error("Provide exactly one of category_id or category_path.");
      validateUserData(args.fields);
      return request({ action: "prepare_advert", parameters: args });
    },
    write,
  );
  register(
    "jiji_confirm_advert",
    "Submit an advert previewed by jiji_prepare_advert, once, after the owner approved that exact preview. Requires its approval_token and payload_hash. Rejects expired, reused or mismatched tokens and refuses if the advert, its photos or Jiji's form changed since the preview. Uploads the listed new photos, then saves/submits with No promo (free). Never selects a paid package. Not affected by JIJI_AUTO_APPROVE.",
    {
      approval_token: z.string().min(16).max(200),
      payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
      id: z.string().uuid().optional(),
    },
    (args) => request({ action: "confirm_advert", ...args }),
    { ...write, destructiveHint: true },
  );
  register(
    "jiji_open_workflow",
    "Open a mapped Jiji workflow in the extension-free browser for owner interaction. Covers media/uploads, adverts, feedback, Saved Search setup, notifications, business settings, Safe Deal checkout/disputes, Premium/Pro Sales/balance, CVs, inspections, identity, credentials and account deletion. Opening a page does not complete the action; the owner must perform sensitive final steps.",
    { workflow: z.enum(Object.keys(workflows)) },
    ({ workflow }) => request({ action: "workflow", workflow }),
    { ...write, idempotentHint: true },
  );
  register(
    "jiji_inspect_workflow",
    "Read the visible page and non-secret form controls for a mapped Jiji workflow. Does not submit forms, upload files, change credentials or authorize payments. Password/OTP/token controls are excluded.",
    { workflow: z.enum(Object.keys(workflows)) },
    ({ workflow }) => request({ action: "inspect_workflow", workflow }),
  );
  register(
    "jiji_action_status",
    "Check a prepared action’s approval/execution result. Does not approve or execute it.",
    { id: z.string().uuid() },
    ({ id }) => request({ action: "plan_status", id }),
  );
}
