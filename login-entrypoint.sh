#!/usr/bin/env bash
# Interactive mode: same probe, but with a VNC server attached to the X display
# so you can scan the QR / type an SMS code once. The profile persists in /data.
set -euo pipefail

: "${LOGIN_HOLD_MS:=600000}"
export LOGIN_HOLD_MS
export DISPLAY=:99

Xvfb :99 -screen 0 1280x900x24 &
XVFB_PID=$!
trap 'kill $XVFB_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  xdpyinfo -display :99 >/dev/null 2>&1 && break
  sleep 0.2
done

# Bound to 0.0.0.0 inside the container only; compose publishes it on the host's
# loopback, so reaching it still requires an SSH tunnel.
x11vnc -display :99 -forever -nopw -shared -quiet -listen 0.0.0.0 -rfbport 5900 &

echo "[nemr] VNC ready. From your laptop:"
echo "[nemr]   ssh -L 5900:127.0.0.1:5900 <user>@<server>"
echo "[nemr] then open vnc://127.0.0.1:5900"
echo "[nemr] browser will stay open for $((LOGIN_HOLD_MS / 1000))s"

exec node probe.js
