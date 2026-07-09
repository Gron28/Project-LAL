#!/usr/bin/env bash
# Local AI Lab — one-click launcher.
#
# Click this (or run it) and it brings the whole thing up on its own:
#   • installs web deps on first run
#   • preserves the current working build
#   • builds the current code and activates it only when the build succeeds
#   • exposes it on your tailnet via `tailscale serve` (so your phone sees the same app)
#   • restarts the managed server and opens it in your browser
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

c_ok "Safely rebuilding Local AI Lab…"
OPEN_BROWSER=1 exec "$HOME/.local/bin/rebuild-local-ai-lab"
