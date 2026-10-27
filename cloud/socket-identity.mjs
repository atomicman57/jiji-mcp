// A serialized ID survives hibernation and new JS wrappers for the same socket.
export function socketConnectionId(ws) {
  const attachment = ws.deserializeAttachment() || { protocol: 1 };
  if (!attachment.connectionId) {
    attachment.connectionId = crypto.randomUUID();
    ws.serializeAttachment(attachment);
  }
  return attachment.connectionId;
}
export function matchesSocket(connectionId, ws) {
  return connectionId === socketConnectionId(ws);
}
