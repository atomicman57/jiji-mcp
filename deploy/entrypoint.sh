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
  x11vnc \
    -display "$DISPLAY" \
    -localhost \
    -rfbport "${JIJI_VNC_PORT:-5900}" \
    -forever \
    -shared \
    -nopw \
    -noxdamage >/tmp/x11vnc.log 2>&1 &
  vnc_pid=$!
  trap 'kill "$vnc_pid" "$xvfb_pid" 2>/dev/null || true' EXIT INT TERM
fi
exec node /app/src/companion.mjs
