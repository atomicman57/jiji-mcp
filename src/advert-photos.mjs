// Resolves advert photo sources on the companion machine. Local files are read
// in place; URLs are downloaded once to a private temp file at prepare time so
// confirm uploads exactly the bytes the owner previewed (checked by sha256).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import dns from "node:dns/promises";
import { createHash, randomBytes } from "node:crypto";

export const MAX_PHOTOS = 20;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export function sniffImage(bytes) {
  const b = bytes;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return "image/jpeg";
  if (
    b.length > 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47
  )
    return "image/png";
  if (
    b.length > 12 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function checkImage(bytes, label) {
  if (!bytes.length) throw new Error(`Photo ${label} is empty.`);
  if (bytes.length > MAX_PHOTO_BYTES)
    throw new Error(`Photo ${label} is larger than 10 MB.`);
  const type = sniffImage(bytes);
  if (!type)
    throw new Error(`Photo ${label} is not a JPEG, PNG or WebP image.`);
  return type;
}

// Strips query strings (which may carry signatures) from URLs shown back.
export function displayUrl(value) {
  const u = new URL(value);
  return u.origin + u.pathname;
}

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  return (
    v === "::1" ||
    v === "::" ||
    v.startsWith("fc") ||
    v.startsWith("fd") ||
    v.startsWith("fe80") ||
    (v.startsWith("::ffff:") && privateAddress(v.slice(7)))
  );
}

export async function assertPublicUrl(value, lookup = dns.lookup) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error("Photo URL is not a valid URL.");
  }
  if (u.protocol !== "https:" || u.username || u.password)
    throw new Error("Photo URLs must be plain https:// links.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.local$|\.internal$/i.test(host))
    throw new Error("Photo URL must be a public host.");
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => privateAddress(a.address)))
    throw new Error("Photo URL must be a public host.");
  return u;
}

export async function downloadPhoto(
  url,
  { fetchImpl = fetch, lookup, tmpDir } = {},
) {
  let current = await assertPublicUrl(url, lookup);
  let r;
  for (let hop = 0; ; hop++) {
    r = await fetchImpl(current.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
    if (r.status < 300 || r.status >= 400) break;
    if (hop >= 3) throw new Error("Photo URL redirected too many times.");
    current = await assertPublicUrl(
      new URL(r.headers.get("location") || "", current).href,
      lookup,
    );
  }
  if (!r.ok) throw new Error(`Photo URL returned HTTP ${r.status}.`);
  const declared = Number(r.headers.get("content-length") || 0);
  if (declared > MAX_PHOTO_BYTES)
    throw new Error("Photo at URL is larger than 10 MB.");
  const bytes = Buffer.from(await r.arrayBuffer());
  const type = checkImage(bytes, displayUrl(url));
  const dir = await fs.mkdtemp(
    path.join(tmpDir || os.tmpdir(), "jiji-advert-photo-"),
  );
  const file = path.join(dir, randomBytes(8).toString("hex") + "." + EXT[type]);
  await fs.writeFile(file, bytes, { mode: 0o600 });
  return {
    path: file,
    name: path.basename(file),
    sha256: sha256(bytes),
    size: bytes.length,
    type,
    source_url: displayUrl(url),
    downloaded: true,
  };
}

export async function readPhoto(file, expectedSha) {
  if (typeof file !== "string" || !path.isAbsolute(file))
    throw new Error("Photo paths must be absolute local file paths.");
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Photo file not found: ${file}`);
  if (stat.size > MAX_PHOTO_BYTES)
    throw new Error(`Photo ${path.basename(file)} is larger than 10 MB.`);
  const bytes = await fs.readFile(file);
  const type = checkImage(bytes, path.basename(file));
  const digest = sha256(bytes);
  if (expectedSha && digest !== expectedSha)
    throw Object.assign(
      new Error(
        `Photo ${path.basename(file)} changed since the preview. Prepare a fresh preview.`,
      ),
      { nothingSent: true },
    );
  return { bytes, type, sha256: digest, size: bytes.length };
}

// Normalizes the ordered photo list. The order is the final photo order; on
// edit, existing photos left out of the list are deleted from the advert.
export async function resolvePhotos(photos, options = {}) {
  if (photos === undefined) return undefined;
  if (!Array.isArray(photos) || photos.length > MAX_PHOTOS)
    throw new Error(`Provide at most ${MAX_PHOTOS} photos.`);
  const out = [];
  for (const p of photos) {
    if (p.existing_id !== undefined) {
      out.push({ existing_id: String(p.existing_id) });
    } else if (p.path) {
      const read = await readPhoto(p.path, p.sha256);
      out.push({
        path: p.path,
        name: path.basename(p.path),
        sha256: read.sha256,
        size: read.size,
        type: read.type,
        ...(p.source_url ? { source_url: p.source_url } : {}),
        ...(p.downloaded ? { downloaded: true } : {}),
      });
    } else if (p.url) {
      out.push(await downloadPhoto(p.url, options));
    } else throw new Error("Each photo needs existing_id, path or url.");
  }
  return out;
}

// Removes only temp directories this module created for URL downloads.
export async function removeDownloaded(photos, tmpDir = os.tmpdir()) {
  for (const p of photos || []) {
    const dir = p.downloaded && p.path ? path.dirname(p.path) : "";
    if (
      dir &&
      path.dirname(dir) === path.resolve(tmpDir) &&
      path.basename(dir).startsWith("jiji-advert-photo-")
    )
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
