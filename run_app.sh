#!/usr/bin/env bash
# Kept for muscle memory — the launcher is now start.sh (Next.js app in web/,
# not the old python app.py). Delegates so either name works.
HERE="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
exec "$HERE/start.sh" "$@"
