# Local AI Lab

Train and run your own local models on your own machine — no cloud, no shared daemon.

## The stack (decided + proven 2026-06-28)
- **Train:** `transformers` + `peft` LoRA on the GPU (`.venv`). Proven: Qwen2.5-0.5B
  learned new facts in 57s.
- **Convert:** `llama.cpp/convert_hf_to_gguf.py` → GGUF.
- **Serve:** **`llama.cpp` + Vulkan** (`llama/llama-b9835/llama-server`). Vulkan talks to
  the GPU directly, vendor-agnostic (AMD/NVIDIA/Intel all work through the same driver
  layer) — no CUDA/ROCm toolkit needed just to serve. OpenAI-compatible API.

### Why not Ollama
If you already run Ollama for something else (a scheduled job, another app), sharing its
daemon with this project causes GPU collisions/hangs. This project uses a **separate
engine (llama.cpp/Vulkan) on a dedicated port (8099)**, run **on-demand**, so it never
fights anything else on the box for the GPU.

### ⚠️ One-GPU discipline
If you have one GPU, don't run training and serving (and anything else that touches the
GPU) at the same time — that's what wedges a single card. Train in a burst → stop →
serve → stop. Keep it single-tenant. The app enforces this itself when it drives
training/serving; it only matters if you're running pieces by hand.

## Hardware & OS assumptions — read this before assuming it "just works" elsewhere

This was built and only ever tested on **one specific machine**: Linux, one 8GB AMD
RX 6650 XT (RDNA2 / `gfx1032`), a single discrete GPU. Concretely, that means:

- **Serving (llama.cpp + Vulkan)** is already GPU-vendor-agnostic — it should run as-is
  on NVIDIA/Intel GPUs and on Windows/macOS, given a matching llama.cpp build (the
  `llama/llama-b9835/` binary here is a Linux build; grab the right one for your OS/GPU
  from [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) or build it
  yourself, and point `LLAMA_DIR`/`LLAMA_SERVER` in `web/src/lib/lab.ts` at it).
- **Training** sets three ROCm/HIP-specific env vars (`HSA_OVERRIDE_GFX_VERSION`,
  `HSA_ENABLE_SDMA`, `PYTORCH_HIP_ALLOC_CONF`) for this exact card, in one place —
  `gpuTrainEnv()` in `web/src/lib/lab.ts`. On NVIDIA/CPU torch these vars are simply
  ignored (harmless), so training should work unmodified; on a *different* AMD card you
  may need a different `HSA_OVERRIDE_GFX_VERSION`. Override any of them per-machine
  without touching code: `GPU_TRAIN_ENV='{"HSA_OVERRIDE_GFX_VERSION":"11.0.0"}'` in the
  environment the app runs in, merged over the defaults.
- **System Monitor / dashboard hardware stats** (`web/src/lib/sysinfo.ts`) read Linux
  `/proc` and `/sys/class/drm|hwmon` directly (VRAM/GPU% via AMD's `amdgpu` sysfs
  entries specifically). This already degrades gracefully — every reader is wrapped so a
  failure returns `null`/`—` instead of crashing the endpoint — but on non-Linux or
  non-AMD it'll just show blanks for GPU/VRAM/GPU-temp. Swapping in `nvidia-smi` or a
  cross-platform stats crate is the natural next step for other GPUs; it's isolated to
  that one file.
