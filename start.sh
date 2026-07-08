#!/usr/bin/env bash
# Local AI Lab — one-click launcher.
#
# Click this (or run it) and it brings the whole thing up on its own:
#   • installs web deps on first run
#   • builds the Next.js app when the code has changed (never serves a stale bundle)
#   • frees the port if a previous instance is still holding it
#   • exposes it on your tailnet via `tailscale serve` (so your phone sees the same app)
#   • starts the server and opens it in your browser
#
# GPU serving (llama.cpp on :8099) and Ollama (:11434) are started ON DEMAND by the
# app itself — you don't launch them here. Training likewise runs through the app.
#
# Ports (override with env): PORT=8770 (app), TS_PORT=8443 (tailnet https).
# Handy flags:  --install-launcher  write a double-clickable desktop entry
#               FORCE_BUILD=1        rebuild even if the code is unchanged
#               SKIP_BUILD=1         start whatever is already built (fast)
set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
WEB="$HERE/web"
PORT="${PORT:-8770}"
TS_PORT="${TS_PORT:-8443}"

c_ok(){ printf '\033[1;32m[lab]\033[0m %s\n' "$*"; }
c_warn(){ printf '\033[1;33m[lab]\033[0m %s\n' "$*"; }
c_err(){ printf '\033[1;31m[lab]\033[0m %s\n' "$*"; }

# --- optional: create a desktop launcher you can double-click ----------------
if [ "${1:-}" = "--install-launcher" ]; then
  desktop="[Desktop Entry]
Type=Application
Name=Local AI Lab
Comment=Start the local agent + training lab and open it in the browser
Exec=$HERE/start.sh
Icon=utilities-terminal
Terminal=true
Categories=Development;Utility;"
  apps="$HOME/.local/share/applications"; mkdir -p "$apps"
  printf '%s\n' "$desktop" > "$apps/local-ai-lab.desktop"; chmod +x "$apps/local-ai-lab.desktop" 2>/dev/null || true
  if [ -d "$HOME/Desktop" ]; then
    printf '%s\n' "$desktop" > "$HOME/Desktop/local-ai-lab.desktop"; chmod +x "$HOME/Desktop/local-ai-lab.desktop" 2>/dev/null || true
    # GNOME marks new .desktop files "untrusted" until allowed — do it for the user.
    command -v gio >/dev/null 2>&1 && gio set "$HOME/Desktop/local-ai-lab.desktop" metadata::trusted true 2>/dev/null || true
  fi
  c_ok "Launcher installed. Double-click 'Local AI Lab' on your Desktop (or find it in the app menu)."
  exit 0
fi

command -v node >/dev/null 2>&1 || { c_err "Node.js is not installed. Install it, then run this again."; exit 1; }
command -v npm  >/dev/null 2>&1 || { c_err "npm is not installed. Install Node.js, then run this again."; exit 1; }
[ -d "$WEB" ] || { c_err "web/ not found next to this script — is the repo intact?"; exit 1; }
cd "$WEB"

# --- deps (first run only) ---------------------------------------------------
if [ ! -d node_modules ]; then
  c_ok "Installing dependencies (first run — this takes a minute)…"
  npm install --no-audit --no-fund || { c_err "npm install failed."; exit 1; }
fi

# --- build only when the code actually changed -------------------------------
# Skipping a build after a code change silently serves the OLD bundle (a documented
# footgun). But rebuilding on every launch is slow, so we stamp the built commit and
# rebuild only when HEAD moved (e.g. after a `git pull`) or the build is missing.
stamp="$WEB/.next/.build-commit"
head_now="$(git -C "$HERE" rev-parse HEAD 2>/dev/null || echo nogit)"
need_build=0
[ -d "$WEB/.next" ] || need_build=1
[ -f "$stamp" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$head_now" ] || need_build=1
[ "${FORCE_BUILD:-0}" = "1" ] && need_build=1
[ "${SKIP_BUILD:-0}" = "1" ] && need_build=0

if [ "$need_build" = "1" ]; then
  c_ok "Building the app…"
  if npm run build; then
    mkdir -p "$WEB/.next"; printf '%s' "$head_now" > "$stamp"
  else
    c_err "Build failed — not starting a broken app. Fix the error above and retry."
    exit 1
  fi
else
  c_ok "Code unchanged since last build — starting the existing build (SKIP)."
fi

# --- free the port if a previous instance is still up ------------------------
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 && { c_warn "Stopped a previous instance on :${PORT}."; sleep 1; } || true
fi

# --- expose on the tailnet (best-effort; local access works regardless) ------
if command -v tailscale >/dev/null 2>&1; then
  if tailscale serve --bg --https="$TS_PORT" "http://127.0.0.1:${PORT}" >/dev/null 2>&1; then
    host="$(tailscale status --json 2>/dev/null | grep -o '"DNSName":[^,]*' | head -1 | cut -d'"' -f4)"
    host="${host%.}"
    [ -n "$host" ] && c_ok "On your other devices: https://${host}:${TS_PORT}" || c_ok "Tailnet serve is on (port ${TS_PORT})."
  else
    c_warn "Couldn't set up tailscale serve — the app still works locally."
  fi
fi

# --- open the browser once the server is actually answering ------------------
(
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
      command -v xdg-open >/dev/null 2>&1 && xdg-open "http://localhost:${PORT}/code" >/dev/null 2>&1 || true
      break
    fi
    sleep 1
  done
) &

c_ok "Starting Local AI Lab → http://localhost:${PORT}   (Ctrl-C here to stop)"
exec npm run start -- -p "$PORT" -H 0.0.0.0
