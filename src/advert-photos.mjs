// Resolves advert photo sources on the companion machine. Local files must sit
// inside an owner-chosen photo folder; URLs are downloaded once to a private
// temp file at prepare time so confirm uploads exactly the bytes the owner
// previewed (checked by sha256).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import https from "node:https";
import dns from "node:dns";
import { createHash, randomBytes } from "node:crypto";

export const MAX_PHOTOS = 20;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const TEMP_PREFIX = "jiji-advert-photo-";
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// Folders agents may attach photos from. Set JIJI_ADVERT_PHOTO_DIRS (or
// advertPhotoDirs in the companion config) to a path-delimited list.
export function photoRoots(env = process.env, config = {}) {
  const raw = env.JIJI_ADVERT_PHOTO_DIRS ?? config.advertPhotoDirs;
  const list = Array.isArray(raw)
    ? raw
    : raw
      ? String(raw).split(path.delimiter)
      : [path.join(os.homedir(), "Pictures", "Jiji")];
  return list.filter((d) => path.isAbsolute(d));
}

export function sniffImage(b) {
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

// Special-purpose ranges. IPv4-mapped, NAT64 and 6to4 IPv6 forms are blocked
// whole rather than unwrapped: public image hosts do not resolve to them.
// Separate lists: Node maps IPv4 into ::ffff:0:0/96 when lists are mixed.
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
])
  blocked4.addSubnet(a, p, "ipv4");
for (const [a, p] of [
  ["::", 127],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
])
  blocked6.addSubnet(a, p, "ipv6");

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  return family === 4
    ? !blocked4.check(address, "ipv4")
    : !blocked6.check(address, "ipv6");
}

export function assertPublicUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error("Photo URL is not a valid URL.");
  }
  if (u.protocol !== "https:" || u.username || u.password)
    throw new Error("Photo URLs must be plain https:// links.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host))
    throw new Error("Photo URL must be a public host.");
  if (net.isIP(host) && !isPublicAddress(host))
    throw new Error("Photo URL must be a public host.");
  return u;
}

// DNS lookup that refuses non-public answers. Used as the connection's own
// lookup, so the checked address is the one connected to (no rebinding gap).
export function publicLookup(lookup = dns.lookup) {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [];
      if (!list.length || list.some((a) => !isPublicAddress(a.address)))
        return callback(new Error("Photo URL must be a public host."));
      if (options?.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

// Minimal https GET pinned to publicLookup. Returns a fetch-like shape.
function guardedGet(url, { lookup } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { lookup: publicLookup(lookup), timeout: 20000 },
      (res) =>
        resolve({
          status: res.statusCode,
          headers: { get: (k) => res.headers[k.toLowerCase()] ?? null },
          body: res,
          cancel: () => res.destroy(),
        }),
    );
    req.on("timeout", () =>
      req.destroy(new Error("Photo download timed out.")),
    );
    req.on("error", (e) =>
      reject(
        /public host/.test(e.message)
          ? e
          : new Error("Photo URL could not be downloaded."),
      ),
    );
  });
}

async function readCapped(body) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > MAX_PHOTO_BYTES)
      throw new Error("Photo at URL is larger than 10 MB.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// `get(url)` may be injected in tests; it must return { status, headers.get, body }.
export async function downloadPhoto(url, { get, lookup, tmpDir } = {}) {
  const fetchOnce = get || ((u) => guardedGet(u, { lookup }));
  let current = assertPublicUrl(url);
  let r;
  for (let hop = 0; ; hop++) {
    r = await fetchOnce(current.href);
    if (r.status < 300 || r.status >= 400) break;
    r.cancel?.();
    if (hop >= 3) throw new Error("Photo URL redirected too many times.");
    current = assertPublicUrl(
      new URL(r.headers.get("location") || "", current).href,
    );
  }
  if (r.status < 200 || r.status >= 300) {
    r.cancel?.();
    throw new Error(`Photo URL returned HTTP ${r.status}.`);
  }
  if (Number(r.headers.get("content-length") || 0) > MAX_PHOTO_BYTES) {
    r.cancel?.();
    throw new Error("Photo at URL is larger than 10 MB.");
  }
  const bytes = await readCapped(r.body || []);
  const type = checkImage(bytes, displayUrl(url));
  const dir = await fs.mkdtemp(path.join(tmpDir || os.tmpdir(), TEMP_PREFIX));
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

const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

function ownTempFile(file, tmpDir = os.tmpdir()) {
  const dir = path.dirname(file);
  return (
    path.dirname(dir) === path.resolve(tmpDir) &&
    path.basename(dir).startsWith(TEMP_PREFIX)
  );
}

// Reads a photo the agent may attach: a regular, non-symlink file inside an
// allowed root (or a temp file this module downloaded). Errors do not reveal
// whether a path outside the allowed folders exists.
export async function readPhoto(
  file,
  { expectedSha, roots = [], downloaded, tmpDir } = {},
) {
  const denied = () =>
    new Error(
      "Photo is not available. Put advert photos in an allowed folder (JIJI_ADVERT_PHOTO_DIRS) and pass the absolute path.",
    );
  if (typeof file !== "string" || !path.isAbsolute(file)) throw denied();
  const real = await fs.realpath(file).catch(() => null);
  const lstat = await fs.lstat(file).catch(() => null);
  if (!real || !lstat || lstat.isSymbolicLink() || !lstat.isFile())
    throw denied();
  const realRoots = await Promise.all(
    roots.map((r) => fs.realpath(r).catch(() => null)),
  );
  const allowed =
    (downloaded && ownTempFile(file, tmpDir)) ||
    realRoots.some((root) => root && inside(root, real));
  if (!allowed) throw denied();
  if (lstat.size > MAX_PHOTO_BYTES)
    throw new Error(`Photo ${path.basename(file)} is larger than 10 MB.`);
  const bytes = await fs.readFile(real);
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
      const read = await readPhoto(p.path, {
        expectedSha: p.sha256,
        roots: options.roots,
        downloaded: p.downloaded,
        tmpDir: options.tmpDir,
      });
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

// Agent input may only name a source; derived keys are stripped.
export const photoSources = (photos) =>
  photos?.map((p) =>
    p.existing_id !== undefined
      ? { existing_id: p.existing_id }
      : p.path
        ? { path: p.path }
        : { url: p.url },
  );

// Removes only temp directories this module created for URL downloads.
export async function removeDownloaded(photos, tmpDir = os.tmpdir()) {
  for (const p of photos || [])
    if (p.downloaded && p.path && ownTempFile(p.path, tmpDir))
      await fs
        .rm(path.dirname(p.path), { recursive: true, force: true })
        .catch(() => {});
}

// Removes downloads older than a plan's lifetime (unconfirmed previews).
export async function sweepDownloads(
  maxAgeMs = 15 * 60000,
  tmpDir = os.tmpdir(),
) {
  const entries = await fs.readdir(tmpDir).catch(() => []);
  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const dir = path.join(tmpDir, name);
    const stat = await fs.lstat(dir).catch(() => null);
    if (stat?.isDirectory() && Date.now() - stat.mtimeMs > maxAgeMs)
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
