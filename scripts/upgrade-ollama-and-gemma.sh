#!/usr/bin/env bash
# Upgrade the Ollama runtime, re-pull Gemma 12B, rebuild the managed long-context
# profile, and re-measure. The measurement at the end is the point: a newer
# runtime and newer weights are both claims until this box's numbers move.
#
# Requires sudo (Ollama installs to /usr/local/bin and runs as the `ollama`
# system user), which is why this is a script for the operator to run rather than
# something the agent does.
#
# Baseline recorded 2026-07-25, ollama 0.30.10, gemma4:12b, RX 6650 XT 8 GB,
# desktop running:
#
#   ctx      total    CPU/GPU    generation
#   16,384   8.7 GB   23%/77%    14.0 tok/s
#   65,536   9.0 GB   29%/71%    11.5 tok/s
#   102,400  9.1 GB   32%/68%    10.2 tok/s
set -euo pipefail

CTX="${CTX:-102400}"
MODEL="${MODEL:-gemma4:12b}"
PROFILE="${MODEL}-lal-cli-ctx"
PROMPT='Explain in two sentences why eggs set when heated.'

say() { printf '\n==> %s\n' "$*"; }

vram_mib() {
  local used
  used="$(cat /sys/class/drm/card*/device/mem_info_vram_used 2>/dev/null | head -1 || echo 0)"
  echo $(( used / 1048576 ))
}

# One measurement: load at $1 context, report the GPU split and generation speed.
measure() {
  local ctx="$1" model="$2" label="$3"
  local body
  body="$(curl -s -m 900 http://127.0.0.1:11434/api/generate \
    -d "{\"model\":\"${model}\",\"prompt\":\"${PROMPT}\",\"stream\":false,\"options\":{\"num_ctx\":${ctx},\"num_predict\":64}}")"
  local speed
  speed="$(printf '%s' "$body" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
    n = d.get("eval_count") or 0
    ns = d.get("eval_duration") or 0
    print(f"{n/(ns/1e9):.1f} tok/s ({n} tok)" if n and ns else "no timing returned")
except Exception as exc:
    print(f"unreadable response: {exc}")
')"
  printf '  %-22s %s\n' "$label" "$speed"
  printf '  %-22s %s\n' "" "$(ollama ps 2>/dev/null | tail -1)"
  printf '  %-22s vram=%s MiB\n' "" "$(vram_mib)"
}

say "Before: ollama $(ollama --version 2>/dev/null | tr -d '\n')"
say "Baseline on the CURRENT runtime (so the comparison is same-box, same-day)"
measure "$CTX" "$MODEL" "current runtime"

say "Updating Ollama (needs sudo)"
curl -fsSL https://ollama.com/install.sh | sh

say "Restarting the service"
sudo systemctl restart ollama
# The socket comes back before the model server is ready to answer.
for _ in $(seq 1 30); do
  curl -sf -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
  sleep 1
done
say "After: ollama $(ollama --version 2>/dev/null | tr -d '\n')"

say "Re-pulling ${MODEL} (this is where newer/faster weights would arrive)"
ollama pull "$MODEL"

say "Rebuilding the managed ${CTX}-context profile"
MODELFILE="$(mktemp "${TMPDIR:-/tmp}/lal-gemma-ctx.XXXXXX.Modelfile")"
trap 'rm -f "$MODELFILE"' EXIT
printf 'FROM %s\nPARAMETER num_ctx %s\n' "$MODEL" "$CTX" > "$MODELFILE"
# `ollama create` over an existing tag replaces it, so the profile always tracks
# the weights that were just pulled instead of silently pinning the old blob.
ollama create "$PROFILE" -f "$MODELFILE"
rm -f "$MODELFILE"
trap - EXIT

say "After: same measurement, new runtime + new weights"
measure "$CTX" "$MODEL" "new runtime"
measure "$CTX" "$PROFILE" "managed profile"

cat <<'NOTE'

==> Read the numbers, not the version strings.
    Compare "current runtime" against "new runtime" above. A faster Gemma should
    show up as tok/s, or as a smaller CPU share in the PROCESSOR column, or both.
    If neither moved, the upgrade did nothing measurable on this box and should be
    reported that way.

    Still unmeasured here: prompt-eval time on a genuinely long prompt. These runs
    use a short prompt, so they time generation only. With part of the model on
    CPU, filling 100k tokens costs real time BEFORE the first token appears.
NOTE
