#!/usr/bin/env bash
set -euo pipefail

updating=0
if [ "${1:-}" = "--update" ]; then updating=1; fi
host="${LAL_HOST:-https://main-pc.tail3ba909.ts.net}"
host="${host%/}"
lal_home="${LAL_HOME:-$HOME/.lal}"
bin_dir="${LAL_BIN_DIR:-$HOME/.local/bin}"
runtime_installer_default="https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$host/lal/manifest.json" -o "$tmp/manifest.json"
runtime_version="$(sed -n 's/.*"runtimeVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/manifest.json")"
client_version="$(sed -n 's/.*"clientVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/manifest.json")"
runtime_installer="$(sed -n 's/.*"runtimeInstaller"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/manifest.json")"
runtime_installer="${runtime_installer:-$runtime_installer_default}"
if [ -z "$runtime_version" ] || [ -z "$client_version" ]; then printf 'Invalid LAL release manifest.\n' >&2; exit 1; fi

mkdir -p "$lal_home" "$bin_dir"
if [ -s "$lal_home/device-id" ]; then
  device_id="$(sed -n '1p' "$lal_home/device-id")"
else
  device_id="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s\n' "$device_id" > "$lal_home/device-id"
fi
if [ -s "$lal_home/device-name" ]; then
  device_name="$(sed -n '1p' "$lal_home/device-name")"
else
  device_name="$(hostname 2>/dev/null || printf 'unknown-device')"
  device_name="$(printf '%s' "$device_name" | tr -d '\r\n' | cut -c 1-100)"
  printf '%s\n' "$device_name" > "$lal_home/device-name"
fi
platform="$(uname -s 2>/dev/null || printf 'unknown')/$(uname -m 2>/dev/null || printf 'unknown')"
printf '%s\n' "$platform" > "$lal_home/platform"
token="${LAL_TOKEN:-}"
if [ -z "$token" ] && [ -f "$lal_home/.env" ]; then token="$(sed -n 's/^LAL_API_KEY=//p' "$lal_home/.env" | head -n 1)"; fi
if [ -z "$token" ]; then
  if [ ! -r /dev/tty ]; then printf 'Set LAL_TOKEN to the pairing token from main-pc.\n' >&2; exit 1; fi
  printf 'LAL pairing token: ' >/dev/tty
  IFS= read -r token </dev/tty
fi
if [ -z "$token" ]; then printf 'A pairing token is required.\n' >&2; exit 1; fi

curl -fsSL \
  -H "Authorization: Bearer $token" \
  -H "X-LAL-Device-Id: $device_id" \
  -H "X-LAL-Device-Name: $device_name" \
  -H "X-LAL-Platform: $platform" \
  -H "X-LAL-Client-Version: $client_version" \
  "$host/api/lal/client-settings" -o "$tmp/settings.json"

installed_runtime=""
if [ -f "$lal_home/runtime-version" ]; then installed_runtime="$(sed -n '1p' "$lal_home/runtime-version")"; fi
if ! command -v qwen >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/qwen" ]; then installed_runtime=""; fi
if [ "$installed_runtime" != "$runtime_version" ]; then
  curl -fsSL "$runtime_installer/install-qwen-standalone.sh" -o "$tmp/install-runtime.sh"
  QWEN_INSTALL_VERSION="$runtime_version" bash "$tmp/install-runtime.sh" --version "$runtime_version"
fi

curl -fsSL "$host/lal/lal.sh" -o "$tmp/lal"
chmod 755 "$tmp/lal"
install -m 755 "$tmp/lal" "$bin_dir/lal.new"
mv "$bin_dir/lal.new" "$bin_dir/lal"
ln -sfn "$bin_dir/lal" "$bin_dir/LAL"
printf 'LAL_API_KEY=%s\n' "$token" > "$lal_home/.env"
chmod 600 "$lal_home/.env"
printf '%s\n' "$host" > "$lal_home/client-host"
printf '%s\n' "$client_version" > "$lal_home/client-version"
printf '%s\n' "$runtime_version" > "$lal_home/runtime-version"
if [ ! -f "$lal_home/settings.json" ]; then mv "$tmp/settings.json" "$lal_home/settings.json"; fi
curl -fsS --max-time 5 -X POST \
  -H "Authorization: Bearer $token" \
  -H "X-LAL-Device-Id: $device_id" \
  -H "X-LAL-Device-Name: $device_name" \
  -H "X-LAL-Platform: $platform" \
  -H "X-LAL-Client-Version: $client_version" \
  "$host/api/lal/heartbeat" >/dev/null 2>&1 || true

if [ "$updating" -eq 1 ]; then printf 'LAL updated to %s. Sessions and settings were preserved.\n' "$client_version";
else printf 'LAL %s installed. Open a new terminal, cd into any project, and run: lal\n' "$client_version"; fi
case ":$PATH:" in *":$bin_dir:"*) ;; *) printf 'Add %s to PATH if lal is not found in a new terminal.\n' "$bin_dir";; esac
