import { validatePath } from "./protocol.js";
let port;
let remoteURL = "";
let remoteToken = "";
let cloudConnected = false;
let polling = false;
let generation = 0;
let pairingCode = "";
let cloudAbort;
let state = {
  connected: false,
  message: "Connect the bridge to make Jiji available to your agents.",
};
let chain = Promise.resolve();
let lastRequest = 0;
function connect() {
  if (port) return;
  state = { connected: false, message: "Connecting…" };
  port = chrome.runtime.connectNative("com.jiji_mcp.bridge");
  port.onMessage.addListener((m) => {
    chain = chain
      .then(async () => port?.postMessage({ id: m.id, ...(await handle(m)) }))
      .catch(() => {});
  });
  port.onDisconnect.addListener(() => {
    state = {
      connected: false,
      message:
        chrome.runtime.lastError?.message ||
        "Disconnected. Choose Connect to retry.",
    };
    port = null;
    generation++;
    cloudAbort?.abort();
    polling = false;
    cloudConnected = false;
    if (remoteURL) void remote("/bridge/disconnect").catch(() => {});
  });
  // A status round trip confirms the native process can receive requests.
  state = {
    connected: true,
    message: "Bridge connected. Keep a Jiji tab open and sign in there.",
  };
  void startCloud();
}
async function handle(m) {
  try {
    let result;
    if (m.action === "login") {
      await chrome.tabs.create({ url: "https://jiji.ng/login.html" });
      result = {
        opened: true,
        message:
          "Complete sign-in on Jiji. Passwords and verification codes stay in the browser.",
      };
    } else {
      const tabs = await chrome.tabs.query({ url: "https://jiji.ng/*" });
      const tab = tabs.find((t) => t.active) || tabs[0];
      if (m.action === "status")
        result = {
          connected: true,
          jiji_tab_open: Boolean(tab),
          message: tab
            ? "Jiji is open. Authentication is managed by Jiji; search may also work while signed out."
            : "Open Jiji and sign in to use your session.",
        };
      else if (m.action === "fetch") {
        if (!tab)
          throw new Error("Open https://jiji.ng in Chrome and sign in first.");
        const u = new URL(validatePath(m.path), "https://jiji.ng");
        if (
          u.origin !== "https://jiji.ng" ||
          !(
            /^\/api_web\/v1\/listing$/.test(u.pathname) ||
            /^\/api_web\/v1\/item\/[A-Za-z0-9]{8,64}$/.test(u.pathname)
          )
        )
          throw new Error("Endpoint rejected.");
        const delay = Math.max(0, 1200 - (Date.now() - lastRequest));
        if (delay) await new Promise((r) => setTimeout(r, delay));
        lastRequest = Date.now();
        const [out] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: async (path) => {
            if (location.origin !== "https://jiji.ng")
              return { error: "Jiji tab navigated away. Reopen Jiji." };
            try {
              const r = await fetch(path, {
                credentials: "include",
                headers: { "X-Requested-With": "XMLHttpRequest" },
                signal: AbortSignal.timeout(20000),
                redirect: "error",
              });
              if (r.status !== 200) return { status: r.status };
              if (!r.headers.get("content-type")?.includes("application/json"))
                return {
                  error:
                    "Jiji returned a challenge or HTML page. Open the Jiji tab to continue.",
                };
              const text = await r.text();
              if (text.length > 6 * 1024 * 1024)
                return { error: "Jiji response exceeded the size limit." };
              const raw = JSON.parse(text);
              const cleanAd = (a) =>
                Object.fromEntries(
                  [
                    "guid",
                    "id",
                    "title",
                    "url",
                    "status",
                    "price_obj",
                    "price_title",
                    "region_item_text",
                    "region_text",
                    "region_name",
                    "region",
                    "description",
                    "short_description",
                    "details",
                    "attrs",
                    "labels",
                    "paid_info",
                    "user_id",
                  ]
                    .filter((k) => a[k] !== undefined)
                    .map((k) => [k, a[k]])
                    .concat([
                      [
                        "images",
                        (a.images || [])
                          .slice(0, 12)
                          .map((i) =>
                            typeof i === "string" ? i : { url: i.url },
                          ),
                      ],
                    ]),
                );
              let body;
              if (raw.adverts_list)
                body = {
                  adverts_list: {
                    count: raw.adverts_list.count,
                    adverts: Array.isArray(raw.adverts_list.adverts)
                      ? raw.adverts_list.adverts.map(cleanAd)
                      : null,
                  },
                  next_url: raw.next_url,
                };
              else if (raw.advert)
                body = {
                  advert: cleanAd(raw.advert),
                  seller: Object.fromEntries(
                    [
                      "id",
                      "name",
                      "user_response_time",
                      "feedback_count",
                      "labels",
                    ]
                      .filter((k) => raw.seller?.[k] !== undefined)
                      .map((k) => [k, raw.seller[k]]),
                  ),
                };
              else return { error: "Jiji response format changed." };
              return { status: r.status, body };
            } catch {
              return {
                error:
                  "Jiji request failed. Check the Jiji tab; no retry was attempted.",
              };
            }
          },
          args: [u.pathname + u.search],
        });
        result = out?.result;
        if (!result) throw new Error("No response from the Jiji tab.");
      } else throw new Error("Unsupported bridge action.");
    }
    return result;
  } catch (e) {
    return { error: e.message };
  }
}
async function remote(
  path,
  body = {},
  config = { url: remoteURL, token: remoteToken },
  signal,
) {
  const r = await fetch(config.url + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + config.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error("Cloud bridge returned HTTP " + r.status);
  return r.json();
}
async function startCloud() {
  if (polling) return;
  const savedConfig = await chrome.storage.local.get([
    "remoteURL",
    "remoteToken",
  ]);
  remoteURL = savedConfig.remoteURL || "";
  remoteToken = savedConfig.remoteToken || "";
  if (!remoteURL || !remoteToken) return;
  polling = true;
  const run = ++generation;
  const config = { url: remoteURL, token: remoteToken };
  cloudAbort = new AbortController();
  const signal = cloudAbort.signal;
  try {
    while (port && run === generation) {
      const data = await remote("/bridge/poll", {}, config, signal);
      if (run !== generation) break;
      cloudConnected = true;
      for (const job of data.jobs || []) {
        if (run !== generation) break;
        if (job.action !== "fetch") continue;
        validatePath(job.path);
        const result = await (chain = chain.then(() =>
          run === generation ? handle(job) : { error: "Disconnected" },
        ));
        if (run === generation)
          await remote(
            "/bridge/result",
            { id: job.id, ...result },
            config,
            signal,
          );
      }
    }
  } catch {
    if (run === generation) {
      cloudConnected = false;
      state.message =
        "Cloud connection stopped. Check the server URL and reconnect to retry.";
    }
  } finally {
    if (run === generation) polling = false;
  }
}
async function configure(url) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    u.username ||
    u.password
  )
    throw new Error("Use an HTTPS server origin, without a path.");
  if (!(await chrome.permissions.contains({ origins: [u.origin + "/*"] })))
    throw new Error("Server permission was not granted.");
  generation++;
  cloudAbort?.abort();
  if (remoteURL) await remote("/bridge/disconnect").catch(() => {});
  cloudConnected = false;
  pairingCode = "";
  const saved = await chrome.storage.local.get(["remoteToken", "remoteURL"]);
  remoteToken =
    saved.remoteURL === u.origin && saved.remoteToken
      ? saved.remoteToken
      : [...crypto.getRandomValues(new Uint8Array(32))]
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");
  remoteURL = u.origin;
  await chrome.storage.local.set({ remoteURL, remoteToken });
  polling = false;
  void startCloud();
}
chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    if (m.action === "connect") connect();
    if (m.action === "configure") await configure(m.url);
    if (m.action === "pair") {
      if (!remoteURL) throw new Error("Set a cloud server URL first.");
      pairingCode = (await remote("/bridge/pair")).code;
    }
    if (m.action === "disconnect") {
      generation++;
      cloudAbort?.abort();
      polling = false;
      if (remoteURL) await remote("/bridge/disconnect").catch(() => {});
      port?.disconnect();
      port = null;
      cloudConnected = false;
      pairingCode = "";
      state = {
        connected: false,
        message: "Disconnected. Agents cannot use the Jiji browser bridge.",
      };
    }
    respond({ ...state, cloudConnected, remoteURL, pairingCode });
  })().catch((e) => respond({ ...state, error: e.message }));
  return true;
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
