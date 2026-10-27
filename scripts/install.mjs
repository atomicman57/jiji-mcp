import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtime = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Jiji MCP",
);
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
fs.chmodSync(runtime, 0o700);
const configPath = path.join(runtime, "config.json");
if (!fs.existsSync(configPath))
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        cloudOrigin: "https://jiji-browser-mcp.felicity-blessing.workers.dev",
        cloudEnabled: false,
        enabled: true,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
console.log(
  JSON.stringify(
    {
      companion_command: [
        process.execPath,
        path.join(root, "src/companion.mjs"),
      ],
      control_page: "http://127.0.0.1:38473",
      extension_required: false,
      mcp: {
        command: process.execPath,
        args: [path.join(root, "src/server.mjs")],
      },
      cloud_setup: "Set credentialHelper and cloudEnabled in " + configPath,
    },
    null,
    2,
  ),
);
