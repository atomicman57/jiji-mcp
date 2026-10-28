#!/usr/bin/env node
// Creates the one-time VNC password file. The password is never passed on argv.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VNC_PASSWORD_PATTERN = /^[A-Za-z0-9_-]{8}$/;

export function createVncPassword() {
  return randomBytes(6).toString("base64url").slice(0, 8);
}

export function writeVncPassword(file) {
  const password = createVncPassword();
  if (!VNC_PASSWORD_PATTERN.test(password))
    throw new Error("Generated VNC password is not 8 safe characters.");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, password + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return password;
}

export function removeVncPassword(file) {
  fs.rmSync(file, { force: true });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, file] = process.argv.slice(2);
  if (!file || (command !== "create" && command !== "remove")) {
    console.error("Usage: jiji-vnc-password create|remove FILE");
    process.exit(1);
  }
  if (command === "create") writeVncPassword(file);
  else removeVncPassword(file);
}
