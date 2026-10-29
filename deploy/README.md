# Linux companion

The Jiji companion runs on the owner's Linux server in a container. It dials out to the existing Cloudflare relay. No inbound tunnel and no public port are required.

The approve page stays on `127.0.0.1`. The container uses host networking so that address is the server's loopback, not an unreachable address inside a bridge network. With `JIJI_AUTO_APPROVE=true`, normal sends do not need that page. Account changes still do.

Sign-in is a separate unit the owner starts once. It shows headed Chromium through a VNC server bound to `127.0.0.1` only. The owner reaches it with an SSH local forward, signs in to Jiji himself, then stops the unit. The unit also exits after 30 minutes. Do not copy the Mac browser profile, cookies, or Application Support directory.

The steady service and the sign-in service conflict, so they cannot run together. The relay also keeps a single companion socket: a new connection closes the previous one with WebSocket close code `4001` and reason `Companion replaced`. Leave the Mac LaunchAgent disabled after cutover.

D1 binding `MCP_STORAGE` and Durable Object binding `BRIDGES` / `JijiBridge` are unchanged. Do not edit `wrangler.local.jsonc` for this move.

## Layout

| File | Role |
| --- | --- |
| `Dockerfile` | Non-root uid 950, system Chromium, read-only runtime |
| `deploy/jiji-mcp.service` | Headless companion. Restarts on failure. Enabled at boot after cutover |
| `deploy/jiji-mcp-signin.service` | One-time headed sign-in. No install target. Stops after 30 minutes |
| `deploy/entrypoint.sh` | Starts Xvfb and loopback `x11vnc` only when `JIJI_SIGNIN=1` |
| `deploy/init-data.sh` | Creates `/var/lib/jiji-mcp` as uid 950, mode `0700`, without touching a Mac profile |
| `deploy/credential-helper.mjs` | Stores the new relay identity in `/data/relay-identity.json`, mode `0600` |
| `deploy/env.example` | Template for the root-only env file |

The container is `--read-only`, `--cap-drop=ALL`, and `no-new-privileges`. Chromium's own sandbox cannot start with every capability dropped, so the image sets `JIJI_CHROMIUM_NO_SANDBOX=1`. The container boundary is the sandbox. The writable paths are the `/data` volume and a `/tmp` tmpfs.

## Cloudflare Browser Rendering

Cloudflare's browser product (Browser Rendering, documented as Browser Run) can launch Chromium from a Worker. It is a poor fit for this companion.

- Session persistence is an idle browser session, not a durable profile. The default idle timeout is 60 seconds. `keep_alive` extends that idle window to 20 minutes. There is no fixed maximum while the session stays active, but an always-on marketplace login would have to send commands forever. Cookies belong to that session; this repo's login is a persistent Chrome profile that survives restarts. See [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/) and [pricing](https://developers.cloudflare.com/browser-run/pricing/).
- Login still needs the owner to pass Jiji's own pages and challenges. This code has no cookie export and no Jiji refresh token. A Browser Run session would be a new browser on Cloudflare's fleet, not this profile.
- Anti-bot handling in this repo is to stop when Jiji returns HTML instead of JSON and let the owner finish the challenge in the real browser. Browser Run does not remove that. Its browsers are shared datacenter instances. Whether Jiji would challenge those IPs was not live-tested.
- Cost and limits, from the docs above as of October 2026: Workers Free allows 10 browser-minutes per day, 3 concurrent browsers, and one new instance every 20 seconds. Workers Paid includes 10 browser-hours per month and then `$0.09` per hour, plus 10 averaged concurrent browsers and then `$2` per extra browser. Paid accounts default to 200 concurrent browsers and 3 new instances per second. An always-on browser is hundreds of hours a month. The Linux host is already on.
- Text send in this repo types into the signed-in page. That matches a local persistent browser. It does not match a short-lived remote session.

The Linux companion keeps that persistent profile, the outbound relay socket, and the loopback approve page.

## Cutover

Run these on the machines named in each step. Do not copy `~/Library/Application Support/Jiji MCP`, its Chrome profile, or its cookies.

1. On the Mac, stop and disable LaunchAgent `com.blessingphilips.jiji-mcp`. Quit the companion process if it is still open.

   ```sh
   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.blessingphilips.jiji-mcp.plist
   launchctl disable gui/$(id -u)/com.blessingphilips.jiji-mcp
   ```

   `launchctl print gui/$(id -u)/com.blessingphilips.jiji-mcp` should fail. Leave it disabled. A later Mac start would take the relay socket away from Linux, or Linux would take it back.

