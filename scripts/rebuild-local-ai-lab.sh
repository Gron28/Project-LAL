#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/.." && pwd)"
APP="$ROOT/web"
BACKUP="$APP/.next.last-good"
FAILED="$APP/.next.failed"
LOCK="${XDG_RUNTIME_DIR:-/tmp}/rebuild-local-ai-lab-${UID}.lock"
PORT="${PORT:-8770}"
SERVICE="${PROJECT_LAL_SERVICE:-project-lal.service}"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Local AI Lab is already being rebuilt."
  exit 1
fi

cd "$APP"

if [ ! -d node_modules ]; then
  echo "==> Local AI Lab: installing dependencies"
  npm install --no-audit --no-fund
fi

# Never replace the server bundle while LAL-owned work is live.  The runtime
# inventory also catches a lens run, which used to be invisible to this guard.
if curl -fsS "http://127.0.0.1:${PORT}/api/sysinfo" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s),r=x.runtime||{},runs=r.activeRuns||[],lens=r.lens||{};if(x.runLive||runs.length||lens.alive){console.error(`Active work: ${[...runs.map(v=>v.id),lens.alive?`lens:${lens.model||"unknown"}`:""] .filter(Boolean).join(", ")}`);process.exit(0)}process.exit(1)})'
then
  echo "Project-LAL has active agent or lens work. Rebuild deferred."
  exit 1
fi

if curl -fsS "http://127.0.0.1:${PORT}/api/train" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).running?0:1))'
then
  echo "Local AI Lab has an active training job. Rebuild deferred."
  exit 1
fi

if pgrep -f 'python[0-9.]* .*finetune' >/dev/null 2>&1; then
  echo "An external training process is active. Rebuild deferred."
  exit 1
fi

echo "==> Local AI Lab: preserving the last working production build"
rm -rf "$BACKUP" "$FAILED"
if [ -d .next ]; then
  cp -a .next "$BACKUP"
fi

echo "==> Local AI Lab: building current code"
if ! npm run build; then
  echo "==> Build failed; restoring the previous production build."
  if [ -d "$BACKUP" ]; then
    mv .next "$FAILED" 2>/dev/null || true
    mv "$BACKUP" .next
  fi
  exit 1
fi

rm -rf "$BACKUP" "$FAILED"

echo "==> Local AI Lab: activating the successful build"
systemctl --user restart "$SERVICE"

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/"; then
    echo "==> Local AI Lab is healthy: http://localhost:${PORT}"
    if [ "${OPEN_BROWSER:-0}" = "1" ]; then
      xdg-open "http://localhost:${PORT}/code" >/dev/null 2>&1 || true
    fi
    exit 0
  fi
  sleep 1
done

echo "Local AI Lab did not become healthy within 60 seconds."
systemctl --user --no-pager --full status "$SERVICE"
exit 1