- **`start.sh`, `web/run_web.sh`, `gpu.sh`-style launchers** are bash — Linux/macOS only.
  A Windows port means writing PowerShell/batch equivalents (or running under WSL2,
  which needs no porting at all since it's still Linux underneath).
- **Ports/paths**: app on `:8770`, llama.cpp on `:8099`, tailnet https on `:8443` — all
  overridable via env vars already (see `start.sh`); nothing else is hardcoded to this
  machine's filesystem layout except the training env vars above.

None of this needs a rewrite to try elsewhere — Vulkan serving, the benchmark, chat, and
the coding agent don't touch any of the AMD-specific code at all. Training and the
hardware monitor are the two places with real assumptions, and both are now isolated to
one function/file each so they're fast to adapt.

**Setting this up on a different machine (especially with an NVIDIA GPU)?** Point your
coding agent at [`PORTING.md`](PORTING.md) — it's written for an AI agent to read
directly: exact specs of the machine this was built on, every hardcoded assumption by
file/line, and a probe-your-hardware-first checklist so it adapts to *your* GPU and RAM
instead of copying an old 8GB AMD card's limits.

## Manual pipeline (for reference — the app automates all of this)
```bash
# 1) TRAIN (LoRA on your data; --merge writes a standalone model)
# on AMD/ROCm Linux, set the same env vars gpuTrainEnv() uses (see above):
HSA_OVERRIDE_GFX_VERSION=10.3.0 HSA_ENABLE_SDMA=0 \
  python scripts/finetune.py --base Qwen/Qwen2.5-0.5B-Instruct --data data/yourfile.txt \
  --out out/mymodel --steps 150 --merge

# 2) CONVERT to GGUF
source .venv/bin/activate
python llama/src/convert_hf_to_gguf.py out/mymodel \
  --outfile models/mymodel-f16.gguf --outtype f16

# 3) SERVE on Vulkan (dedicated port; first run compiles shaders once)
cd llama/llama-b9835 && LD_LIBRARY_PATH=$PWD ./llama-server \
  -m ../../models/mymodel-f16.gguf -ngl 99 --host 127.0.0.1 --port 8099

# 4) CHAT (OpenAI-compatible)
curl -s http://127.0.0.1:8099/v1/chat/completions \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":80}'
```

## What's here

Everything below is a real page in the app (`web/src/app/`), not a roadmap item:

- **Dashboard** (`/`) — live system stats, quick-chat/quick-train/quick-bench widgets,
  a per-suite capability radar, and training-run history in one drag/resize grid.
- **Chat** (`/chat`) — conversational chat over any served model, with web/document
  grounding toggles.
- **Code** (`/code`) — an agentic coding assistant with real tools (files, shell, a
  Python REPL, web research, image understanding, sub-agents), live telemetry
  (context fill, tok/s, GPU/VRAM/temps), and server-side persistent runs — start a
  task on one device, reattach to the same live run from another.
- **Hive** (`/hive`) — *experimental.* A durable multi-agent workflow runtime
  (plan → implement → verify → repair → report) with pause/resume/replay and a full
  provenance trail. Its own evaluation (`web/docs/hive-evaluation-2026-07-09.md`)
  found it doesn't yet beat a single capable model on task completion — the harness
  is solid, the worker prompting isn't there yet. See [`CHANGELOG.md`](CHANGELOG.md).
- **Train** (`/train`) — LoRA/QLoRA fine-tuning (HQQ 4-bit quantized training fits an
  8B model on a single 8GB GPU) with live loss/gradient charts and data-health views.
- **Library** (`/library`) — trained models, documents, chat history, training runs,
  experiments, and project folders in one place.
- **Bench** (`/benchmark`, `/lens`) — an auto-graded, multi-suite capability battery
  (coding, planning, agentic tool-use, math, instruction-following, web-app
  generation) that exercises the same production code paths the app itself uses, plus
  a logit-lens view into a checkpoint's internal token predictions.
- **Monitor** (`/monitor`) — live CPU/GPU/RAM/VRAM/temps, updated every 2s.

Full build history, real bugs found, and honest experiment results (including the
runs that *didn't* work) are in [`CHANGELOG.md`](CHANGELOG.md).

## Layout
- `web/` — the app itself (Next.js)
- `scripts/finetune.py` — LoRA trainer (emits JSON progress for a dashboard)
- `data/` — training inputs  ·  `out/` — merged HF models  ·  `models/` — GGUFs
- `llama/llama-b9835/` — llama.cpp Vulkan binaries  ·  `llama/src/` — converter
- `gpu.sh` — runs a command on the GPU venv with the gfx override

## Run the app (one click)

```bash
./start.sh                     # builds if needed, serves on :8770, opens the browser
./start.sh --install-launcher  # once: adds a double-clickable "Local AI Lab" icon
```

`start.sh` is self-contained: it installs web deps on first run, rebuilds only when the
code changed (a stale bundle is a known footgun — see [[deploy-restart-required]]),
frees the port from any old instance, exposes the app on your tailnet via
`tailscale serve` (so your phone opens the *same* live session at
`https://<your-tailnet-host>:8443`), then starts it and opens it. Stop with Ctrl-C.

- **App:** Next.js in `web/`, production `next start` on **:8770** (override `PORT`).
- **GPU serving** (llama.cpp, :8099) and **Ollama** (:11434) are launched **on demand
  by the app**, not by the script — and llama-server auto-unloads when idle.
- **Training, benchmarking, chat, and the coding agent** all live in the UI; the agent
  can even drive training itself. The `## Commands` block above is the same pipeline the
  app automates, kept for reference / manual runs.
