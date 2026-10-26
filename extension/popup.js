async function update(action = "status", args = {}) {
  const state = await chrome.runtime.sendMessage({ action, ...args });
  document.querySelector("#label").textContent = state.connected
    ? "Connected"
    : "Disconnected";
  document.querySelector("#status").textContent = state.error || state.message;
  document.querySelector("#connect").disabled = state.connected;
  document.querySelector("#disconnect").disabled = !state.connected;
  document.querySelector("#cloud").textContent = state.cloudConnected
    ? "Cloud bridge connected"
    : state.remoteURL
      ? "Cloud bridge waiting"
      : "Optional: for agents that connect over HTTPS.";
  document.querySelector("#code").textContent = state.pairingCode || "";
  if (
    document.activeElement !== document.querySelector("#server") &&
    state.remoteURL
  )
    document.querySelector("#server").value = state.remoteURL;
}
document.querySelector("#save").onclick = async () => {
  try {
    const u = new URL(document.querySelector("#server").value);
    if (u.protocol !== "https:") throw new Error("Use HTTPS.");
    if (!(await chrome.permissions.request({ origins: [u.origin + "/*"] })))
      throw new Error("Server permission was not granted.");
    await update("configure", { url: u.origin });
  } catch (e) {
    document.querySelector("#status").textContent = e.message;
  }
};
document.querySelector("#pair").onclick = () => update("pair");
document.querySelector("#connect").onclick = () => update("connect");
document.querySelector("#disconnect").onclick = () => update("disconnect");
document.querySelector("#login").onclick = () =>
  chrome.tabs.create({ url: "https://jiji.ng/login.html" });
update();
setInterval(() => update(), 1500);
