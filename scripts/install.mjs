import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, generateKeyPairSync } from "node:crypto";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.join(root, "extension", "manifest.json");
let key;
if (fs.existsSync(manifestPath))
  key = JSON.parse(fs.readFileSync(manifestPath)).key;
if (!key)
  key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64");
const id = [
  ...createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest()
    .subarray(0, 16),
]
  .map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15)))
  .join("");
const manifest = {
  manifest_version: 3,
  name: "Jiji MCP Browser Bridge",
  version: "0.1.0",
  description:
    "Use your Jiji browser session with your MCP agents. No cookie export.",
  key,
  permissions: ["nativeMessaging", "scripting", "storage"],
  host_permissions: ["https://jiji.ng/*"],
  optional_host_permissions: ["https://*/*"],
  background: { service_worker: "background.js", type: "module" },
  action: { default_popup: "popup.html", default_title: "Jiji MCP" },
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
fs.copyFileSync(
  path.join(root, "src/protocol.mjs"),
  path.join(root, "extension/protocol.js"),
);
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const wrapper = path.join(root, "scripts", "native-host.sh");
fs.writeFileSync(
  wrapper,
  `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, "src/native-host.mjs"))} "$@"\n`,
  { mode: 0o755 },
);
fs.chmodSync(wrapper, 0o755);
const hostDir = path.join(
  os.homedir(),
  "Library/Application Support/Google/Chrome/NativeMessagingHosts",
);
fs.mkdirSync(hostDir, { recursive: true });
fs.writeFileSync(
  path.join(hostDir, "com.jiji_mcp.bridge.json"),
  JSON.stringify(
    {
      name: "com.jiji_mcp.bridge",
      description: "Jiji MCP local browser bridge",
      path: wrapper,
      type: "stdio",
      allowed_origins: [`chrome-extension://${id}/`],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    {
      extension_id: id,
      extension_directory: path.join(root, "extension"),
      mcp: {
        command: process.execPath,
        args: [path.join(root, "src/server.mjs")],
      },
      next: "Load unpacked in chrome://extensions, then open the extension and choose Connect.",
    },
    null,
    2,
  ),
);
