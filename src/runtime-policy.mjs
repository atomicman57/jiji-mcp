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

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("JIJI_BROWSER_PROXY has malformed credentials.");
  }
}

const SOCKS_PROTOCOLS = new Set(["socks4:", "socks5:"]);

// Browser egress only; the relay connection, photo downloads and push fetches
// do not use this proxy. Credentials come from exactly one source: the URL
// userinfo or JIJI_BROWSER_PROXY_USERNAME / JIJI_BROWSER_PROXY_PASSWORD.
// Errors are fixed strings and never echo the value, which may carry credentials.
export function browserProxy(env = {}) {
  if (!defined(env.JIJI_BROWSER_PROXY)) return undefined;
  let url;
  try {
    url = new URL(String(env.JIJI_BROWSER_PROXY).trim());
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
  if (!url.port)
    throw new Error("JIJI_BROWSER_PROXY must include an explicit port.");
  const urlHasCredentials = Boolean(url.username || url.password);
  const envHasCredentials =
    defined(env.JIJI_BROWSER_PROXY_USERNAME) ||
    defined(env.JIJI_BROWSER_PROXY_PASSWORD);
  if (urlHasCredentials && envHasCredentials)
    throw new Error(
      "JIJI_BROWSER_PROXY credentials must come from the URL or from JIJI_BROWSER_PROXY_USERNAME/PASSWORD, not both.",
    );
  const username = envHasCredentials
    ? defined(env.JIJI_BROWSER_PROXY_USERNAME)
      ? String(env.JIJI_BROWSER_PROXY_USERNAME)
      : ""
    : decodePart(url.username);
  const password = envHasCredentials
    ? defined(env.JIJI_BROWSER_PROXY_PASSWORD)
      ? String(env.JIJI_BROWSER_PROXY_PASSWORD)
      : ""
    : decodePart(url.password);
  if (Boolean(username) !== Boolean(password))
    throw new Error(
      "JIJI_BROWSER_PROXY username and password must both be set or both be empty.",
    );
  if (SOCKS_PROTOCOLS.has(url.protocol) && username)
    throw new Error(
      "JIJI_BROWSER_PROXY socks proxies do not support credentials.",
    );
  const proxy = { server: url.protocol + "//" + url.host };
  if (username) {
    proxy.username = username;
    proxy.password = password;
  }
  if (defined(env.JIJI_BROWSER_PROXY_BYPASS))
    proxy.bypass = String(env.JIJI_BROWSER_PROXY_BYPASS).trim();
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
