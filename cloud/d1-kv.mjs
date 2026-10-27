// KV-compatible storage backed only by D1 after migration. Values remain bytes.
const now = () => Math.floor(Date.now() / 1000);
const encode = (bytes) => {
  let value = "";
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
};
const decode = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const bytesOf = async (value) => {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ReadableStream)
    return new Uint8Array(await new Response(value).arrayBuffer());
  throw new TypeError("Unsupported KV value");
};
const asType = (bytes, type) => {
  if (type === "arrayBuffer") return bytes.buffer;
  if (type === "stream") return new Response(bytes).body;
  const text = new TextDecoder().decode(bytes);
  if (type === "json") return JSON.parse(text);
  if (type !== "text") throw new TypeError("Unsupported KV read type");
  return text;
};
export class D1KV {
  constructor(db, legacy = null) {
    this.db = db;
    this.legacy = legacy;
  }
  async getWithMetadata(key, options = {}) {
    const type = typeof options === "string" ? options : options.type || "text";
    const row = await this.db
      .prepare(
        "SELECT value, metadata, expires_at, deleted FROM kv_entries WHERE key = ?",
      )
      .bind(key)
      .first();
    if (row) {
      if (row.deleted || (row.expires_at !== null && row.expires_at <= now()))
        return { value: null, metadata: null, cacheStatus: null };
      return {
        value: asType(decode(row.value), type),
        metadata: JSON.parse(row.metadata),
        cacheStatus: null,
      };
    }
    // Temporary migration only: writes/deletes always go to D1, and rows (even
    // expired rows) suppress fallback so revoked tokens cannot be resurrected.
    if (this.legacy) return this.legacy.getWithMetadata(key, options);
    return { value: null, metadata: null, cacheStatus: null };
  }
  async get(key, options = {}) {
    if (Array.isArray(key)) {
      const values = await Promise.all(key.map((k) => this.get(k, options)));
      return new Map(key.map((k, i) => [k, values[i]]));
    }
    return (await this.getWithMetadata(key, options)).value;
  }
  async put(key, value, options = {}) {
    const expiry =
      options.expirationTtl !== undefined
        ? now() + Number(options.expirationTtl)
        : options.expiration !== undefined
          ? Number(options.expiration)
          : null;
    const bytes = await bytesOf(value);
    if (bytes.length > 1400000)
      throw new RangeError("D1 KV value exceeds supported row size");
    await this.db
      .prepare(
        `INSERT INTO kv_entries(key,value,metadata,expires_at,deleted) VALUES(?,?,?,?,0)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, metadata=excluded.metadata, expires_at=excluded.expires_at, deleted=0`,
      )
      .bind(
        key,
        encode(bytes),
        JSON.stringify(options.metadata ?? null),
        expiry,
      )
      .run();
  }
  async delete(key) {
    if (this.legacy) {
      await this.db
        .prepare(
          `INSERT INTO kv_entries(key,value,metadata,expires_at,deleted) VALUES(?,'','null',NULL,1)
        ON CONFLICT(key) DO UPDATE SET value='',metadata='null',expires_at=NULL,deleted=1`,
        )
        .bind(key)
        .run();
    } else
      await this.db
        .prepare("DELETE FROM kv_entries WHERE key = ?")
        .bind(key)
        .run();
  }
  async list({ prefix = "", limit = 1000, cursor = "" } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new RangeError("Invalid list limit");
    let after = "";
    if (cursor) {
      const parsed = JSON.parse(new TextDecoder().decode(decode(cursor)));
      if (parsed.prefix !== prefix) throw new Error("Cursor prefix mismatch");
      after = parsed.after;
    }
    // An indexed range, rather than a full-table LIKE scan on every request.
    const points = Array.from(prefix);
    let upper = null;
    while (points.length) {
      const last = points.pop().codePointAt(0);
      if (last < 0x10ffff) {
        upper = points.join("") + String.fromCodePoint(last + 1);
        break;
      }
    }
    const rows = await this.db
      .prepare(
        `SELECT key, metadata, expires_at, deleted FROM kv_entries
      WHERE key >= ? AND key > ? ${upper === null ? "" : "AND key < ?"}
      ${this.legacy ? "" : "AND deleted = 0 AND (expires_at IS NULL OR expires_at > ?)"}
      ORDER BY key ${this.legacy ? "" : "LIMIT ?"}`,
      )
      .bind(
        prefix,
        after,
        ...(upper === null ? [] : [upper]),
        ...(this.legacy ? [] : [now(), limit + 1]),
      )
      .all();
    let entries;
    if (this.legacy) {
      const map = new Map();
      let next;
      do {
        const page = await this.legacy.list({
          prefix,
          ...(next ? { cursor: next } : {}),
        });
        for (const key of page.keys)
          if (key.name > after) map.set(key.name, key);
        next = page.list_complete ? null : page.cursor;
      } while (next);
      for (const row of rows.results) {
        map.delete(row.key);
        if (!row.deleted && (row.expires_at === null || row.expires_at > now()))
          map.set(row.key, this.listKey(row));
      }
      entries = [...map.values()].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } else entries = rows.results.map((row) => this.listKey(row));
    const complete = entries.length <= limit;
    const keys = entries.slice(0, limit);
    return {
      keys,
      list_complete: complete,
      cursor: complete
        ? ""
        : encode(
            new TextEncoder().encode(
              JSON.stringify({ prefix, after: keys.at(-1).name }),
            ),
          ),
      cacheStatus: null,
    };
  }
  listKey(row) {
    return {
      name: row.key,
      ...(row.expires_at === null ? {} : { expiration: row.expires_at }),
      ...(row.metadata === "null"
        ? {}
        : { metadata: JSON.parse(row.metadata) }),
    };
  }
}

export function withD1Storage(env, binding = "OAUTH_KV") {
  if (!env.MCP_STORAGE) throw new Error("MCP_STORAGE D1 binding is required");
  return { ...env, [binding]: new D1KV(env.MCP_STORAGE) };
}
export async function cleanupD1Storage(env) {
  await env.MCP_STORAGE.prepare(
    `DELETE FROM kv_entries WHERE key IN
    (SELECT key FROM kv_entries WHERE expires_at <= ? LIMIT 10000)`,
  )
    .bind(now())
    .run();
}
