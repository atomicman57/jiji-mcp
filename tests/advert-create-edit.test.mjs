// Mock/dry-run only: Jiji reads, photo uploads and the advert write are all
// mocked. No test publishes or edits a live Jiji advert.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JijiBrowser, photoUploadPath } from "../src/browser-driver.mjs";
import { ApprovalPlans } from "../src/plans.mjs";
import { confirmAdvert, prepareAdvertPlan } from "../src/advert-confirm.mjs";
import {
  CATEGORY_HINTS,
  assertFreeOnly,
  freePromoValue,
  isPromoField,
  resolveCategoryPath,
} from "../src/advert-form.mjs";
import {
  assertPublicUrl,
  downloadPhoto,
  isPublicAddress,
  publicLookup,
  readPhoto,
  removeDownloaded,
} from "../src/advert-photos.mjs";
import { createServer } from "../src/tools.mjs";
import {
  categories,
  mockAdvertBrowser,
  promoField,
} from "./fixtures/advert-forms.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);

// Creates photos in a temp folder and allows only that folder for `browser`.
async function tempPhotos(browser) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jiji-advert-test-"));
  const a = path.join(dir, "front.jpg");
  const b = path.join(dir, "back.png");
  await fs.writeFile(a, JPEG);
  await fs.writeFile(b, PNG);
  if (browser) browser.photoOptions = { roots: [dir] };
  return { dir, a, b };
}

// Mock downloader (no network): returns a fetch-like response.
const mockGet =
  (bytes, { length = bytes.length } = {}) =>
  async () => ({
    status: 200,
    headers: {
      get: (k) => (k === "content-length" && length ? String(length) : null),
    },
    body: [bytes],
  });

const solarCreate = (extra = {}) => ({
  category_path: CATEGORY_HINTS.solar_panels,
  region_id: 4,
  fields: {
    title: "Canadian Solar 450W mono panel",
    description: "Mock-only listing",
    attr_condition: "new",
    attr_power: "450",
  },
  price: 95000,
  negotiable: true,
  brand: "Canadian Solar",
  ...extra,
});

test("solar panels resolve to Repair & Construction > Electrical Equipment from the form", () => {
  assert.deepEqual(CATEGORY_HINTS.solar_panels, [
    "Repair & Construction",
    "Electrical Equipment",
  ]);
  assert.equal(
    resolveCategoryPath(categories, CATEGORY_HINTS.solar_panels),
    1083,
  );
  assert.throws(
    () => resolveCategoryPath(categories, ["Repair & Construction", "Solar"]),
    /not found.*pass category_id/,
  );
});

