#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/.." && pwd)"
APP="$ROOT/web"
BACKUP="$APP/.next.last-good"
CANDIDATE="$APP/.next.candidate-$$"
FAILED="$APP/.next.failed-$(date +%Y%m%d-%H%M%S)"
TSCONFIG_BACKUP="$APP/.tsconfig.before-candidate-$$.json"
LOCK="${XDG_RUNTIME_DIR:-/tmp}/rebuild-local-ai-lab-${UID}.lock"
PORT="${PORT:-8770}"
SERVICE="${PROJECT_LAL_SERVICE:-project-lal.service}"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Local AI Lab is already being rebuilt."
  exit 1
fi

restore_tsconfig() {
  if [ -f "$TSCONFIG_BACKUP" ]; then
    mv "$TSCONFIG_BACKUP" "$APP/tsconfig.json"
  fi
}
trap restore_tsconfig EXIT

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

echo "==> Local AI Lab: building an isolated candidate"
# Never write chunks into the directory the live Next process is serving. That
# race produced valid HTML pointing at half-replaced CSS/JS assets and made the
# whole app appear broken until a manual restart.
cp tsconfig.json "$TSCONFIG_BACKUP"
if ! NEXT_DIST_DIR="$(basename "$CANDIDATE")" npm run build; then
  restore_tsconfig
  echo "==> Candidate build failed; the live production build was not touched."
  rm -rf "$CANDIDATE"
  exit 1
fi
restore_tsconfig

echo "==> Local AI Lab: atomically activating the successful candidate"
systemctl --user stop "$SERVICE"
rm -rf "$BACKUP"
if [ -d .next ]; then mv .next "$BACKUP"; fi
mv "$CANDIDATE" .next
if ! systemctl --user start "$SERVICE"; then
  echo "==> Candidate could not start; restoring the previous build."
  mv .next "$FAILED"
  if [ -d "$BACKUP" ]; then mv "$BACKUP" .next; fi
  systemctl --user start "$SERVICE" || true
  exit 1
fi

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/"; then
    echo "==> Local AI Lab is healthy: http://localhost:${PORT}"
    rm -rf "$BACKUP"
    if [ "${OPEN_BROWSER:-0}" = "1" ]; then
      xdg-open "http://localhost:${PORT}/code" >/dev/null 2>&1 || true
    fi
    exit 0
  fi
  sleep 1
done

echo "Local AI Lab did not become healthy within 60 seconds."
systemctl --user --no-pager --full status "$SERVICE"
systemctl --user stop "$SERVICE" || true
mv .next "$FAILED"
if [ -d "$BACKUP" ]; then
  mv "$BACKUP" .next
  systemctl --user start "$SERVICE" || true
  echo "Previous production build restored; failed candidate retained at $FAILED"
fi
exit 1
