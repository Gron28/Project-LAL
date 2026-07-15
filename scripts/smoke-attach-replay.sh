#!/usr/bin/env bash
# Guarded gateway attach/replay check. It uses the same durable SSE endpoint as
# the phone UI and the Windows LAL /attach command.
set -euo pipefail

BASE_URL="${LAL_ATTACH_SMOKE_URL:-http://127.0.0.1:8770}"
TOKEN="${LAL_API_KEY:-${LAL_CLI_TOKEN:-}}"
MODEL="${LAL_SMOKE_MODEL:-qwen3-4b-stock}"
TIMEOUT_SECONDS="${LAL_SMOKE_TIMEOUT_SECONDS:-90}"
RUN_ID=""
MODEL_STARTED=0

json() { node -e "$1"; }
auth_args=()
if [ -n "$TOKEN" ]; then auth_args=(-H "Authorization: Bearer $TOKEN"); fi

cleanup() {
  local status=$?
  if [ -n "$RUN_ID" ]; then curl --max-time 8 --silent -X POST "${auth_args[@]}" "$BASE_URL/api/agent/runs/$RUN_ID/stop" >/dev/null || true; fi
  if [ "$MODEL_STARTED" = "1" ]; then curl --max-time 15 --silent -X DELETE "${auth_args[@]}" "$BASE_URL/api/sysinfo" >/dev/null || true; fi
  exit "$status"
}
trap cleanup EXIT

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js is required" >&2; exit 1; }

echo "==> Checking idle gateway at $BASE_URL"
SYSINFO="$(curl --max-time 8 --silent --show-error --fail-with-body "${auth_args[@]}" "$BASE_URL/api/sysinfo")"
printf '%s' "$SYSINFO" | json 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s),r=x.runtime||{};if(x.runLive||(r.activeRuns||[]).length||r.serving?.alive||r.training?.alive||r.lens?.alive)process.exit(1);});'

PAYLOAD="$(node -e 'console.log(JSON.stringify({model:process.argv[1],think:false,messages:[{role:"user",content:"Reply with exactly this text and nothing else: LAL attach replay passed."}]}))' "$MODEL")"
STARTED="$(curl --max-time 12 --silent --show-error --fail-with-body -X POST "${auth_args[@]}" -H 'content-type: application/json' --data "$PAYLOAD" "$BASE_URL/api/agent/chat")"
RUN_ID="$(printf '%s' "$STARTED" | json 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s);if(!x.runId)process.exit(1);process.stdout.write(x.runId);});')"
MODEL_STARTED=1
echo "==> Started attach smoke run $RUN_ID"

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
while :; do
  RUN="$(curl --max-time 8 --silent --show-error --fail-with-body "${auth_args[@]}" "$BASE_URL/api/agent/runs/$RUN_ID")"
  STATUS="$(printf '%s' "$RUN" | json 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status||""));')"
  case "$STATUS" in done) break;; error|stopped|interrupted) echo "Attach smoke run settled as $STATUS" >&2; exit 1;; esac
  [ "$(date +%s)" -lt "$deadline" ] || { echo "Attach smoke timed out." >&2; exit 1; }
  sleep 1
done

STREAM="$(curl --max-time 15 --silent --show-error --fail-with-body "${auth_args[@]}" "$BASE_URL/api/agent/runs/$RUN_ID/stream?after=0")"
LAST_SEQ="$(printf '%s' "$STREAM" | json 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const lines=s.split("\n"),ids=lines.filter(x=>x.startsWith("id: ")).map(x=>Number(x.slice(4))),data=lines.filter(x=>x.startsWith("data: ")).map(x=>JSON.parse(x.slice(6))),text=data.filter(x=>x.k==="text").map(x=>String(x.v||"")).join("");if(data[0]?.k!=="protocol"||data[1]?.k!=="run"||text!=="LAL attach replay passed."||data.at(-1)?.k!=="status"||data.at(-1)?.v!=="done"||!ids.length)process.exit(1);process.stdout.write(String(Math.max(...ids)));});')"
REPLAY="$(curl --max-time 15 --silent --show-error --fail-with-body "${auth_args[@]}" -H "Last-Event-ID: $((LAST_SEQ - 1))" "$BASE_URL/api/agent/runs/$RUN_ID/stream?after=0")"
printf '%s' "$REPLAY" | json 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const data=s.split("\n").filter(x=>x.startsWith("data: ")).map(x=>JSON.parse(x.slice(6)));if(data[0]?.k!=="protocol"||data[1]?.k!=="run"||data.length!==3||data[2]?.k!=="status"||data[2]?.v!=="done")process.exit(1);});'
echo "==> Durable SSE replay and Last-Event-ID resume verified"

curl --max-time 15 --silent --show-error --fail-with-body -X DELETE "${auth_args[@]}" "$BASE_URL/api/sysinfo" >/dev/null
MODEL_STARTED=0
RUN_ID=""
echo "==> Cleanup verified"
