// Synthetic Jiji advert form shapes for mock-only tests. Field names mirror the
// form_fields.json / item-create JSON structure ({ name, label, values }); the
// attribute ids are illustrative, not live identifiers. Never sent to Jiji.
export const categories = [
  {
    id: 47,
    name: "Repair & Construction",
    children: [
      { id: 1081, name: "Building Materials" },
      { id: 1083, name: "Electrical Equipment" },
    ],
  },
  { id: 29, name: "Electronics", children: [{ id: 233, name: "Accessories" }] },
];

// Account hit the free-ad limit: Jiji pre-selects a 14-day free promo trial.
export const promoField = {
  name: "premium_package",
  label: "Promote your ad",
  value: "trial_14",
  values: [
    { value: "", label: "No promo" },
    { value: "trial_14", label: "14 days free trial" },
    { value: "top_7", label: "TOP 7 days" },
  ],
};

export function baseForm({ editing = false, images = [] } = {}) {
  return {
    params: {
      advert_id: editing ? 77 : 12,
      modify_advert_url: `/api_web/v1/item/modify/${editing ? 77 : 12}.json`,
      upload_image_url: "/api_web/v1/item-create/upload-image.json",
    },
    categories,
    fields: [
      { name: "title", label: "Title" },
      { name: "description", label: "Description" },
      { name: "images", label: "Photos", value: images },
      promoField,
    ],
  };
}

export const solarFields = {
  fields: [
    { name: "price", label: "Price" },
    {
      name: "price_negotiable",
      label: "Negotiable",
      values: [
        { value: 1, label: "Yes" },
        { value: 0, label: "No" },
      ],
    },
    {
      name: "attr_brand",
      label: "Brand",
      values: [
        { value: 501, label: "Jinko Solar" },
        { value: 502, label: "Longi" },
        { value: 599, label: "Other" },
      ],
    },
    { name: "attr_brand_other", label: "Specify Brand" },
    {
      name: "attr_condition",
      label: "Condition",
      values: [
        { value: "new", label: "Brand New" },
        { value: "used", label: "Used" },
      ],
    },
    { name: "attr_power", label: "Power (W)" },
  ],
};

// Mock driver: reads return the fixtures; the Jiji write and upload are mocked.
export function mockAdvertBrowser(JijiBrowser, options = {}) {
  const browser = new JijiBrowser("/unused-test-profile");
  const state = {
    reads: [],
    writes: [],
    uploads: [],
    base: baseForm(options),
    category: structuredClone(solarFields),
  };
  browser.readResource = async (name, args) => {
    state.reads.push({ name, args });
    return {
      status: 200,
      body:
        name === "advert_category_fields"
          ? structuredClone(state.category)
          : structuredClone(state.base),
    };
  };
  browser.uploadAdvertPhoto = async (path, photo) => {
    state.uploads.push({ path, sha256: photo.sha256 });
    return "img-" + state.uploads.length;
  };
  browser.catalogRequest = async (request) => {
    state.writes.push(request);
    return { status: 200, body: { status: "ok" } };
  };
  return { browser, state };
}
