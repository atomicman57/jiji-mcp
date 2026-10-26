import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bridgeRequest } from "../src/bridge.mjs";
test("native messaging host routes framed requests through a private socket", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jiji-test-"));
  const socket = path.join(dir, "bridge.sock");
  const host = spawn(
    process.execPath,
    [new URL("../src/native-host.mjs", import.meta.url).pathname],
    {
      env: { ...process.env, JIJI_MCP_SOCKET: socket },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setInterval(async () => {
        try {
          await stat(socket);
          clearInterval(timer);
          resolve();
        } catch {}
      }, 10);
      host.once("exit", () => {
        clearInterval(timer);
        reject(new Error("Host exited before opening socket."));
      });
    });
    assert.equal((await stat(socket)).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    const request = bridgeRequest({ action: "status" }, socket);
    const frame = await new Promise((resolve) => {
      let b = Buffer.alloc(0);
      host.stdout.on("data", (chunk) => {
        b = Buffer.concat([b, chunk]);
        if (b.length >= 4 && b.length >= 4 + b.readUInt32LE())
          resolve(JSON.parse(b.subarray(4, 4 + b.readUInt32LE()).toString()));
      });
    });
    assert.equal(frame.action, "status");
    const reply = Buffer.from(
      JSON.stringify({ id: frame.id, connected: true }),
    );
    const size = Buffer.alloc(4);
    size.writeUInt32LE(reply.length);
    host.stdin.write(Buffer.concat([size, reply]));
    assert.equal((await request).connected, true);
    const reject = await bridgeRequest(
      { action: "fetch", path: "/api_web/v1/adabcdefgh_phone.json" },
      socket,
    ).catch((e) => e);
    assert.match(reject.message, /Only Jiji/);
  } finally {
    clearInterval(timer);
    host.stdin.end();
    await new Promise((resolve) => host.once("exit", resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
