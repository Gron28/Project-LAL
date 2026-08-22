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
# The WebUI has owner-level local capabilities (projects, model lifecycle, and
# Guardian pairing). Production therefore binds only to loopback by default.
# Remote access is an explicit deployment choice: set LAL_BIND_HOST to a
# specific interface behind an owner-controlled authenticated transport.
LAL_BIND_HOST="${LAL_BIND_HOST:-127.0.0.1}"
cd "$HERE"
exec "$NODE_BIN" ./node_modules/next/dist/bin/next start -H "$LAL_BIND_HOST" -p "${PORT:-8770}"
