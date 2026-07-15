#!/usr/bin/env bash
# Install the current in-repository LAL client for the Linux host. This is a
# local development/owner path, not a second distribution channel: Windows
# continues to use its checksum-pinned standalone release.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
HOST="${LAL_HOST:-http://127.0.0.1:8770}"
LAL_HOME="${LAL_HOME:-$HOME/.lal}"
TOKEN_FILE="${LAL_TOKEN_FILE:-$ROOT/web/.data/cli-token}"
TARGET="${LAL_BIN_DIR:-$HOME/.local/bin}"

[ -f "$TOKEN_FILE" ] || { echo "LAL pairing token is unavailable. Start the host first." >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js is required" >&2; exit 1; }

TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
DEVICE_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID().replace(/-/g,""))')"
DEVICE_NAME="${LAL_DEVICE_NAME:-$(hostname)}"
PLATFORM="$(uname -s)-$(uname -m)"
mkdir -p "$LAL_HOME" "$TARGET"

headers=( -H "Authorization: Bearer $TOKEN" -H "X-LAL-Device-Id: $DEVICE_ID" -H "X-LAL-Device-Name: $DEVICE_NAME" -H "X-LAL-Platform: $PLATFORM" -H "X-LAL-Client-Version: local-source" )
curl --fail --silent --show-error "${headers[@]}" "$HOST/api/lal/client-settings" -o "$LAL_HOME/settings.json"
curl --fail --silent --show-error "$HOST/lal/system.md" -o "$LAL_HOME/system.base.md"
if [ ! -f "$LAL_HOME/system.local.md" ]; then
  printf '%s\n' '# Your local LAL prompt additions. This file is preserved by lal update.' > "$LAL_HOME/system.local.md"
fi
{
  cat "$LAL_HOME/system.base.md"
  printf '\n\n---\n\n# Owner additions (system.local.md)\n\n'
  cat "$LAL_HOME/system.local.md"
} > "$LAL_HOME/system.md"
printf 'LAL_API_KEY=%s\n' "$TOKEN" > "$LAL_HOME/.env"
printf '%s\n' "$HOST" > "$LAL_HOME/client-host"
printf '%s\n' "$DEVICE_ID" > "$LAL_HOME/device-id"
printf '%s\n' "$DEVICE_NAME" > "$LAL_HOME/device-name"
printf '%s\n' "$PLATFORM" > "$LAL_HOME/platform"
printf 'local-source\n' > "$LAL_HOME/client-version"
chmod 600 "$LAL_HOME/.env"
ln -sfn "$ROOT/bin/lal" "$TARGET/lal"
ln -sfn "$ROOT/bin/lal" "$TARGET/LAL"
echo "Current LAL installed at $TARGET/lal. Open a new shell, then run: lal"
