#!/bin/sh
# Headless companion, or a one-time headed sign-in display.
# Xvfb does not listen on TCP. x11vnc accepts only loopback clients.
set -eu
cd /app
if [ "${JIJI_SIGNIN:-0}" = "1" ]; then
  export DISPLAY="${DISPLAY:-:99}"
  export JIJI_HEADLESS=false
  Xvfb "$DISPLAY" -screen 0 "${JIJI_SIGNIN_SCREEN:-1280x800x24}" -nolisten tcp >/tmp/xvfb.log 2>&1 &
  xvfb_pid=$!
  display_number="${DISPLAY#:}"
  i=0
  while [ ! -S "/tmp/.X11-unix/X${display_number}" ]; do
    i=$((i + 1))
    if [ "$i" -gt 50 ]; then
      echo "Xvfb did not start" >&2
      kill "$xvfb_pid" 2>/dev/null || true
      exit 1
    fi
    sleep 0.1
  done
  # One-time VNC password. The file is mode 0600 and is removed on exit.
  # x11vnc reads the file itself, so the password never appears on argv.
  # Do not print the password; the owner reads the file with sudo.
  password_file="${JIJI_VNC_PASSWORD_FILE:-/data/vnc-password}"
  cleanup() {
    node /usr/local/bin/jiji-vnc-password remove "$password_file" || rm -f "$password_file"
    if [ -n "${vnc_pid:-}" ]; then kill "$vnc_pid" 2>/dev/null || true; fi
    if [ -n "${xvfb_pid:-}" ]; then kill "$xvfb_pid" 2>/dev/null || true; fi
    if [ -n "${node_pid:-}" ]; then kill "$node_pid" 2>/dev/null || true; fi
  }
  trap cleanup EXIT INT TERM
  node /usr/local/bin/jiji-vnc-password create "$password_file"
  echo "VNC is loopback-only. Read the one-time password with: sudo cat /var/lib/jiji-mcp/vnc-password" >&2
  x11vnc \
    -display "$DISPLAY" \
    -localhost \
    -passwdfile "$password_file" \
    -rfbport "${JIJI_VNC_PORT:-5900}" \
    -forever \
    -noxdamage >/tmp/x11vnc.log 2>&1 &
  vnc_pid=$!
  node /app/src/companion.mjs &
  node_pid=$!
  wait "$node_pid"
  status=$?
  cleanup
  exit "$status"
fi
exec node /app/src/companion.mjs
