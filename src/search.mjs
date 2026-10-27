import { z } from "zod";
import { attributeFilterKey } from "./protocol.mjs";

export const searchFields = {
  query: z.string().min(1).max(200),
  sort: z.enum(["rel", "new", "price", "price_desc"]).default("rel"),
  region_id: z.number().int().positive().optional(),
  category_id: z.number().int().positive().optional(),
  category_slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(150)
    .optional(),
  region_slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(150)
    .optional(),
  min_price: z.number().nonnegative().optional(),
  max_price: z.number().nonnegative().optional(),
  filters: z
    .record(
      z.string().regex(attributeFilterKey),
      z.union([
        z.string().min(1).max(200),
        z.array(z.string().min(1).max(200)).min(1).max(10),
      ]),
    )
    .refine((value) => Object.keys(value).length <= 12, "At most 12 filters")
    .optional(),
};

export function searchPath(args) {
  if (Object.keys(args.filters ?? {}).length && !args.category_slug)
    throw new Error(
      "Native attribute filters require category_slug from Jiji's category route.",
    );
  if (
    args.min_price !== undefined &&
    args.max_price !== undefined &&
    args.min_price > args.max_price
  )
    throw new Error("Minimum price exceeds maximum.");
  const q = new URLSearchParams({
    query: args.query,
    init_page: "true",
    page: "1",
    webp: "false",
    sort: args.sort ?? "rel",
  });
  for (const [key, value] of Object.entries({
    region_id: args.region_id,
    category_id: args.category_id,
    slug: args.category_slug,
    region_slug: args.region_slug,
    price_min: args.min_price,
    price_max: args.max_price,
    ...args.filters,
  }))
    if (value !== undefined)
      for (const item of Array.isArray(value) ? value : [value])
        q.append(key, String(item));
  return "/api_web/v1/listing?" + q;
}
