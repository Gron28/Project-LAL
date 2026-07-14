#!/usr/bin/env bash
set -euo pipefail

LAL_HOME="${LAL_HOME:-$HOME/.lal}"
host="${LAL_HOST:-}"
if [ -z "$host" ] && [ -f "$LAL_HOME/client-host" ]; then host="$(sed -n '1p' "$LAL_HOME/client-host")"; fi
host="${host:-https://main-pc.tail3ba909.ts.net}"

if [ "${1:-}" = "update" ]; then
  token="${LAL_TOKEN:-}"
  if [ -z "$token" ] && [ -f "$LAL_HOME/.env" ]; then token="$(sed -n 's/^LAL_API_KEY=//p' "$LAL_HOME/.env" | head -n 1)"; fi
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL "$host/lal/install.sh" -o "$installer"
  LAL_HOST="$host" LAL_TOKEN="$token" bash "$installer" --update
  exit
fi

if [ -f "$LAL_HOME/.env" ]; then
  token="$(sed -n 's/^LAL_API_KEY=//p' "$LAL_HOME/.env" | head -n 1)"
  if [ -n "$token" ]; then export LAL_API_KEY="$token"; fi
fi
export QWEN_HOME="$LAL_HOME"

device_id="$(sed -n '1p' "$LAL_HOME/device-id" 2>/dev/null || true)"
device_name="$(sed -n '1p' "$LAL_HOME/device-name" 2>/dev/null || true)"
platform="$(sed -n '1p' "$LAL_HOME/platform" 2>/dev/null || true)"
client_version="$(sed -n '1p' "$LAL_HOME/client-version" 2>/dev/null || true)"
if [ -n "${LAL_API_KEY:-}" ] && [ -n "$device_id" ]; then
  curl -fsS --max-time 5 -X POST \
    -H "Authorization: Bearer $LAL_API_KEY" \
    -H "X-LAL-Device-Id: $device_id" \
    -H "X-LAL-Device-Name: $device_name" \
    -H "X-LAL-Platform: $platform" \
    -H "X-LAL-Client-Version: $client_version" \
    "$host/api/lal/heartbeat" >/dev/null 2>&1 || true
fi

if command -v qwen >/dev/null 2>&1; then exec qwen "$@"; fi
if [ -x "$HOME/.local/bin/qwen" ]; then exec "$HOME/.local/bin/qwen" "$@"; fi
printf 'LAL runtime is missing. Run: lal update\n' >&2
exit 1