test("create preview includes category attributes, price, negotiable, photo order and free promo", async () => {
  const { browser, state } = mockAdvertBrowser(JijiBrowser);
  const { dir, a } = await tempPhotos(browser);
  try {
    browser.photoOptions.get = mockGet(PNG);
    const prepared = await browser.prepareAdvert(
      solarCreate({
        photos: [
          { path: a },
          { url: "https://cdn.example.com/p/side.png?sig=secret" },
        ],
      }),
    );
    const p = prepared.preview;
    assert.equal(p.action, "create");
    assert.equal(p.category_id, 1083);
    assert.deepEqual(p.category_path, CATEGORY_HINTS.solar_panels);
    assert.equal(p.title, "Canadian Solar 450W mono panel");
    assert.equal(p.attributes.attr_condition, "new");
    assert.equal(p.attributes.attr_power, "450");
    assert.equal(p.price, 95000);
    assert.equal(p.negotiable, true);
    assert.equal(prepared.request.body.price, 95000);
    assert.equal(prepared.request.body.price_negotiable, 1);
    assert.deepEqual(
      p.photos.map((x) => [x.position, x.source]),
      [
        [1, "file"],
        [2, "url"],
      ],
    );
    // Signed query strings never come back in the preview.
    assert.equal(p.photos[1].url, "https://cdn.example.com/p/side.png");
    assert.ok(!JSON.stringify(prepared.preview).includes("secret"));
    assert.equal(p.promo.selected, "free");
    assert.equal(prepared.request.method, "POST");
    assert.match(prepared.payload_hash, /^[a-f0-9]{64}$/);
    assert.equal(
      state.reads.find((r) => r.name === "advert_category_fields").args
        .category_id,
      1083,
    );
    assert.ok(!state.reads.some((r) => r.name === "advert_edit_form"));
    assert.equal(state.writes.length, 0, "prepare must not write");
    assert.equal(state.uploads.length, 0, "prepare must not upload");
    await removeDownloaded(prepared.parameters.photos);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("unknown brand uses Other + Specify Brand; known brand uses its option", async () => {
  const { browser } = mockAdvertBrowser(JijiBrowser);
  const unknown = await browser.prepareAdvert(solarCreate());
  assert.equal(unknown.request.body.attr_brand, 599);
  assert.equal(unknown.request.body.attr_brand_other, "Canadian Solar");
  assert.deepEqual(unknown.preview.brand, {
    name: "Canadian Solar",
    field: "attr_brand",
    other: true,
    specify_field: "attr_brand_other",
  });
  const known = await browser.prepareAdvert(solarCreate({ brand: "longi" }));
  assert.equal(known.request.body.attr_brand, 502);
  assert.equal("attr_brand_other" in known.request.body, false);
});

test("pre-selected 14-day promo trial is switched to No promo (free)", async () => {
  const { browser } = mockAdvertBrowser(JijiBrowser);
  const prepared = await browser.prepareAdvert(solarCreate());
  assert.equal(prepared.request.body.premium_package, "");
  assert.deepEqual(prepared.preview.promo, {
    selected: "free",
    cleared: [{ field: "premium_package", was: "trial_14" }],
  });
  assert.ok(!("premium_package" in prepared.preview.attributes));
  // Final guard refuses anything other than the free option.
  assert.throws(
    () => assertFreeOnly({ premium_package: "trial_14" }, [promoField]),
    /paid promotion/,
  );
  assert.throws(
    () => assertFreeOnly({ premium_package: "top_7" }, [promoField]),
    /paid promotion/,
  );
});

test("promo detection ignores ordinary attributes and catches paid-looking options", () => {
  const f = (name, label, values) => ({ name, label, options: values });
  assert.equal(isPromoField(f("attr_7", "Package Type")), false);
  assert.equal(isPromoField(f("attr_8", "Top Load")), false);
  assert.equal(isPromoField(f("attr_9", "Laptop Brand")), false);
  assert.equal(isPromoField(f("price_negotiable", "Negotiable")), false);
  assert.equal(isPromoField(f("industrial_use", "Industrial use")), false);
  assert.equal(isPromoField(f("signal_booster", "Signal booster")), false);
  assert.equal(isPromoField(f("attr_12", "Premium Quality")), false);
  // "price" in a promo label does not hide the promo step.
  assert.equal(
    isPromoField(f("attr_13", "Promote your ad (prices from ₦1,500)")),
    true,
  );
  // Only an explicit no-promo choice is free; Basic/priced tiers are not.
  assert.throws(
    () =>
      freePromoValue(
        f("package_id", "", [
          { value: "b", label: "Basic" },
          { value: "s", label: "Standard" },
        ]),
      ),
    /has no free option/,
  );
  assert.equal(
    freePromoValue(
      f("package_id", "", [
        { value: "b", label: "Basic" },
        { value: "n", label: "No promo" },
      ]),
    ),
    "n",
  );
  assert.throws(
    () =>
      freePromoValue(
        f("package_id", "", [{ value: "x", label: "None", price: 1500 }]),
      ),
    /has no free option/,
  );
  // A hidden, pre-filled promo value without choices fails closed.
  assert.throws(
    () => freePromoValue({ name: "promo_package_id", value: "trial" }),
    /without a free choice/,
  );
  assert.equal(freePromoValue({ name: "promo_package_id", value: "" }), null);
  assert.equal(isPromoField(f("package_id", "")), true);
  assert.equal(isPromoField(f("attr_10", "Promote your ad")), true);
  assert.equal(
    isPromoField(
      f("attr_11", "Visibility", [
        { value: 0, label: "No promo" },
        { value: 1, label: "TOP 7 days" },
      ]),
    ),
    true,
  );
});

test("paid promo fields are rejected", async () => {
  const { browser, state } = mockAdvertBrowser(JijiBrowser);
  const base = solarCreate();
  await assert.rejects(
    browser.prepareAdvert({
      ...base,
      fields: { ...base.fields, premium_package: "top_7" },
    }),
    /always submitted with No promo/,
  );
  await assert.rejects(
    browser.prepareAdvert({
      ...base,
      fields: { ...base.fields, paid_package: 7 },
    }),
    /payment authorization/,
  );
  // A promo step with no free option cannot be prepared at all.
  state.base.fields[3] = {
    ...promoField,
    values: promoField.values.filter((v) => v.value),
  };
  await assert.rejects(browser.prepareAdvert(base), /has no free option/);
});

test("photo URL download checks host, type and size", async () => {
  assert.throws(() => assertPublicUrl("http://cdn.example.com/a.jpg"), /https/);
  for (const host of [
    "127.0.0.1",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:a9fe:a9fe]",
    "[64:ff9b::7f00:1]",
    "[2002:7f00:1::]",
    "[fec0::1]",
    "198.18.0.1",
    "169.254.169.254",
    "localhost",
  ])
    assert.throws(
      () => assertPublicUrl(`https://${host}/a.jpg`),
      /public host/,
      host,
    );
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700::1111"), true);
  // The connection's own lookup refuses private answers (no DNS rebinding gap).
  const resolveTo = (address) =>
    new Promise((resolve) =>
      publicLookup((host, opts, cb) =>
        cb(null, [{ address, family: address.includes(":") ? 6 : 4 }]),
      )("cdn.example.com", {}, (err, addr) =>
        resolve(err ? err.message : addr),
      ),
    );
  assert.match(await resolveTo("10.0.0.5"), /public host/);
  assert.match(await resolveTo("::ffff:7f00:1"), /public host/);
  assert.equal(await resolveTo("93.184.216.34"), "93.184.216.34");
  // The real https download path uses that lookup; refused before connecting.
  await assert.rejects(
    downloadPhoto("https://images.example.test/a.jpg", {
      lookup: (h, o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]),
    }),
    /public host/,
  );
  await assert.rejects(
    downloadPhoto("https://cdn.example.com/a.jpg", {
      get: mockGet(Buffer.from("<html>not an image</html>")),
    }),
    /not a JPEG, PNG or WebP/,
  );
  // Size is enforced while streaming, even without content-length.
  await assert.rejects(
    downloadPhoto("https://cdn.example.com/big.jpg", {
      get: async () => ({
        status: 200,
        headers: { get: () => null },
        body: (async function* () {
          yield JPEG;
          for (let i = 0; i < 11; i++) yield Buffer.alloc(1024 * 1024);
        })(),
      }),
    }),
    /larger than 10 MB/,
  );
  // One hard deadline covers the whole download, not just idle time.
  await assert.rejects(
    downloadPhoto("https://cdn.example.com/slow.jpg", {
      deadlineMs: 50,
      get: async () => ({
        status: 200,
        headers: { get: () => null },
        body: (async function* () {
          for (;;) {
            yield Buffer.from([1]);
            await new Promise((r) => setTimeout(r, 20));
          }
        })(),
      }),
    }),
    /took too long/,
  );
  assert.equal(isPublicAddress("::7f00:1"), false);
  // Redirects to a private host are refused.
  await assert.rejects(
    downloadPhoto("https://cdn.example.com/a.jpg", {
      get: async () => ({
        status: 302,
        headers: { get: () => "https://127.0.0.1/a.jpg" },
      }),
    }),
    /public host/,
  );
  const ok = await downloadPhoto("https://cdn.example.com/a.jpg", {
    get: mockGet(JPEG),
  });
  assert.equal(ok.type, "image/jpeg");
  assert.equal((await fs.stat(ok.path)).mode & 0o777, 0o600);
  await removeDownloaded([ok]);
  await assert.rejects(fs.stat(ok.path));
  // Cleanup never touches directories it did not create.
  const { dir, a } = await tempPhotos();
  await removeDownloaded([{ path: a, downloaded: true }]);
  assert.ok((await fs.stat(a)).isFile());
  await fs.rm(dir, { recursive: true, force: true });
});

test("local photo paths must be regular files inside an allowed folder", async () => {
  const { dir, a } = await tempPhotos();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "jiji-outside-"));
  try {
    const secret = path.join(outside, "passport.jpg");
    await fs.writeFile(secret, JPEG);
    const link = path.join(dir, "link.jpg");
    await fs.symlink(secret, link);
    assert.equal((await readPhoto(a, { roots: [dir] })).type, "image/jpeg");
    for (const file of [
      secret,
      link,
      path.join(outside, "missing.jpg"),
      path.join(dir, "..", path.basename(outside), "passport.jpg"),
      "relative.jpg",
    ])
      await assert.rejects(
        readPhoto(file, { roots: [dir] }),
        /Photo is not available\. Put advert photos in an allowed folder/,
        file,
      );
    // The `downloaded` flag cannot unlock files outside this module's temp dirs.
    await assert.rejects(
      readPhoto(secret, { roots: [dir], downloaded: true }),
      /not available/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("photo upload route comes from Jiji's form params and stays same-origin", () => {
  assert.equal(
    photoUploadPath({
      upload_image_url: "/api_web/v1/item-create/upload-image.json",
    }),
    "/api_web/v1/item-create/upload-image.json",
  );
  assert.throws(
    () => photoUploadPath({ upload_image_url: "https://evil.example/upload" }),
    /did not expose a photo upload route/,
  );
  assert.throws(() => photoUploadPath({}), /did not expose/);
});

test("confirm uploads new photos in order and submits once with matching token and payload", async () => {
  const { browser, state } = mockAdvertBrowser(JijiBrowser);
  const { dir, a, b } = await tempPhotos(browser);
  try {
    const plans = new ApprovalPlans();
    const prepared = await browser.prepareAdvert(
      solarCreate({ photos: [{ path: b }, { path: a }] }),
    );
    const plan = prepareAdvertPlan(plans, prepared);
    assert.equal(plan.state, "pending");
    assert.equal(plan.type, "jiji_advert");
    assert.ok(plan.approval_token.length >= 16);
    assert.equal(plan.payload_hash, prepared.payload_hash);
    assert.equal(plan.preview.promo.selected, "free");
    assert.ok(
      !JSON.stringify(plans.public(plans.get(plan.id))).includes(
        plan.approval_token,
      ),
    );
    assert.ok(!("token_hash" in plans.public(plans.get(plan.id))));
    const send = (p) => browser.executeAdvert(p.parameters, p.payload_hash);
    const done = await confirmAdvert(plans, send, {
      approval_token: plan.approval_token,
      payload_hash: plan.payload_hash,
      id: plan.id,
    });
    assert.equal(done.state, "submitted");
    assert.equal(done.result.promo, "free");
    assert.equal(state.writes.length, 1);
    const body = state.writes[0].body;
    assert.deepEqual(body.images, ["img-1", "img-2"]);
    assert.deepEqual(
      state.uploads.map((u) => u.path),
      [
        "/api_web/v1/item-create/upload-image.json",
        "/api_web/v1/item-create/upload-image.json",
      ],
    );
    assert.equal(state.uploads[0].sha256, prepared.parameters.photos[0].sha256);
    assert.equal(body.premium_package, "");
    assert.equal(state.writes[0].method, "POST");
    // Reuse is rejected and nothing is written again.
    await assert.rejects(
      confirmAdvert(plans, send, {
        approval_token: plan.approval_token,
        payload_hash: plan.payload_hash,
      }),
      /already used/,
    );
    assert.equal(state.writes.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("confirm rejects expired, mismatched, wrong-plan and payload-changed tokens", async () => {
  const { browser, state } = mockAdvertBrowser(JijiBrowser);
  const plans = new ApprovalPlans();
  const send = (p) => browser.executeAdvert(p.parameters, p.payload_hash);
  const fresh = async () =>
    prepareAdvertPlan(plans, await browser.prepareAdvert(solarCreate()));

  const expired = await fresh();
  plans.get(expired.id).expires = Date.now() - 1;
  await assert.rejects(
    confirmAdvert(plans, send, {
      approval_token: expired.approval_token,
      payload_hash: expired.payload_hash,
    }),
    /expired/,
  );

  const one = await fresh();
  const two = await fresh();
  await assert.rejects(
    confirmAdvert(plans, send, {
      approval_token: "x".repeat(32),
      payload_hash: one.payload_hash,
    }),
    /Unknown or expired approval token/,
  );
  await assert.rejects(
    confirmAdvert(plans, send, {
      approval_token: one.approval_token,
      payload_hash: one.payload_hash,
      id: two.id,
    }),
    /does not match this advert plan/,
  );
  assert.equal(plans.get(two.id).state, "pending");

  // Agent-supplied hash differs from the preview: token is voided.
  await assert.rejects(
    confirmAdvert(plans, send, {
      approval_token: one.approval_token,
      payload_hash: "0".repeat(64),
    }),
    /payload_hash does not match/,
  );
  assert.equal(plans.get(one.id).state, "failed");
  await assert.rejects(
    confirmAdvert(plans, send, {
      approval_token: one.approval_token,
      payload_hash: one.payload_hash,
    }),
    /already used/,
  );

  // The stored payload changed after the preview: nothing is sent.
  const changedPlan = plans.get(two.id);
  changedPlan.parameters = {
    ...changedPlan.parameters,
    fields: { ...changedPlan.parameters.fields, attr_power: "500" },
  };
  const changed = await confirmAdvert(plans, send, {
    approval_token: two.approval_token,
    payload_hash: two.payload_hash,
  });
  assert.equal(changed.state, "failed");
  assert.match(changed.result.error, /changed since the preview/);

  // Jiji's live form changed between preview and confirm (the brand list now
  // contains the brand): the recomputed submission differs, nothing is sent.
  const three = await fresh();
  state.category.fields[2].values.push({ value: 503, label: "Canadian Solar" });
  const moved = await confirmAdvert(plans, send, {
    approval_token: three.approval_token,
    payload_hash: three.payload_hash,
  });
  assert.equal(moved.state, "failed");
  assert.match(moved.result.error, /changed since the preview/);
  assert.equal(state.writes.length, 0);
});

test("confirm marks a failed live re-read as failed, not uncertain", async () => {
  const { browser, state } = mockAdvertBrowser(JijiBrowser);
  const plans = new ApprovalPlans();
  const plan = prepareAdvertPlan(
    plans,
    await browser.prepareAdvert(solarCreate()),
  );
  state.base.params.advert_id = 13;
  state.base.params.modify_advert_url = "/api_web/v1/item/modify/13.json";
  const result = await confirmAdvert(
    plans,
    (p) => browser.executeAdvert(p.parameters, p.payload_hash),
    { approval_token: plan.approval_token, payload_hash: plan.payload_hash },
  );
  assert.equal(result.state, "failed");
  assert.match(result.result.error, /form changed.*Nothing was sent/);
  assert.equal(state.writes.length, 0);
});

test("confirm refuses when a previewed photo file changed on disk", async () => {
  const { browser, state } = mockAdvertBrowser(JijiBrowser);
  const { dir, a } = await tempPhotos(browser);
  try {
    const plans = new ApprovalPlans();
    const plan = prepareAdvertPlan(
      plans,
      await browser.prepareAdvert(solarCreate({ photos: [{ path: a }] })),
    );
    await fs.writeFile(a, Buffer.concat([JPEG, Buffer.from([7])]));
    const result = await confirmAdvert(
      plans,
      (p) => browser.executeAdvert(p.parameters, p.payload_hash),
      { approval_token: plan.approval_token, payload_hash: plan.payload_hash },
    );
    assert.equal(result.state, "failed");
    assert.match(result.result.error, /changed since the preview/);
    assert.equal(state.uploads.length, 0);
    assert.equal(state.writes.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("edit uses advert_edit_form, preserves identity, and reorders/deletes/adds photos", async () => {
  const { browser, state } = mockAdvertBrowser(JijiBrowser, {
    editing: true,
    images: [
      { id: 901, url: "https://pictures.example/901.jpg" },
      { id: 902, url: "https://pictures.example/902.jpg" },
      { id: 903, url: "https://pictures.example/903.jpg" },
    ],
  });
  const { dir, a } = await tempPhotos(browser);
  try {
    const prepared = await browser.prepareAdvert({
      advert_id: 77,
      category_id: 1083,
      region_id: 4,
      fields: { title: "Edited panel", description: "Updated mock" },
      price: 90000,
      negotiable: false,
      photos: [{ existing_id: 903 }, { path: a }, { existing_id: "901" }],
    });
    assert.ok(state.reads.some((r) => r.name === "advert_edit_form"));
    assert.ok(!state.reads.some((r) => r.name === "advert_create_form"));
    assert.equal(prepared.parameters.editing, true);
    assert.equal(prepared.preview.action, "edit");
    assert.equal(prepared.request.method, "PUT");
    assert.equal(prepared.request.body.price_negotiable, 0);
    assert.equal(prepared.preview.promo.selected, "free");
    assert.deepEqual(
      prepared.preview.photos.map((p) => [
        p.source,
        p.id ?? p.file,
        !!p.deleted,
      ]),
      [
        ["existing", "903", false],
        ["file", "front.jpg", false],
        ["existing", "901", false],
        ["existing", "902", true],
      ],
    );
    const plans = new ApprovalPlans();
    const plan = prepareAdvertPlan(plans, prepared);
    await confirmAdvert(
      plans,
      (p) => browser.executeAdvert(p.parameters, p.payload_hash),
      { approval_token: plan.approval_token, payload_hash: plan.payload_hash },
    );
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0].method, "PUT");
    assert.match(state.writes[0].path, /modify\/77\.json$/);
    assert.deepEqual(state.writes[0].body.images, ["903", "img-1", "901"]);
    // Identity: a different advert id or a photo from another advert is refused.
    await assert.rejects(
      browser.prepareAdvert({ ...prepared.parameters, advert_id: 78 }),
      /form changed/,
    );
    await assert.rejects(
      browser.prepareAdvert({
        ...prepared.parameters,
        photos: [{ existing_id: 555 }],
      }),
      /not on this advert/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("create cannot reference existing photo ids", async () => {
  const { browser } = mockAdvertBrowser(JijiBrowser);
  await assert.rejects(
    browser.prepareAdvert(solarCreate({ photos: [{ existing_id: 1 }] })),
    /not on this advert/,
  );
});

test("MCP prepare/confirm advert tools route preview and token without auto-approve", async () => {
  const seen = [];
  const request = async (m) => {
    seen.push(m);
    if (m.action === "prepare_advert")
      return {
        id: "11111111-1111-4111-8111-111111111111",
        state: "pending",
        approval_token: "t".repeat(32),
        payload_hash: "a".repeat(64),
        preview: { promo: { selected: "free" } },
      };
    if (m.action === "confirm_advert") return { state: "submitted" };
    throw new Error("Unexpected action " + m.action);
  };
  const [x, y] = InMemoryTransport.createLinkedPair();
  const server = createServer(request);
  const client = new Client({ name: "advert-test", version: "1" });
  await server.connect(x);
  await client.connect(y);
  try {
    const tools = (await client.listTools()).tools;
    const confirm = tools.find((t) => t.name === "jiji_confirm_advert");
    assert.ok(confirm);
    assert.deepEqual(confirm.inputSchema.required.sort(), [
      "approval_token",
      "payload_hash",
    ]);
    const prepared = await client.callTool({
      name: "jiji_prepare_advert",
      arguments: solarCreate({
        photos: [
          { path: "/tmp/a.jpg" },
          { url: "https://cdn.example.com/b.jpg" },
        ],
      }),
    });
    assert.ok(!prepared.isError, prepared.content[0].text);
    assert.equal(seen[0].parameters.price, 95000);
    assert.equal("promo" in seen[0].parameters, false);
    const paid = await client.callTool({
      name: "jiji_prepare_advert",
      arguments: solarCreate({ promo: "top" }),
    });
    assert.equal(paid.isError, true);
    const both = await client.callTool({
      name: "jiji_prepare_advert",
      arguments: solarCreate({ category_id: 1083 }),
    });
    assert.equal(both.isError, true);
    const { category_path, ...noCategory } = solarCreate();
    const neither = await client.callTool({
      name: "jiji_prepare_advert",
      arguments: noCategory,
    });
    assert.equal(neither.isError, true);
    assert.match(neither.content[0].text, /exactly one of category_id/);
    const wipe = await client.callTool({
      name: "jiji_prepare_advert",
      arguments: { ...solarCreate(), photos: [], remove_all_photos: true },
    });
    assert.ok(!wipe.isError, wipe.content[0].text);
    assert.equal(seen.at(-1).parameters.remove_all_photos, true);
    const done = await client.callTool({
      name: "jiji_confirm_advert",
      arguments: {
        approval_token: "t".repeat(32),
        payload_hash: "a".repeat(64),
      },
    });
    assert.equal(JSON.parse(done.content[0].text).state, "submitted");
    assert.equal(seen.at(-1).action, "confirm_advert");
    assert.ok(!seen.some((m) => /send|approve/.test(m.action)));
  } finally {
    await client.close();
    await server.close();
  }
});

const editBrowser = () =>
  mockAdvertBrowser(JijiBrowser, {
    editing: true,
    images: [
      { id: 901, url: "https://pictures.example/901.jpg" },
      { id: 902, url: "https://pictures.example/902.jpg" },
    ],
  });
const solarEdit = (extra = {}) => ({
  advert_id: 77,
  category_id: 1083,
  region_id: 4,
  fields: { title: "Edited panel", description: "Updated mock" },
  ...extra,
});

test("final price is validated whether it comes from price or fields.price", async () => {
  const { browser, state } = mockAdvertBrowser(JijiBrowser);
  const { price, ...base } = solarCreate();
  for (const bad of [-1, NaN, 1e12 + 1, Infinity, "abc", ""])
    await assert.rejects(
      browser.prepareAdvert({
        ...base,
        fields: { ...base.fields, price: bad },
      }),
      /Price must be a number from 0 to/,
      String(bad),
    );
  const ok = await browser.prepareAdvert({
    ...base,
    fields: { ...base.fields, price: "95000" },
  });
  assert.equal(ok.request.body.price, "95000");
  assert.equal(state.writes.length, 0);
});

test("edit without photos keeps the existing photos and marks them unchanged", async () => {
  const { browser, state } = editBrowser();
  const prepared = await browser.prepareAdvert(solarEdit());
  assert.deepEqual(prepared.request.body.images, ["901", "902"]);
  assert.deepEqual(prepared.preview.photos, {
    unchanged: true,
    ids: ["901", "902"],
  });
  assert.ok(!("images" in prepared.preview.attributes));
  const plans = new ApprovalPlans();
  const plan = prepareAdvertPlan(plans, prepared);
  const done = await confirmAdvert(
    plans,
    (p) => browser.executeAdvert(p.parameters, p.payload_hash),
    { approval_token: plan.approval_token, payload_hash: plan.payload_hash },
  );
  assert.equal(done.state, "submitted");
  assert.equal(state.uploads.length, 0);
  assert.deepEqual(state.writes[0].body.images, ["901", "902"]);
});

test("photos: [] on edit needs remove_all_photos and the preview calls out the wipe", async () => {
  const { browser } = editBrowser();
  await assert.rejects(
    browser.prepareAdvert(solarEdit({ photos: [] })),
    /would remove every photo.*remove_all_photos: true/,
  );
  await assert.rejects(
    browser.prepareAdvert(
      solarEdit({ photos: [{ existing_id: 901 }], remove_all_photos: true }),
    ),
    /only valid with photos: \[\]/,
  );
  const wiped = await browser.prepareAdvert(
    solarEdit({ photos: [], remove_all_photos: true }),
  );
  assert.deepEqual(wiped.request.body.images, []);
  assert.match(
    wiped.preview.photo_notice,
    /All 2 existing photo\(s\) will be removed/,
  );
  assert.deepEqual(
    wiped.preview.photos.map((p) => [p.id, p.deleted]),
    [
      ["901", true],
      ["902", true],
    ],
  );
});

test("an unrecognised pre-filled trial or paid control fails prepare closed", async () => {
  const hidden = {
    name: "attr_listing_mode",
    label: "Listing",
    value: "trial_14",
  };
  assert.equal(isPromoField({ ...hidden, options: null }), false);
  const { browser, state } = mockAdvertBrowser(JijiBrowser);
  state.base.fields.push(hidden);
  await assert.rejects(
    browser.prepareAdvert(solarCreate()),
    /"Listing" set to what looks like a paid promotion or trial/,
  );
  // A selected option that costs money fails closed even with a bland label.
  state.base.fields[state.base.fields.length - 1] = {
    name: "attr_plan",
    label: "Plan",
    value: 2,
    values: [
      { value: 1, label: "Standard" },
      { value: 2, label: "Standard+", price: 1500 },
    ],
  };
  await assert.rejects(
    browser.prepareAdvert(solarCreate()),
    /looks like a paid promotion/,
  );
  // The free choice of the same control is accepted.
  state.base.fields.at(-1).value = 1;
  await browser.prepareAdvert(solarCreate());
  // The final pre-write guard applies the same rule.
  assert.throws(
    () => assertFreeOnly({ premium_package: "" }, [promoField, hidden]),
    /paid promotion/,
  );
  assert.equal(state.writes.length, 0);
});

test("ordinary Boost/promoted attribute values do not trip the paid-prefill guard", async () => {
  const { browser, state } = mockAdvertBrowser(JijiBrowser);
  state.base.fields.push(
    {
      name: "attr_model",
      label: "Model",
      values: [
        { value: "boost", label: "Boost" },
        { value: "boost_pro", label: "Boost Pro" },
      ],
    },
    { name: "attr_series", label: "Series" },
  );
  state.category.fields
    .find((f) => f.name === "attr_condition")
    .values.push({ value: "promoted", label: "promoted" });
  // 1. A model option labelled "Boost".
  await browser.prepareAdvert(
    solarCreate({ fields: { ...solarCreate().fields, attr_model: "boost" } }),
  );
  // 2. "Boost Pro" as an option and as a free-text attribute.
  await browser.prepareAdvert(
    solarCreate({
      fields: {
        ...solarCreate().fields,
        attr_model: "boost_pro",
        attr_series: "Boost Pro",
      },
    }),
  );
  // 3. A condition of "promoted".
  await browser.prepareAdvert(
    solarCreate({
      fields: { ...solarCreate().fields, attr_condition: "promoted" },
    }),
  );
  assert.equal(state.writes.length, 0);
});

test("strong promo values still fail closed: hidden trial_14 and priced options", async () => {
  // 4. A hidden, unrecognised control holding a trial token.
  const { browser, state } = mockAdvertBrowser(JijiBrowser);
  state.base.fields.push({
    name: "attr_mode",
    label: "Mode",
    value: "trial_14",
  });
  await assert.rejects(
    browser.prepareAdvert(solarCreate()),
    /"Mode" set to what looks like a paid promotion or trial/,
  );
  // 5. A selected option that costs money, on an otherwise ordinary control.
  state.base.fields[state.base.fields.length - 1] = {
    name: "attr_finish",
    label: "Finish",
    value: "gloss",
    values: [
      { value: "matte", label: "Matte" },
      { value: "gloss", label: "Gloss", price: 500 },
    ],
  };
  await assert.rejects(
    browser.prepareAdvert(solarCreate()),
    /looks like a paid promotion/,
  );
  // A strong token only counts on a promo-looking control or beside paid
  // siblings; here a sibling option costs money.
  state.base.fields[state.base.fields.length - 1] = {
    name: "attr_listing",
    label: "Listing",
    value: "top_7",
    values: [
      { value: "std", label: "Standard" },
      { value: "top_7", label: "Top" },
      { value: "top_30", label: "Top", price: 2000 },
    ],
  };
  await assert.rejects(
    browser.prepareAdvert(solarCreate()),
    /looks like a paid promotion/,
  );
  assert.equal(state.writes.length, 0);
});

test("duplicate category names at one level require category_id", () => {
  const tree = [
    {
      id: 47,
      name: "Repair & Construction",
      children: [
        { id: 1083, name: "Electrical Equipment" },
        { id: 1090, name: "electrical equipment" },
      ],
    },
  ];
  assert.throws(
    () => resolveCategoryPath(tree, CATEGORY_HINTS.solar_panels),
    /matches 2 categories.*pass category_id/,
  );
});

test("a stored token hash of the wrong length is an unknown token, not a crash", async () => {
  const { browser } = mockAdvertBrowser(JijiBrowser);
  const plans = new ApprovalPlans();
  const plan = prepareAdvertPlan(
    plans,
    await browser.prepareAdvert(solarCreate()),
  );
  plans.get(plan.id).token_hash = "abcd";
  const send = () => assert.fail("must not send");
  await assert.rejects(
    confirmAdvert(plans, send, {
      approval_token: plan.approval_token,
      payload_hash: plan.payload_hash,
    }),
    /Unknown or expired approval token/,
  );
  await assert.rejects(
    confirmAdvert(plans, send, {
      approval_token: plan.approval_token,
      payload_hash: plan.payload_hash,
      id: plan.id,
    }),
    /does not match this advert plan/,
  );
  assert.equal(plans.get(plan.id).state, "pending");
});
