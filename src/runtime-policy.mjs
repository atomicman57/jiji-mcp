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
function decodePart(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("JIJI_BROWSER_PROXY has malformed credentials.");
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

// Browser egress only; the relay connection, photo downloads and push fetches
// do not use this proxy. Credentials come from exactly one source: the URL
// userinfo or JIJI_BROWSER_PROXY_USERNAME / JIJI_BROWSER_PROXY_PASSWORD.
// Errors are fixed strings and never echo the value, which may carry credentials.
export function browserProxy(env = {}) {
  const hasBypass = defined(env.JIJI_BROWSER_PROXY_BYPASS);
  if (!defined(env.JIJI_BROWSER_PROXY)) {
    if (hasBypass)
      throw new Error("JIJI_BROWSER_PROXY_BYPASS requires JIJI_BROWSER_PROXY.");
    return undefined;
  }
  const raw = String(env.JIJI_BROWSER_PROXY).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("JIJI_BROWSER_PROXY must be a URL like https://host:port.");
  }
  if (
    !PROXY_PROTOCOLS.has(url.protocol) ||
    !url.hostname ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  )
    throw new Error(
      "JIJI_BROWSER_PROXY must be an http, https, socks4 or socks5 URL with only a host and port.",
    );
  const portText = explicitPort(raw);
  if (!portText)
    throw new Error("JIJI_BROWSER_PROXY must include an explicit port.");
  const port = Number.parseInt(portText, 10);
  if (!(port >= 1 && port <= 65535))
    throw new Error(
      "JIJI_BROWSER_PROXY port must be an integer from 1 to 65535.",
    );
  const urlUsername = decodePart(url.username);
  const urlPassword = decodePart(url.password);
  const envUsername = envPart(env.JIJI_BROWSER_PROXY_USERNAME);
  const envPassword = envPart(env.JIJI_BROWSER_PROXY_PASSWORD);
  const urlHasCredentials = Boolean(urlUsername || urlPassword);
  const envHasCredentials = Boolean(envUsername || envPassword);
  if (urlHasCredentials && envHasCredentials)
    throw new Error(
      "JIJI_BROWSER_PROXY credentials must come from the URL or from JIJI_BROWSER_PROXY_USERNAME/PASSWORD, not both.",
    );
  const username = envHasCredentials ? envUsername : urlUsername;
  const password = envHasCredentials ? envPassword : urlPassword;
  if (Boolean(username) !== Boolean(password))
    throw new Error(
      "JIJI_BROWSER_PROXY username and password must both be set or both be empty.",
    );
  if (SOCKS_PROTOCOLS.has(url.protocol) && username)
    throw new Error(
      "JIJI_BROWSER_PROXY socks proxies do not support credentials.",
    );
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
  if (hasBypass) {
    const hosts = String(env.JIJI_BROWSER_PROXY_BYPASS)
      .split(",")
      .map((entry) => entry.trim());
    if (hosts.some((entry) => !entry)) throw new Error(BYPASS_ERROR);
    proxy.bypass = hosts.join(",");
  }
  return proxy;
}

// Mac stays on headed Google Chrome. The Linux image sets a system Chromium path.
export function browserLaunchOptions(env = {}) {
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
  const proxy = browserProxy(env);
  if (proxy) options.proxy = proxy;
  return options;
}
