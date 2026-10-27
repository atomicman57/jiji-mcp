import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { runCloudSession } from "../src/cloud-socket.mjs";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function server() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  return {
    wss,
    endpoint: `ws://127.0.0.1:${wss.address().port}/bridge/socket`,
    close: () =>
      new Promise((r) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(r);
      }),
  };
}
test("native socket authenticates in a header, deduplicates jobs, and pings without application heartbeat frames", async () => {
  const s = await server(),
    abort = new AbortController(),
    done = deferred(),
    ready = deferred();
  let calls = 0,
    pings = 0,
    messages = 0;
  s.wss.on("connection", (ws, req) => {
    assert.equal(req.headers.authorization, "Bearer synthetic");
    assert.equal(req.url, "/bridge/socket");
    ws.on("ping", () => {
      pings++;
    });
    ws.send(JSON.stringify({ type: "ready", protocol: 1 }));
    const job = {
      type: "job",
      job: { id: "unique-transport-id", request: { action: "status" } },
    };
    ws.send(JSON.stringify(job));
    ws.send(JSON.stringify(job));
    ws.on("message", (message) => {
      messages++;
      const reply = JSON.parse(message);
      assert.equal(reply.id, job.job.id);
      assert.equal(reply.result.connected, true);
      done.resolve();
    });
  });
  const running = runCloudSession({
    origin: "https://unused.test",
    endpoint: s.endpoint,
    identity: "synthetic",
    signal: abort.signal,
    heartbeatMs: 15,
    onConnected: ready.resolve,
    action: async () => {
      calls++;
      return { connected: true };
    },
  });
  try {
    await ready.promise;
    await done.promise;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls, 1);
    assert.equal(messages, 1);
    assert.ok(pings > 0);
    abort.abort();
    await running;
  } finally {
    abort.abort();
    await s.close();
  }
});
test("connection loss during an operation never replays it or resends its result", async () => {
  const s = await server(),
    abort = new AbortController(),
    started = deferred(),
    release = deferred();
  let calls = 0,
    results = 0,
    peer;
  s.wss.on("connection", (ws) => {
    peer = ws;
    ws.on("message", () => results++);
    ws.send(JSON.stringify({ type: "ready", protocol: 1 }));
    ws.send(
      JSON.stringify({
        type: "job",
        job: { id: "operation-once", request: { action: "prepare_message" } },
      }),
    );
  });
  const running = runCloudSession({
    origin: "https://unused.test",
    endpoint: s.endpoint,
    identity: "synthetic",
    signal: abort.signal,
    action: async () => {
      calls++;
      started.resolve();
      await release.promise;
      return { created: true };
    },
  });
  const failed = assert.rejects(running, /disconnected/);
  try {
    await started.promise;
    peer.close(1012, "Restart");
    await failed;
    release.resolve();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(calls, 1);
    assert.equal(results, 0);
  } finally {
    release.resolve();
    abort.abort();
    await s.close();
  }
});
