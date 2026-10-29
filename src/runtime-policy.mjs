const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function defined(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function flag(value, fallback, name) {
  if (!defined(value)) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (TRUTHY.has(text)) return true;
  if (FALSY.has(text)) return false;
  throw new Error(name + " must be true or false.");
}

export function loopbackBindHost(value) {
  const host = defined(value) ? String(value).trim() : "127.0.0.1";
  if (host !== "127.0.0.1")
    throw new Error("The companion control page binds to 127.0.0.1 only.");
  return host;
}

const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks4:", "socks5:"]);

// Whitespace-only userinfo (e.g. %20) counts as no credential.
function decodePart(value, label) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(label + " has malformed credentials.");
  }
  return decoded.trim() ? decoded : "";
}

function envPart(value) {
  return defined(value) ? String(value) : "";
}

// WHATWG URL drops default ports (https:443, http:80) from url.port, so the
// explicit port is read from the raw authority instead.
function explicitPort(raw) {
  const start = raw.indexOf("://");
  if (start < 0) return "";
  const rest = raw.slice(start + 3);
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  let port;
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) return "";
    const after = hostPort.slice(close + 1);
    if (!after.startsWith(":")) return "";
    port = after.slice(1);
  } else {
    const colon = hostPort.lastIndexOf(":");
    if (colon < 0) return "";
    port = hostPort.slice(colon + 1);
  }
  return /^\d+$/.test(port) ? port : "";
}

const SOCKS_PROTOCOLS = new Set(["socks4:", "socks5:"]);

const BYPASS_ERROR =
  "JIJI_BROWSER_PROXY_BYPASS must be a comma-separated host list with no empty entries.";

// One proxy URL. `label` is "JIJI_BROWSER_PROXY" or "JIJI_BROWSER_PROXIES
// entry N" so errors name only the variable or entry index, never the value.
function parseProxy(raw, label, env, bypass) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(label + " must be a URL like https://host:port.");
  }
  if (
    !PROXY_PROTOCOLS.has(url.protocol) ||
    !url.hostname ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  )
    throw new Error(
      label +
        " must be an http, https, socks4 or socks5 URL with only a host and port.",
    );
  const portText = explicitPort(raw);
  if (!portText) throw new Error(label + " must include an explicit port.");
  const port = Number.parseInt(portText, 10);
  if (!(port >= 1 && port <= 65535))
    throw new Error(label + " port must be an integer from 1 to 65535.");
  const urlUsername = decodePart(url.username, label);
  const urlPassword = decodePart(url.password, label);
  const envUsername = envPart(env.JIJI_BROWSER_PROXY_USERNAME);
  const envPassword = envPart(env.JIJI_BROWSER_PROXY_PASSWORD);
  const urlHasCredentials = Boolean(urlUsername || urlPassword);
  const envHasCredentials = Boolean(envUsername || envPassword);
  if (urlHasCredentials && envHasCredentials)
    throw new Error(
      label +
        " credentials must come from the URL or from JIJI_BROWSER_PROXY_USERNAME/PASSWORD, not both.",
    );
  const username = envHasCredentials ? envUsername : urlUsername;
  const password = envHasCredentials ? envPassword : urlPassword;
  if (Boolean(username) !== Boolean(password))
    throw new Error(
      label + " username and password must both be set or both be empty.",
    );
  if (SOCKS_PROTOCOLS.has(url.protocol) && username)
    throw new Error(label + " socks proxies do not support credentials.");
  const host =
    url.hostname.includes(":") && !url.hostname.startsWith("[")
      ? "[" + url.hostname + "]"
      : url.hostname;
  const proxy = {
    server: url.protocol + "//" + host + ":" + port,
  };
  if (username) {
    proxy.username = username;
    proxy.password = password;
  }
  if (bypass) proxy.bypass = bypass;
  // host:port only, safe for status; never carries credentials.
  Object.defineProperty(proxy, "display", { value: host + ":" + port });
  return proxy;
}

