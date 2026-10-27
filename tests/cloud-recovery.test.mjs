import { test } from "node:test";
import assert from "node:assert/strict";
import {
  socketConnectionId,
  matchesSocket,
} from "../cloud/socket-identity.mjs";
function connection(initial = { protocol: 1 }) {
  let attachment = initial,
    writes = 0;
  return {
    wrapper: () => ({
      deserializeAttachment: () => structuredClone(attachment),
      serializeAttachment: (value) => {
        attachment = structuredClone(value);
        writes++;
      },
    }),
    writes: () => writes,
  };
}
test("serialized correlation survives new JS wrappers and rejects another connection", () => {
  const a = connection(),
    b = connection();
  const first = a.wrapper(),
    restored = a.wrapper();
  assert.notEqual(first, restored);
  const id = socketConnectionId(first);
  assert.equal(socketConnectionId(restored), id);
  assert.equal(matchesSocket(id, restored), true);
  assert.equal(matchesSocket(id, b.wrapper()), false);
  assert.equal(a.writes(), 1);
});
test("already-attached connection IDs are reused without changing or rewriting them", () => {
  const a = connection({ protocol: 1, connectionId: "existing-stable-id" });
  assert.equal(socketConnectionId(a.wrapper()), "existing-stable-id");
  assert.equal(matchesSocket("another-id", a.wrapper()), false);
  assert.equal(a.writes(), 0);
});
