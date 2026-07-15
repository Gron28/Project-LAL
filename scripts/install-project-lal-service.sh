#!/usr/bin/env bash
# Install/switch the Linux user service used by the current Project-LAL host.
# The service source stays tracked in deploy/systemd; this script only links it
# into the user's systemd configuration.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/.." && pwd)"
UNIT_SOURCE="$ROOT/deploy/systemd/project-lal.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_TARGET="$UNIT_DIR/project-lal.service"
OLD_UNIT="localailab.service"
PORT="${PORT:-8770}"

[ -f "$UNIT_SOURCE" ] || { echo "Missing unit source: $UNIT_SOURCE" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemctl is required for the Linux service installer." >&2; exit 1; }

if curl -fsS "http://127.0.0.1:${PORT}/api/sysinfo" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s),r=x.runtime||{};process.exit(x.runLive||(r.activeRuns||[]).length||r.training?.alive||r.lens?.alive?0:1)})'
then
  echo "Project-LAL has active work; refusing to switch services." >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
ln -sfn "$UNIT_SOURCE" "$UNIT_TARGET"
systemctl --user daemon-reload
systemctl --user enable project-lal.service >/dev/null

if systemctl --user is-active --quiet "$OLD_UNIT"; then
  systemctl --user stop "$OLD_UNIT"
fi

if ! systemctl --user start project-lal.service; then
  echo "Project-LAL service failed to start; restoring $OLD_UNIT." >&2
  systemctl --user start "$OLD_UNIT" || true
  exit 1
fi

for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/sysinfo"; then
    systemctl --user disable "$OLD_UNIT" >/dev/null 2>&1 || true
    echo "Project-LAL service is active: project-lal.service"
    exit 0
  fi
  sleep 1
done

echo "Project-LAL service did not become healthy; restoring $OLD_UNIT." >&2
systemctl --user stop project-lal.service || true
systemctl --user start "$OLD_UNIT" || true
exit 1