// Browser egress only; the relay connection, photo downloads and push fetches
// do not use these proxies. JIJI_BROWSER_PROXY is a one-entry alias for
// JIJI_BROWSER_PROXIES (comma- or newline-separated, tried in order). Shared
// JIJI_BROWSER_PROXY_USERNAME / JIJI_BROWSER_PROXY_PASSWORD apply to entries
// without URL userinfo; an entry with userinfo plus shared credentials is
// refused. Every entry is validated up front. Errors are fixed strings and
// never echo a value, which may carry credentials.
export function browserProxyList(env = {}) {
  const hasSingle = defined(env.JIJI_BROWSER_PROXY);
  const hasList = defined(env.JIJI_BROWSER_PROXIES);
  if (hasSingle && hasList)
    throw new Error(
      "JIJI_BROWSER_PROXY and JIJI_BROWSER_PROXIES cannot both be set.",
    );
  if (!hasSingle && !hasList) {
    if (defined(env.JIJI_BROWSER_PROXY_BYPASS))
      throw new Error(
        "JIJI_BROWSER_PROXY_BYPASS requires JIJI_BROWSER_PROXY or JIJI_BROWSER_PROXIES.",
      );
    return [];
  }
  let bypass;
  if (defined(env.JIJI_BROWSER_PROXY_BYPASS)) {
    const hosts = String(env.JIJI_BROWSER_PROXY_BYPASS)
      .split(",")
      .map((entry) => entry.trim());
    if (hosts.some((entry) => !entry)) throw new Error(BYPASS_ERROR);
    bypass = hosts.join(",");
  }
  if (hasSingle)
    return [
      parseProxy(
        String(env.JIJI_BROWSER_PROXY).trim(),
        "JIJI_BROWSER_PROXY",
        env,
        bypass,
      ),
    ];
  // A comma may be followed by a line break; ",," or a trailing comma is an
  // empty entry.
  const entries = String(env.JIJI_BROWSER_PROXIES)
    .trim()
    .split(/\s*(?:,|\r?\n)\s*/);
  if (entries.some((entry) => !entry))
    throw new Error(
      "JIJI_BROWSER_PROXIES must be a comma- or newline-separated URL list with no empty entries.",
    );
  if (entries.length > 16)
    throw new Error("JIJI_BROWSER_PROXIES supports at most 16 entries.");
  return entries.map((raw, index) =>
    parseProxy(raw, "JIJI_BROWSER_PROXIES entry " + (index + 1), env, bypass),
  );
}

// First configured proxy, or undefined for direct egress.
export function browserProxy(env = {}) {
  return browserProxyList(env)[0];
}

// Mac stays on headed Google Chrome. The Linux image sets a system Chromium path.
// `proxy` overrides the env-derived first entry so the driver can try each
// entry of an already-parsed list; null forces direct egress.
export function browserLaunchOptions(env = {}, proxy) {
  const headless = flag(env.JIJI_HEADLESS, false, "JIJI_HEADLESS");
  const noSandbox = flag(
    env.JIJI_CHROMIUM_NO_SANDBOX,
    false,
    "JIJI_CHROMIUM_NO_SANDBOX",
  );
  const options = {
    headless,
    viewport: headless ? { width: 1280, height: 800 } : null,
  };
  const args = [];
  if (headless) args.push("--disable-dev-shm-usage");
  if (noSandbox) args.push("--no-sandbox", "--disable-setuid-sandbox");
  if (args.length) options.args = args;
  if (defined(env.JIJI_CHROMIUM_PATH))
    options.executablePath = env.JIJI_CHROMIUM_PATH;
  else if (env.JIJI_BROWSER_CHANNEL !== "")
    options.channel = defined(env.JIJI_BROWSER_CHANNEL)
      ? env.JIJI_BROWSER_CHANNEL
      : "chrome";
  if (proxy === undefined) proxy = browserProxy(env);
  if (proxy) {
    const { server, username, password, bypass } = proxy;
    options.proxy = { server };
    if (username) {
      options.proxy.username = username;
      options.proxy.password = password;
    }
    if (bypass) options.proxy.bypass = bypass;
  }
  return options;
}

// Values an error may echo from proxy config: shared credentials and URL
// userinfo, raw and decoded. `source` is a parsed proxy list or an env object;
// env values are read leniently because this runs on error paths.
function proxySecrets(source) {
  const secrets = new Set();
  const add = (value) => {
    if (!defined(value)) return;
    const text = String(value);
    secrets.add(text);
    try {
      secrets.add(decodeURIComponent(text));
    } catch {}
    secrets.add(encodeURIComponent(text));
  };
  if (Array.isArray(source))
    for (const proxy of source) {
      add(proxy?.username);
      add(proxy?.password);
    }
  else if (source && typeof source === "object") {
    add(source.JIJI_BROWSER_PROXY_USERNAME);
    add(source.JIJI_BROWSER_PROXY_PASSWORD);
    for (const raw of [source.JIJI_BROWSER_PROXY, source.JIJI_BROWSER_PROXIES])
      for (const entry of defined(raw) ? String(raw).split(/[,\s]+/) : [])
        try {
          const url = new URL(entry);
          add(url.username);
          add(url.password);
        } catch {}
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi;

// Strips URL userinfo and any configured proxy username/password from a
// string, or from every string inside an array or plain object.
export function scrubProxySecrets(value, ...sources) {
  const secrets = sources.flatMap(proxySecrets);
  const scrub = (item) => {
    if (typeof item === "string") {
      let text = item.replace(URL_USERINFO, "$1");
      for (const secret of secrets)
        text = text.split(secret).join("[redacted]");
      return text;
    }
    if (Array.isArray(item)) return item.map(scrub);
    if (item && Object.getPrototypeOf(item) === Object.prototype)
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [key, scrub(entry)]),
      );
    return item;
  };
  return scrub(value);
}
