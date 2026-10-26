import net from "node:net";
import os from "node:os";
import path from "node:path";
export const socketPath =
  process.env.JIJI_MCP_SOCKET ||
  path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Jiji MCP",
    "bridge.sock",
  );
export function bridgeRequest(message, socket = socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let buffer = "";
    const fail = (e) => {
      client.destroy();
      reject(e);
    };
    client.setTimeout(35000, () =>
      fail(
        new Error(
          "Jiji browser request timed out. Open Jiji and check the bridge.",
        ),
      ),
    );
    client.on("error", () =>
      fail(
        new Error(
          "Jiji bridge is disconnected. Open the Jiji MCP extension in Chrome and choose Connect.",
        ),
      ),
    );
    client.on("connect", () => client.end(JSON.stringify(message) + "\n"));
    client.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024)
        fail(new Error("Browser response too large."));
    });
    client.on("end", () => {
      try {
        const r = JSON.parse(buffer);
        r.error ? reject(new Error(r.error)) : resolve(r);
      } catch (e) {
        reject(e);
      }
    });
  });
}
