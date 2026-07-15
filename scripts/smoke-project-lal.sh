#!/usr/bin/env bash
# Guarded, real host smoke check. This is intentionally not part of `npm test`:
# it loads a local model and creates one durable run record. Run it only on an
# idle host after the web service is already running.
set -euo pipefail

BASE_URL="${LAL_SMOKE_URL:-http://127.0.0.1:8770}"
MODEL="${LAL_SMOKE_MODEL:-qwen3-4b-stock}"
TIMEOUT_SECONDS="${LAL_SMOKE_TIMEOUT_SECONDS:-90}"
RUN_ID=""
MODEL_STARTED=0

json() { node -e "$1"; }

cleanup() {
  local status=$?
  if [ -n "$RUN_ID" ]; then
    curl --max-time 8 --silent --output /dev/null \
      -X POST "$BASE_URL/api/agent/runs/$RUN_ID/stop" || true
  fi
  if [ "$MODEL_STARTED" = "1" ]; then
    curl --max-time 15 --silent --output /dev/null -X DELETE "$BASE_URL/api/sysinfo" || true
  fi
  exit "$status"
}
trap cleanup EXIT

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js is required" >&2; exit 1; }

echo "==> Checking idle Project-LAL host at $BASE_URL"
SYSINFO="$(curl --max-time 8 --silent --show-error --fail-with-body "$BASE_URL/api/sysinfo")"
if ! printf '%s' "$SYSINFO" | json '
  let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
    const x = JSON.parse(s); const r = x.runtime || {};
    const busy = x.runLive || (r.activeRuns || []).length || r.serving?.alive || r.training?.alive || r.lens?.alive;
    if (busy) { console.error("Refusing smoke test: Project-LAL is not idle."); process.exit(1); }
  });
'; then
  exit 1
fi

PAYLOAD="$(node -e 'console.log(JSON.stringify({ model: process.argv[1], think: false, messages: [{ role: "user", content: "Reply with exactly this text and nothing else: LAL smoke test passed." }] }))' "$MODEL")"
STARTED="$(curl --max-time 12 --silent --show-error --fail-with-body \
  -X POST "$BASE_URL/api/agent/chat" -H 'content-type: application/json' --data "$PAYLOAD")"
RUN_ID="$(printf '%s' "$STARTED" | json '
  let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
    const id = JSON.parse(s).runId; if (!id) process.exit(1); process.stdout.write(id);
  });
')"
MODEL_STARTED=1
echo "==> Started smoke run $RUN_ID using $MODEL"

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
while :; do
  RUN="$(curl --max-time 8 --silent --show-error --fail-with-body "$BASE_URL/api/agent/runs/$RUN_ID")"
  STATUS="$(printf '%s' "$RUN" | json 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status || ""));')"
  case "$STATUS" in
    done) break ;;
    error|stopped|interrupted)
      printf '%s' "$RUN" | json 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const x=JSON.parse(s); console.error(`Smoke run ${x.status}: ${x.error || "no detail"}`); process.exit(1);});'
      ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Smoke run did not settle within ${TIMEOUT_SECONDS}s." >&2
    exit 1
  fi
  sleep 1
done

TRACE="$(curl --max-time 8 --silent --show-error --fail-with-body "$BASE_URL/api/agent/runs/$RUN_ID?trace=1")"
printf '%s' "$TRACE" | json '
  let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
    const x=JSON.parse(s); const output=x.trace?.output?.trim();
    if (x.run?.status !== "done" || output !== "LAL smoke test passed.") process.exit(1);
    console.log(`==> Durable run verified (${x.diagnosis?.verdict || "unknown"})`);
  });
'

curl --max-time 15 --silent --show-error --fail-with-body -X DELETE "$BASE_URL/api/sysinfo" >/dev/null
MODEL_STARTED=0
RUN_ID=""
FINAL="$(curl --max-time 8 --silent --show-error --fail-with-body "$BASE_URL/api/sysinfo")"
printf '%s' "$FINAL" | json '
  let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
    const x=JSON.parse(s); const r=x.runtime || {};
    if (x.runLive || (r.activeRuns || []).length || r.serving?.alive) process.exit(1);
    console.log("==> Cleanup verified: no active run or model process remains");
  });
'
