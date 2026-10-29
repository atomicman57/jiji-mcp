// Pure advert form logic shared by prepare and confirm. Jiji's form schemas are
// read live (advert_create_form / advert_edit_form / advert_category_fields);
// nothing here hardcodes attribute identifiers, which vary by category.
import { createHash } from "node:crypto";

// Category paths an agent can pass as `category_path`. They are resolved
// against the category tree in Jiji's current create form, never mapped to a
// fixed id. Solar panels are posted under Electrical Equipment.
export const CATEGORY_HINTS = {
  solar_panels: ["Repair & Construction", "Electrical Equipment"],
};

// Promotion controls are recognised by name, label or paid-looking options.
// Kept narrow so category attributes such as "Package Type" or "Top Load"
// are not mistaken for the promo step.
const PROMO_NAME =
  /promo|premium|boost|trial|vip|(^|_)top(_|$)|(^|_)packages?(_id)?$|paid_?package/i;
const PROMO_LABEL = /promo|premium|boost|free trial|top ads?\b|vip/i;
const PROMO_OPTION =
  /\b(top|boost|vip|premium|diamond)\b.*\b\d+\s*(days?|weeks?|months?)\b|\bfree trial\b/i;
const FREE_OPTION = /no\s*promo|^free$|^none$|without|^no$|^standard$|^basic$/i;
const PAID_OPTION = /trial|day|week|month|top|boost|vip|premium|diamond|gold/i;
const PHOTO_FIELD = /^(images|image_ids|photos|photo_ids)$/;

const text = (v) => (v === undefined || v === null ? "" : String(v)).trim();
const optionValue = (o) =>
  o && typeof o === "object" ? (o.value ?? o.id ?? o.slug) : o;
const optionLabel = (o) =>
  o && typeof o === "object"
    ? text(o.label ?? o.title ?? o.name ?? o.text ?? optionValue(o))
    : text(o);

// Flattens nested Jiji field groups into { name, label, options, value }.
export function flattenFields(...groups) {
  const out = [];
  const visit = (fields) => {
    for (const f of fields || []) {
      if (!f || typeof f !== "object") continue;
      if (f.name)
        out.push({
          name: String(f.name),
          label: text(f.label ?? f.title ?? f.placeholder),
          options: f.values ?? f.options ?? f.items ?? null,
          value: f.value,
          type: f.type,
        });
      if (Array.isArray(f.fields)) visit(f.fields);
    }
  };
  for (const g of groups) visit(g);
  return out;
}

const describe = (f) => `${f.name} ${f.label}`;
export const isPromoField = (f) =>
  !/price|negotiab/i.test(describe(f)) &&
  (PROMO_NAME.test(f.name) ||
    PROMO_LABEL.test(f.label || "") ||
    (Array.isArray(f.options) &&
      f.options.some((o) => PROMO_OPTION.test(optionLabel(o)))));

// The free choice for a promo control: the "No promo"/free option when the
// control has options, otherwise false/empty. Throws if no free choice exists.
export function freePromoValue(field) {
  if (!Array.isArray(field.options) || !field.options.length) {
    if (field.type === "checkbox" || typeof field.value === "boolean")
      return false;
    return null;
  }
  const free = field.options.find(
    (o) =>
      FREE_OPTION.test(optionLabel(o)) && !PAID_OPTION.test(optionLabel(o)),
  );
  if (!free)
    throw new Error(
      `Jiji's promotion step "${field.label || field.name}" has no free option. Nothing was prepared; finish this advert on Jiji.`,
    );
  return optionValue(free);
}

export function resolveCategoryPath(tree, path) {
  if (!Array.isArray(path) || !path.length)
    throw new Error("category_path must list category names.");
  let level = tree;
  let found;
  for (const name of path) {
    const want = text(name).toLowerCase();
    found = (Array.isArray(level) ? level : []).find(
      (c) => text(c?.name ?? c?.title ?? c?.label).toLowerCase() === want,
    );
    if (!found)
      throw new Error(
        `Category "${name}" was not found in Jiji's current category list. Read advert_create_form and pass category_id.`,
      );
    level = found.children ?? found.subcategories ?? found.categories;
  }
  const id = Number(found.id ?? found.category_id);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error("Jiji's category list did not supply a category id.");
  return id;
}

