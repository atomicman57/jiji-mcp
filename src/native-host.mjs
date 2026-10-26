import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { socketPath } from "./bridge.mjs";
import { validatePath } from "./protocol.mjs";
const dir = path.dirname(socketPath);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.chmodSync(dir, 0o700);
// Do not replace a live bridge when another Chrome profile tries to connect.
if (fs.existsSync(socketPath)) {
  const alive = await new Promise((resolve) => {
    const c = net.createConnection(socketPath);
    c.on("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.on("error", () => resolve(false));
  });
  if (alive) process.exit(1);
  fs.unlinkSync(socketPath);
}
const pending = new Map();
let buffer = Buffer.alloc(0);
const send = (message) => {
  const data = Buffer.from(JSON.stringify(message));
  if (data.length > 1024 * 1024) throw new Error("Native message too large.");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  process.stdout.write(Buffer.concat([size, data]));
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const n = buffer.readUInt32LE();
    if (n > 8 * 1024 * 1024) process.exit(1);
    if (buffer.length < n + 4) break;
    let m;
    try {
      m = JSON.parse(buffer.subarray(4, n + 4).toString());
    } catch {
      process.exit(1);
    }
    buffer = buffer.subarray(n + 4);
    const p = pending.get(m.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(m.id);
      p.socket.end(JSON.stringify(m) + "\n");
    }
  }
});
const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  let raw = "";
  socket.setTimeout(35000, () => socket.destroy());
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 10000) socket.destroy();
  });
  socket.on("end", () => {
    if (!raw) return socket.end();
    try {
      const m = JSON.parse(raw);
      if (!["status", "login", "fetch"].includes(m.action))
        throw new Error("Unsupported action.");
      if (m.action === "fetch") m.path = validatePath(m.path);
      if (pending.size >= 20) throw new Error("Bridge is busy.");
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        socket.end(JSON.stringify({ error: "Jiji browser timed out." }));
      }, 30000);
      pending.set(id, { socket, timer });
      send({ id, action: m.action, path: m.path });
    } catch (e) {
      socket.end(JSON.stringify({ error: e.message }) + "\n");
    }
  });
});
server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
const close = () => {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.socket.destroy();
  }
  server.close();
  try {
    fs.unlinkSync(socketPath);
  } catch {}
  process.exit();
};
process.stdin.on("end", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
