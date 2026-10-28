export const COMPANION_REPLACED_CODE = 4001;
export const COMPANION_REPLACED_REASON = "Companion replaced";

// One installation has one live companion socket. A new connection closes the rest.
export function closeReplacedCompanions(sockets) {
  const open = [...sockets];
  for (const socket of open)
    socket.close(COMPANION_REPLACED_CODE, COMPANION_REPLACED_REASON);
  return open.length;
}
