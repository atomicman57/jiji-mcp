import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { D1KV } from "../cloud/d1-kv.mjs";

test("D1 storage preserves values, metadata, expiry, pagination and revocation", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('test')}}",
      compatibilityDate: "2026-10-01",
      d1Databases: ["MCP_STORAGE"],
    }),
  );
  try {
    const { MCP_STORAGE: db } = await mf.getBindings();
    const schema = await readFile(
      new URL("../cloud/d1-schema.sql", import.meta.url),
      "utf8",
    );
    for (const sql of schema.split(";").filter((s) => s.trim()))
      await db.prepare(sql).run();
    const storage = new D1KV(db);
    await storage.put(
      "grant:α",
      JSON.stringify({ name: "Jiji ☀", active: true }),
      { metadata: { scope: "read" }, expirationTtl: 300 },
    );
    const value = await storage.getWithMetadata("grant:α", "json");
    assert.deepEqual(value.value, { name: "Jiji ☀", active: true });
    assert.deepEqual(value.metadata, { scope: "read" });
    await storage.put("grant:binary", new Uint8Array([0, 128, 255]));
    assert.deepEqual(
      new Uint8Array(await storage.get("grant:binary", "arrayBuffer")),
      new Uint8Array([0, 128, 255]),
    );
    await storage.put("grant:expired", "expired", {
      expiration: Math.floor(Date.now() / 1000) - 1,
    });
    assert.equal(await storage.get("grant:expired"), null);
    const first = await storage.list({ prefix: "grant:", limit: 1 });
    const second = await storage.list({
      prefix: "grant:",
      limit: 1,
      cursor: first.cursor,
    });
    assert.equal(first.list_complete, false);
    assert.equal(second.list_complete, true);
    assert.deepEqual(
      new Set([...first.keys, ...second.keys].map((k) => k.name)),
      new Set(["grant:α", "grant:binary"]),
    );
    await assert.rejects(
      storage.list({ prefix: "other:", cursor: first.cursor }),
      /prefix mismatch/,
    );
    await storage.put("literal_%:key", "literal");
    assert.equal((await storage.list({ prefix: "literal_%:" })).keys.length, 1);
    await storage.delete("grant:α");
    assert.equal(await storage.get("grant:α"), null);
    let fallbackReads = 0;
    const migration = new D1KV(db, {
      getWithMetadata: async () => {
        fallbackReads++;
        return { value: "old-credential", metadata: null };
      },
    });
    await migration.delete("revoked");
    assert.equal(await migration.get("revoked"), null);
    assert.equal(
      fallbackReads,
      0,
      "revocation tombstone must prevent legacy credential recovery",
    );
  } finally {
    await mf.dispose();
  }
});
