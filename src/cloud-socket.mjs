import WebSocket from "ws";

// The identity is sent only in the upgrade header, never in a URL or log.
export function runCloudSession({
  origin,
  identity,
  signal,
  action,
  onConnected,
  endpoint,
  heartbeatMs = 30000,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const url =
      endpoint || origin.replace(/^https:/, "wss:") + "/bridge/socket";
    const ws = new WebSocket(url, {
      headers: { Authorization: "Bearer " + identity },
      followRedirects: false,
      handshakeTimeout: 20000,
      maxPayload: 7 * 1024 * 1024,
    });
    let ready = false,
      alive = true,
      finished = false,
      queue = Promise.resolve(),
      heartbeat;
    const seen = new Set();
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      ws.terminate();
      finish();
    };
    signal?.addEventListener("abort", abort, { once: true });
    ws.on("open", () => {
      heartbeat = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping(); // Protocol ping/pong does not wake the hibernating Object.
      }, heartbeatMs);
      heartbeat.unref?.();
    });
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        ws.close(1008, "Invalid message");
        return;
      }
      if (message.type === "ready" && message.protocol === 1) {
        ready = true;
        onConnected?.();
        return;
      }
      if (
        !ready ||
        message.type !== "job" ||
        !message.job ||
        typeof message.job.id !== "string"
      ) {
        ws.close(1008, "Invalid job");
        return;
      }
      const job = message.job;
      if (seen.has(job.id)) return;
      seen.add(job.id);
      if (seen.size > 256) seen.delete(seen.values().next().value);
      queue = queue
        .then(async () => {
          if (finished || signal?.aborted) return;
          let result;
          try {
            result = await action(job.request || job);
          } catch (error) {
            result = { error: String(error.message).slice(0, 500) };
          }
          // A lost response is never resent and the operation is never rerun.
          if (
            !finished &&
            !signal?.aborted &&
            ws.readyState === WebSocket.OPEN
          ) {
            const response = JSON.stringify({
              type: "result",
              id: job.id,
              result,
            });
            if (Buffer.byteLength(response) > 7 * 1024 * 1024)
              ws.send(
                JSON.stringify({
                  type: "result",
                  id: job.id,
                  result: { error: "Browser response too large" },
                }),
              );
            else ws.send(response);
          }
        })
        .catch(() => {
          ws.close(1011, "Response delivery failed");
        });
    });
    ws.on("error", () => {
      ws.terminate();
      finish(new Error("Cloud WebSocket connection failed."));
    });
    ws.on("close", (code) => {
      if (signal?.aborted) {
        finish();
        return;
      }
      const error = new Error(
        code === 4001
          ? "Another companion replaced this connection."
          : "Cloud WebSocket disconnected.",
      );
      if (code === 4001) error.code = "COMPANION_REPLACED";
      finish(error);
    });
  });
}
