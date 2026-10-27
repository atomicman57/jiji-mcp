for (const form of document.forms)
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    document.querySelector("#result").textContent = "Working…";
    try {
      const r = await fetch(form.action, {
        method: "POST",
        body: new URLSearchParams(new FormData(form)),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Request failed.");
      if (data.code)
        document.querySelector("#pairing").textContent = data.code
          .match(/.{1,4}/g)
          .join("-");
      document.querySelector("#result").textContent =
        data.message ||
        data.result?.message ||
        (data.state
          ? "Action status: " + data.state
          : data.opened
            ? "Jiji is open. Complete sign-in there."
            : data.code
              ? "Pairing code expires in ten minutes."
              : "Connection updated.");
    } catch (e) {
      document.querySelector("#result").textContent = e.message;
    } finally {
      button.disabled = false;
    }
  });
async function status() {
  const node = document.querySelector("#status");
  if (!node) return;
  try {
    const r = await fetch("/api/status");
    const s = await r.json();
    node.textContent =
      (s.signed_in
        ? "Jiji account connected"
        : s.browser_open
          ? "Jiji browser open — complete sign-in"
          : "Ready — open Jiji to sign in") +
      (s.cloud_connected
        ? " · Cloud relay connected"
        : s.cloud_error
          ? " · " + s.cloud_error
          : "");
  } catch {
    node.textContent = "Companion is unavailable.";
  }
}
status();
setInterval(status, 5000);
