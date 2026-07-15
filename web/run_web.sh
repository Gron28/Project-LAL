#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
NODE_BIN="${LAL_NODE_BIN:-}"

# The present Linux host uses NVM's Node 24. Keep that as a fallback without
# hard-coding the machine path into the service unit; other hosts can export
# LAL_NODE_BIN or provide `node` on PATH.
if [ -z "$NODE_BIN" ] && [ -x "$HOME/.nvm/versions/node/v24.11.0/bin/node" ]; then
  NODE_BIN="$HOME/.nvm/versions/node/v24.11.0/bin/node"
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
[ -n "$NODE_BIN" ] || { echo "Project-LAL requires Node.js; set LAL_NODE_BIN or add node to PATH." >&2; exit 1; }

export HSA_OVERRIDE_GFX_VERSION="${HSA_OVERRIDE_GFX_VERSION:-10.3.0}"
cd "$HERE"
exec "$NODE_BIN" ./node_modules/next/dist/bin/next start -p "${PORT:-8770}"
