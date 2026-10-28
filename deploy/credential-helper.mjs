#!/usr/bin/env node
// Relay identity only. This file must never hold Jiji cookies or a browser profile.
import fs from "node:fs";
import path from "node:path";

const file = process.env.JIJI_IDENTITY_FILE;
const [command, ...rest] = process.argv.slice(2);
if (!file || !command) {
  console.error("JIJI_IDENTITY_FILE and a helper command are required.");
  process.exit(1);
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

if (command === "list-documents") {
  const prefixFlag = rest.indexOf("--prefix");
  const prefix = prefixFlag === -1 ? "" : rest[prefixFlag + 1] || "";
  process.stdout.write(
    JSON.stringify(Object.keys(load()).filter((name) => name.startsWith(prefix))),
  );
} else if (command === "get-document") {
  process.stdout.write(JSON.stringify(load()[rest[0]] ?? {}));
} else if (command === "put-document") {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const data = load();
    data[rest[0]] = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    save(data);
  });
} else {
  console.error("Unknown credential helper command.");
  process.exit(1);
}
