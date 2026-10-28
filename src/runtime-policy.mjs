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
  return options;
}