2. On the Linux server, confirm uid 950 is free or is already the `jiji` user. Install Docker. Create the user and the root-only env file from `deploy/env.example`. Set `cloudOrigin` and `cloudEnabled` in the data `config.json` after the init script creates it. Use a new relay identity. Re-pair agents after the service is up.

   ```sh
   getent passwd 950 || true
   sudo groupadd --gid 950 jiji
   sudo useradd --system --uid 950 --gid 950 --home-dir /var/lib/jiji-mcp --shell /usr/sbin/nologin jiji
   sudo install -d -o root -g root -m 0700 /etc/jiji-mcp
   sudo install -o root -g root -m 0600 deploy/env.example /etc/jiji-mcp/env
   ```

3. On the Linux server, from this branch, build the image. This does not deploy the Worker.

   ```sh
   docker build -t jiji-mcp:local .
   ```

4. Install the units and the init script, then reload systemd. Do not enable the sign-in unit.

   ```sh
   sudo install -m 0755 deploy/init-data.sh /usr/local/sbin/jiji-mcp-init-data
   sudo install -m 0644 deploy/jiji-mcp.service deploy/jiji-mcp-signin.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```

5. Start the sign-in unit. It writes a one-time VNC password to `/var/lib/jiji-mcp/vnc-password` (mode `0600`, uid 950). The password is not printed in the journal. Read it on the server, forward only loopback port 5900, and sign in to Jiji yourself. Then stop the unit. Stopping deletes the password file. Nothing here copies a profile.

   ```sh
   sudo systemctl start jiji-mcp-signin.service
   sudo cat /var/lib/jiji-mcp/vnc-password
   ```

   ```sh
   ssh -L 5900:127.0.0.1:5900 <linux-host>
   ```

   Open a VNC client to `127.0.0.1:5900`, enter that password, complete Jiji sign-in, then:

   ```sh
   sudo systemctl stop jiji-mcp-signin.service
   ```

   `x11vnc` listens on `127.0.0.1` only, accepts one client, and reads the password from that file with `-passwdfile`. The password is not placed on the x11vnc command line. Do not publish port 5900. The unit also exits after 30 minutes and removes the password file.

6. Enable and start the headless companion. It conflicts with the sign-in unit, so only one of them holds the profile and the outbound bridge.

   ```sh
   sudo systemctl enable --now jiji-mcp.service
   sudo systemctl status jiji-mcp.service
   ```

7. Forward the approve page, which is bound to `127.0.0.1:38473`, and generate a new pairing code for each agent. Old Mac pairings do not follow the new relay identity.

   ```sh
   ssh -L 38473:127.0.0.1:38473 <linux-host>
   ```

   Open `http://127.0.0.1:38473`, choose **Generate pairing code**, and enter it on the relay consent page.

8. Redeploy the Worker from this branch so remote agents gain `jiji_send_prepared`. The Linux move itself uses the existing outbound WebSocket. Bindings stay `MCP_STORAGE` and `BRIDGES` / `JijiBridge`. Do not change `wrangler.local.jsonc` except to keep the database id it already has.

   ```sh
   npx wrangler deploy --config wrangler.local.jsonc --durable-objects-code-update-mode immediate
   ```

9. Confirm the Mac agent is still disabled and only `jiji-mcp.service` is active. Set `JIJI_AUTO_APPROVE=true` in `/etc/jiji-mcp/env` only if prepared messages should send without the approve page, then `sudo systemctl restart jiji-mcp.service`. Leave `JIJI_SEND_LOG_TEXT` unset or `false` so the send log stores a hash and a length. Leave `JIJI_HOURLY_SEND_CAP` unset for no hourly limit, or set it to a number if you want that limit.

10. Optional, and only with the owner's go-ahead: enable the notify-only push feed by setting `JIJI_PUSH_WEBHOOK_URL` and `JIJI_PUSH_WEBHOOK_AUTH_VALUE` (plus `JIJI_PUSH_WEBHOOK_AUTH_HEADER` if the receiver does not use `Authorization`) in `/etc/jiji-mcp/env`, then restart `jiji-mcp.service`. State is kept in `/data/push-notifications`. Check `journalctl -u jiji-mcp.service` for `[jiji-push] info push notifications enabled` with the webhook host, or for the reason it stayed off. The first poll baselines and sends nothing. See the README section on push notifications.
