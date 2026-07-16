#!/usr/bin/env bash
# Canonical Project-LAL update path. This deliberately owns the complete
# ordering so a compiled package, executable CLI bundle, deployed web host,
# managed settings, and published remote-client artifact cannot drift apart.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
CLI="$ROOT/apps/cli"
WEB="$ROOT/web"
PUBLISH_CLIENTS=1
RUN_SMOKE=0
OPEN_BROWSER=0

usage() {
  cat <<'EOF'
Usage: ./update-all.sh [options]

Builds the CLI packages and executable bundle, safely deploys/restarts the web
UI and API, then refreshes this machine's installed `lal` settings and prompt.
By default it also publishes a checksum-pinned Windows runtime for connected
machines, automatically incrementing the `-lal.N` release when necessary.

Options:
  --local-only       Update this host and its CLI; do not publish remote clients
  --publish-clients  Publish the remote Windows runtime (default)
  --smoke            Run the guarded live host smoke test after deployment
  --open             Open the web UI after a successful deployment
  -h, --help         Show this help

Connected machines are never modified by surprise. Publishing makes the new
runtime available through the normal authenticated LAL installer/update path;
run that path on each connected machine to activate it.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --local-only) PUBLISH_CLIENTS=0 ;;
    --publish-clients) PUBLISH_CLIENTS=1 ;;
    --smoke) RUN_SMOKE=1 ;;
    --open) OPEN_BROWSER=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

command -v node >/dev/null || { echo "Node.js is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemctl is required." >&2; exit 1; }

LOCK="${XDG_RUNTIME_DIR:-/tmp}/update-all-local-ai-lab-${UID}.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Another complete LAL update is already running." >&2
  exit 1
fi

if [ "$PUBLISH_CLIENTS" = "1" ]; then
  CURRENT_VERSION="$(node -p "require('$CLI/package.json').version")"
  PUBLISHED_VERSION="$(node -p "require('$WEB/public/lal/manifest.json').lalRuntimeVersion")"
  if [ "$CURRENT_VERSION" = "$PUBLISHED_VERSION" ]; then
    NEXT_VERSION="$(node -e '
      const value = process.argv[1];
      const match = /^(.*-lal\.)(\d+)$/.exec(value);
      if (!match) throw new Error(`Cannot auto-increment non-LAL version: ${value}`);
      process.stdout.write(match[1] + (Number(match[2]) + 1));
    ' "$CURRENT_VERSION")"
    echo "==> Advancing connected-client release: $CURRENT_VERSION -> $NEXT_VERSION"
    (cd "$CLI" && npm version "$NEXT_VERSION" --no-git-tag-version --allow-same-version >/dev/null)
    (cd "$CLI" && npm version "$NEXT_VERSION" --workspace packages/cli --no-git-tag-version --allow-same-version >/dev/null)
  fi
fi

echo "==> Building CLI packages"
(cd "$CLI" && npm run build)

echo "==> Building the executable CLI bundle"
(cd "$CLI" && npm run bundle)

# Ollama's OpenAI-compatible API cannot set a request-level context size. The
# small derived profile below is the official durable solution: it preserves
# the familiar base name in LAL while giving tool-using Gemma enough room.
if command -v ollama >/dev/null && ollama show gemma4:12b >/dev/null 2>&1; then
  if ! ollama show gemma4:12b-lal-cli-16k >/dev/null 2>&1; then
    echo "==> Creating Gemma 12B's managed 16K-context profile"
    PROFILE_FILE="$(mktemp "${TMPDIR:-/tmp}/lal-gemma4-16k.XXXXXX.Modelfile")"
    trap 'rm -f "$PROFILE_FILE"' EXIT
    printf 'FROM gemma4:12b\nPARAMETER num_ctx 16384\n' > "$PROFILE_FILE"
    ollama create gemma4:12b-lal-cli-16k -f "$PROFILE_FILE"
    rm -f "$PROFILE_FILE"
    trap - EXIT
  fi
fi

if [ "$PUBLISH_CLIENTS" = "1" ]; then
  echo "==> Packaging and publishing the connected Windows client"
  # The development bundle deliberately omits the standalone wrapper. Prepare
  # it before packaging so the generated archive contains cli-entry.js and
  # connected clients never receive an incomplete runtime.
  (cd "$CLI" && LAL_HEADLESS_STANDALONE=1 npm run prepare:package)
  LAL_REUSE_DIST=1 LAL_HEADLESS_STANDALONE=1 "$ROOT/scripts/release-lal-cli.sh"
fi

echo "==> Safely building and deploying the web UI/API"
OPEN_BROWSER="$OPEN_BROWSER" "$ROOT/scripts/rebuild-local-ai-lab.sh"

echo "==> Refreshing this machine's CLI, managed settings, and system prompt"
LAL_SKIP_CLI_BUILD=1 "$ROOT/scripts/install-local-lal.sh"

if [ "$RUN_SMOKE" = "1" ]; then
  echo "==> Running guarded live-host smoke test"
  "$ROOT/scripts/smoke-project-lal.sh"
fi

echo "==> Complete LAL update succeeded"
echo "    Web UI/API: deployed and healthy"
echo "    Local CLI: bundled, installed, and refreshed"
if [ "$PUBLISH_CLIENTS" = "1" ]; then
  echo "    Connected-client release: published and checksum-pinned"
else
  echo "    Connected-client release: unchanged (--local-only)"
fi
