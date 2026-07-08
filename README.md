# Local AI Lab

Train and run your own local models on this machine (AMD RX 6650 XT), **independent of
the inbox app's Ollama** — no shared daemon, no collisions.

## The stack (decided + proven 2026-06-28)
- **Train:** `transformers` + `peft` LoRA on the GPU via **ROCm torch** (`.venv`,
  `HSA_OVERRIDE_GFX_VERSION=10.3.0`). Proven: Qwen2.5-0.5B learned new facts in 57s.
- **Convert:** `llama.cpp/convert_hf_to_gguf.py` → GGUF.
- **Serve:** **`llama.cpp` + Vulkan** (`llama/llama-b9835/llama-server`). Vulkan sees the
  card directly (no ROCm, no wedge). ~**194 tok/s** for 0.5B. OpenAI-compatible API.

### Why not Ollama
The inbox app uses Ollama daily on a schedule; sharing it caused GPU collisions/hangs.
This project uses a **separate engine (llama.cpp/Vulkan) on a dedicated port (8099)**,
run **on-demand**, so it never fights the inbox's jobs.

### ⚠️ One-GPU discipline
There is ONE 8GB GPU. Never run training (ROCm) and serving (Vulkan) and the inbox's
Ollama at the same time — that's what wedged the GPU. Train in a burst → stop → serve →
stop. Keep it single-tenant.

## Commands
```bash
# 1) TRAIN (LoRA on your data; --merge writes a standalone model)
sg render -c "bash gpu.sh python scripts/finetune.py \
  --base Qwen/Qwen2.5-0.5B-Instruct --data data/yourfile.txt \
  --out out/mymodel --steps 150 --merge"

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

## Layout
- `scripts/finetune.py` — LoRA trainer (emits JSON progress for a dashboard)
- `data/` — training inputs (.txt)  ·  `out/` — merged HF models  ·  `models/` — GGUFs
- `llama/llama-b9835/` — llama.cpp Vulkan binaries  ·  `llama/src/` — converter
- `tokens.css` — design tokens (match the Fractal Lab dashboard) for the future UI
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
