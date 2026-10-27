import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
const exec = promisify(execFile);
export async function loadIdentity(helper, origin) {
  if (!helper)
    throw new Error(
      "Configure a credential helper before enabling the cloud relay. Local tools do not require it.",
    );
  const name = "jiji-mcp-companion";
  const names = JSON.parse(
    (await exec(helper, ["list-documents", "--prefix", name])).stdout,
  );
  let document = { identities: {} };
  if ((Array.isArray(names) ? names : Object.keys(names)).includes(name))
    document = JSON.parse((await exec(helper, ["get-document", name])).stdout);
  document.identities ??= {};
  if (!document.identities[origin]) {
    document.identities[origin] = randomBytes(32).toString("hex");
    await new Promise((resolve, reject) => {
      const child = spawn(helper, ["put-document", name], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                "Could not save bridge identity in the encrypted credential store.",
              ),
            ),
      );
      child.stdin.end(JSON.stringify(document));
    });
  }
  return document.identities[origin];
}