export function categoryTree(form) {
  return (
    form?.categories ??
    form?.category_tree ??
    form?.params?.categories ??
    form?.params?.category_tree ??
    null
  );
}

function findBrandFields(fields) {
  const brand = fields.find(
    (f) =>
      /brand/i.test(describe(f)) &&
      !/specify|other|custom/i.test(describe(f)) &&
      Array.isArray(f.options) &&
      f.options.length,
  );
  const specify = fields.find(
    (f) =>
      f !== brand &&
      /brand/i.test(describe(f)) &&
      /specify|other|custom/i.test(describe(f)),
  );
  return { brand, specify };
}

// Known brand -> its option value. Unknown brand -> "Other" plus the
// free-text Specify Brand field.
export function resolveBrand(fields, name) {
  const { brand, specify } = findBrandFields(fields);
  if (!brand)
    throw new Error(
      "This category form has no brand field. Remove brand or choose another category.",
    );
  const want = text(name).toLowerCase();
  const match = brand.options.find(
    (o) => optionLabel(o).toLowerCase() === want,
  );
  if (match)
    return {
      values: { [brand.name]: optionValue(match) },
      preview: { name: optionLabel(match), field: brand.name },
    };
  const other = brand.options.find((o) => /^other$/i.test(optionLabel(o)));
  if (!other || !specify)
    throw new Error(
      `Brand "${name}" is not in Jiji's brand list and this form has no Other/Specify Brand field.`,
    );
  return {
    values: { [brand.name]: optionValue(other), [specify.name]: text(name) },
    preview: {
      name: text(name),
      field: brand.name,
      other: true,
      specify_field: specify.name,
    },
  };
}

function negotiableValue(field, negotiable) {
  if (!Array.isArray(field.options) || !field.options.length) return negotiable;
  const yes = /^(yes|negotiable|true)$/i;
  const no = /^(no|not negotiable|non-negotiable|fixed|false)$/i;
  const pick = field.options.find((o) =>
    (negotiable ? yes : no).test(optionLabel(o)),
  );
  if (!pick)
    throw new Error(
      `Could not map negotiable to Jiji's ${field.name} options.`,
    );
  return optionValue(pick);
}

