#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/.." && pwd)"
FORK="$ROOT/lal-cli"
MANIFEST="$ROOT/web/public/lal/manifest.json"

if [ ! -f "$FORK/package.json" ]; then
  echo "LAL fork is missing. Clone submodules first: git submodule update --init --recursive" >&2
  exit 1
fi

command -v node >/dev/null || { echo "Node.js is required to build LAL." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required to build LAL." >&2; exit 1; }

VERSION="$(node -p "require('$FORK/package.json').version")"
OUT="$ROOT/web/public/lal/releases/$VERSION"

echo "==> Building native LAL $VERSION"
cd "$FORK"
if [ "${LAL_REUSE_DIST:-0}" != "1" ]; then
  if [ ! -d node_modules ]; then
    echo "==> Installing fork dependencies (first release only)"
    QWEN_SKIP_PREPARE=1 npm ci --no-audit --no-fund --progress=false
  fi
  npm run build
  npm run bundle
  npm run prepare:package
else
  echo "==> Reusing the existing dist bundle (LAL_REUSE_DIST=1)"
fi

mkdir -p "$OUT"
npm run package:standalone:release -- \
  --target win-x64 \
  --version "$VERSION" \
  --out-dir "$OUT"

cd "$ROOT"
node scripts/update-lal-release-manifest.mjs "$VERSION"
python3 -m unittest tests.test_lal_windows_release

echo "==> LAL $VERSION is packaged, checksum-pinned, and verified"
echo "    Manifest: $MANIFEST"
echo "    Archive:  $OUT/lal-cli-win-x64.zip"