export function existingPhotoIds(field) {
  const value = Array.isArray(field?.value) ? field.value : [];
  return value
    .map((v) => (v && typeof v === "object" ? (v.id ?? v.image_id) : v))
    .filter((v) => v !== undefined && v !== null)
    .map(String);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  return value;
}
export const canonicalJson = (value) => JSON.stringify(sortKeys(value));
export const payloadHash = (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

// Builds the exact submission and its human preview. `photos` must already be
// resolved (see advert-photos.mjs): { existing_id } or { path, sha256, ... }.
export function buildAdvertSubmission({
  base,
  category,
  parameters,
  advertId,
  editing,
  photos,
}) {
  const fields = flattenFields(category.fields, base.fields);
  const byName = new Map(fields.map((f) => [f.name, f]));
  const names = new Set(["title", "category_id", "region_id"]);
  for (const f of fields) names.add(f.name);
  const user = parameters.fields || {};
  for (const key of Object.keys(user)) {
    if (!names.has(key))
      throw new Error(
        "Unknown category field: " +
          key +
          ". Read the current advert form first.",
      );
    if (isPromoField(byName.get(key) || { name: key, label: "" }))
      throw new Error(
        `Field ${key} is a promotion choice. Adverts are always submitted with No promo (free); do not set promotion fields.`,
      );
  }
  const body = { ...user };
  const set = (key, value, source) => {
    if (key in user && user[key] !== value)
      throw new Error(
        `Set ${key} either in fields or via ${source}, not both.`,
      );
    body[key] = value;
  };

  let brand;
  if (parameters.brand !== undefined) {
    const resolved = resolveBrand(fields, parameters.brand);
    for (const [k, v] of Object.entries(resolved.values)) set(k, v, "brand");
    brand = resolved.preview;
  }
  if (parameters.price !== undefined) {
    const price =
      byName.get("price") || fields.find((f) => /^price$/i.test(f.label));
    if (!price) throw new Error("This advert form has no price field.");
    set(price.name, parameters.price, "price");
  }
  if (parameters.negotiable !== undefined) {
    const field = fields.find((f) => /negotiab/i.test(describe(f)));
    if (!field) throw new Error("This advert form has no negotiable field.");
    set(
      field.name,
      negotiableValue(field, parameters.negotiable),
      "negotiable",
    );
  }

  // Always No promo (free). A pre-selected promo — including Jiji's 14-day
  // free trial offered after the free-ad limit — is switched off here.
  const promo = { selected: "free", cleared: [] };
  for (const f of fields.filter(isPromoField)) {
    const free = freePromoValue(f);
    if (
      f.value !== undefined &&
      f.value !== null &&
      f.value !== "" &&
      f.value !== false &&
      String(f.value) !== String(free)
    )
      promo.cleared.push({ field: f.name, was: f.value });
    body[f.name] = free;
  }

  let photoField;
  const photoPreview = [];
  if (photos) {
    photoField = fields.find((f) => PHOTO_FIELD.test(f.name));
    if (!photoField)
      throw new Error(
        "Jiji's advert form did not expose a photo field. Manage photos with jiji_open_workflow post_ad.",
      );
    const existing = new Set(existingPhotoIds(photoField));
    const seen = new Set();
    body[photoField.name] = photos.map((p, i) => {
      if (p.existing_id !== undefined) {
        const id = String(p.existing_id);
        if (!editing || !existing.has(id))
          throw new Error(
            `Photo ${id} is not on this advert. Read advert_edit_form for current photo ids.`,
          );
        if (seen.has(id)) throw new Error(`Photo ${id} is listed twice.`);
        seen.add(id);
        photoPreview.push({ position: i + 1, source: "existing", id });
        return { existing_id: id };
      }
      photoPreview.push({
        position: i + 1,
        source: p.source_url ? "url" : "file",
        ...(p.source_url ? { url: p.source_url } : { file: p.name }),
        type: p.type,
        bytes: p.size,
        sha256: p.sha256,
      });
      return { new_photo: p.sha256 };
    });
    for (const id of existing)
      if (!seen.has(id))
        photoPreview.push({ source: "existing", id, deleted: true });
  }

  body.category_id = parameters.category_id;
  body.region_id = parameters.region_id;
  const request = {
    path: `/api_web/v1/item/modify/${advertId}.json`,
    method: editing ? "PUT" : "POST",
    body,
  };
  const promoFields = fields.filter(isPromoField).map((f) => f.name);
  const preview = {
    action: editing ? "edit" : "create",
    advert_id: advertId,
    title: body.title,
    category_id: parameters.category_id,
    ...(parameters.category_path
      ? { category_path: parameters.category_path }
      : {}),
    region_id: parameters.region_id,
    attributes: Object.fromEntries(
      Object.entries(body).filter(
        ([k]) =>
          !["title", "category_id", "region_id", photoField?.name].includes(
            k,
          ) && !promoFields.includes(k),
      ),
    ),
    price: parameters.price ?? user.price,
    negotiable: parameters.negotiable,
    ...(brand ? { brand } : {}),
    photos: photos ? photoPreview : "unchanged",
    promo,
    request: { method: request.method, path: request.path },
  };
  const payload_hash = payloadHash({
    editing,
    advert_id: advertId,
    request,
  });
  return {
    request,
    preview,
    payload_hash,
    photoField: photoField?.name,
    promoFields,
  };
}

// Final guard before any write: every promo control must hold its free value.
export function assertFreeOnly(body, fields) {
  for (const f of flattenFields(fields).filter(isPromoField))
    if (String(body[f.name]) !== String(freePromoValue(f)))
      throw Object.assign(
        new Error(
          "Refusing to submit: a paid promotion would be selected. Nothing was sent.",
        ),
        { nothingSent: true },
      );
}
