# Porting this to your machine — read this first

**Audience: an AI coding agent (Claude Code or similar) setting this repo up on a
machine that is not the one it was built on.** A human pointed you at this file
because they want you to adapt the code to *their* hardware, not reproduce the
original machine's setup. Do that by probing their real hardware first, then working
through the checklist below — don't assume, don't copy numbers blindly.

## The machine this was built on (the OLD machine — probably not yours)

Everything hardcoded in this repo was tuned for exactly this box:

- **OS:** Linux
- **GPU:** AMD Radeon RX 6650 XT — RDNA2, `gfx1032`, presented to ROCm as `gfx1030`
  via an override (the real arch isn't in ROCm's support table) — **8GB VRAM**
- **System RAM:** 15.6GB total
- **One GPU, no NVIDIA/CUDA anywhere.** Every "cuda" check in the Python training code
  is real — PyTorch's ROCm build answers to the same `torch.cuda` API, so the code
  doesn't know or care that it's actually ROCm.
- **Installed Python stack** (there is no `requirements.txt` — this is what was
  actually in `.venv` on the old machine, read via `pip freeze`; treat it as a list of
  *what* was needed, not *which build* to install):
  ```
  torch==2.5.1+rocm6.2
  pytorch-triton-rocm==3.1.0
  bitsandbytes  (special ROCm continuous-release wheel, NOT the PyPI package)
  hqq==0.2.8.post1
  peft==0.19.1
  transformers==5.12.1
  ```

## The mindset that matters more than any single fix

**Every quantization trick, batch-size cap, and chunking hack in the training code
exists for one reason: fitting model training inside 8GB of VRAM and 15GB of system
RAM.** They are scarcity workarounds, not the "correct" way to train. If the machine
you're setting this up on has more VRAM (true of almost any current NVIDIA card —
12GB/16GB/24GB is normal) and/or more RAM, **these constraints should be relaxed or
removed, not inherited.** A better GPU should train bigger batches, skip the 4-bit
quantization dance, and go faster — not stay artificially throttled to match a
$200 8GB AMD card from an old build. Don't treat the numbers below as sacred; treat
them as "here's what was true of the old box, now go find out what's true of this
one."

## Step 1 — probe the real machine before touching any code

Run these and note the results. Don't guess.

- **GPU + VRAM:**
  - NVIDIA: `nvidia-smi --query-gpu=name,memory.total --format=csv`
  - AMD/Linux: `rocm-smi --showproductname --showmeminfo vram`
  - Mac: `system_profiler SPDisplaysDataType`
  - Windows (no ROCm/CUDA installed yet): Device Manager → Display adapters, or `wmic path win32_VideoController get name`
- **System RAM:** `free -h` (Linux) · Task Manager → Performance (Windows) · `sysctl hw.memsize` (Mac)
- **OS + arch:** `uname -a` (Linux/Mac) · `ver` / `systeminfo` (Windows)
- **CPU cores:** `nproc` (Linux) · `sysctl -n hw.ncpu` (Mac) · `echo %NUMBER_OF_PROCESSORS%` (Windows)

Compare the result against the "old machine" spec above. That delta is what you're
actually porting for.

## Step 2 — everything that assumes the old machine, by concern

### A. GPU backend / training env vars
- `web/src/lib/lab.ts`, function `gpuTrainEnv()` — sets `HSA_OVERRIDE_GFX_VERSION`,
  `HSA_ENABLE_SDMA`, `PYTORCH_HIP_ALLOC_CONF`. These are **ROCm/HIP-only** — CUDA and
  CPU torch ignore them, so this function is harmless as-is on NVIDIA. Override any of
  them without touching code via `GPU_TRAIN_ENV='{"KEY":"value"}'` in the environment,
  or just leave them if you're not on AMD (they'll no-op).
- **`.venv`'s torch build must match your GPU vendor.** The old machine has
  `torch==2.5.1+rocm6.2`. On NVIDIA, install the matching CUDA build from
  [pytorch.org](https://pytorch.org/get-started/locally/) instead (e.g.
  `torch` + `--index-url https://download.pytorch.org/whl/cu121`, whatever CUDA
  version your driver supports). On CPU-only, install plain `torch`. There's no
  `requirements.txt` to just re-run — rebuild `.venv` for your platform.
- **bitsandbytes**: the old machine uses a special ROCm *continuous-release* wheel
  (not the normal PyPI package — ROCm 4-bit support isn't in mainline releases).
  **On NVIDIA, just `pip install bitsandbytes` from PyPI** — it's natively supported
  and better maintained than the ROCm workaround; prefer it over reproducing the
  ROCm-specific path in `scripts/finetune_qlora.py`.
- `scripts/fakebin/rocminfo` — a shim that fakes `rocminfo`'s output so bitsandbytes'
  arch-detection sees a supported gfx target on this specific AMD card. Irrelevant
  outside ROCm; delete or ignore it on other platforms.
- `HQQBackend.PYTORCH` is selected explicitly in `scripts/check_hqq.py` and
  `scripts/lens.py` because it's "ROCm-safe" (a pure-PyTorch dequant path). On CUDA,
  HQQ may have a faster backend available — check HQQ's docs before assuming
  `PYTORCH` is still the right choice.

### B. VRAM-budget workarounds (all tuned for 8GB)
- `scripts/finetune_hqq.py` is *entirely* an 8GB-VRAM survival strategy: a streaming
  shard loader that quantizes layer-by-layer instead of materializing the full model,
  chunked cross-entropy loss (256-token chunks to avoid one giant logits tensor),
  CPU-resident embeddings, and a streaming merge step. **On a GPU with real headroom
  (16GB+), a plain LoRA/QLoRA fp16 run without any of this is likely simpler and
  faster.** Don't port the complexity by default — check if you still need it.
- `scripts/finetune_sft.py:141` — batch size defaults to `1` specifically to keep
  big-vocab logits small on 8GB. Raise it if VRAM allows.
- `scripts/finetune.py` — auto-caps sequence block length to 128 and batch size to 1
  for any model over 2B params, purely to fit 8GB. Arbitrary on a bigger card.
- `web/src/lib/lab.ts` — the GPU-offload fallback ladder for serving
  (`[configuredNgl, 24, 12, 0]` layers) assumes an 8GB card's specific failure points.
  A bigger card may never need to drop below full offload.
- Scattered comments in `web/src/lib/lab.ts` about "an 8B f16 is 16GB and spills the
  8GB card" drive automatic quantization-to-Q4 after training. Re-check whether
  quantization is even necessary if your card can hold f16/bf16 directly — skipping
  it preserves more model quality.

### C. System-RAM-budget workarounds (tuned for 15GB)
- `scripts/finetune_hqq.py`'s header explains the shard-streaming loader exists
  because materializing an 8B model in fp16 on CPU (~16GB) pushed this 15GB-RAM box
  into swap. A machine with meaningfully more RAM may not need streaming at all.
- `web/src/lib/lab.ts` has an OOM-avoidance check keyed to "the whole machine
  (15GB...)" for when Ollama and a local GGUF are both resident. Re-derive the real
  threshold from your own RAM, not this number.

### D. Linux-only / filesystem assumptions
- `web/src/lib/sysinfo.ts` (System Monitor + dashboard hardware stats) reads
  `/proc/stat`, `/proc/meminfo`, and `/sys/class/drm/card1/device/*` +
  `/sys/class/hwmon/*` directly — Linux-only, and hardcodes the GPU as `card1` and
  looks for the AMD-specific hwmon sensor name `"amdgpu"` (CPU temp looks for
  `"k10temp"` (AMD) or `"coretemp"` (Intel)). **This already fails soft** — every
  reader is wrapped so a miss returns `null`/`—` instead of crashing the endpoint —
  so the app runs fine with blank stats. Replacing it with `nvidia-smi`-based reads
  (NVIDIA), Windows perf counters, or a cross-platform stats library is a real
  improvement but not a blocker.
- `web/src/lib/lab.ts` — `OLLAMA_STORE = "/usr/share/ollama/.ollama/models"` (used to
  read Ollama's GGUF blobs directly for the Library page). This is the Linux install
  path; Windows/Mac use different locations — check `ollama` docs for your OS and
  update the constant, or leave it — the feature just no-ops if the path is missing.
- `start.sh` / `web/run_web.sh` are bash — Linux/Mac only. On Windows, either run
  under **WSL2** (needs zero porting — it's Linux underneath) or write PowerShell
  equivalents. The Linux user-service source is tracked at
  `deploy/systemd/project-lal.service` and installed with
  `./scripts/install-project-lal-service.sh`; Windows would use Task Scheduler,
  or just run the app manually.
- GPU access is an OS/user permission concern. The current Linux owner belongs to
  the `render` group, so the tracked unit launches the web host directly instead
  of wrapping it in the old machine-specific `sg render` shell.

### E. llama.cpp serving binary
- `llama/llama-b9835/` (gitignored, not shipped in the repo — downloaded separately)
  is a **Linux Vulkan build**. Vulkan itself is vendor-agnostic (works on AMD/NVIDIA/
  Intel alike), but you still need a binary built for your OS: grab the matching
  release from [llama.cpp's releases](https://github.com/ggml-org/llama.cpp/releases)
  (Windows Vulkan build, or Mac — where the **Metal** build usually outperforms
  Vulkan on Apple Silicon) and point `LLAMA_DIR`/`LLAMA_SERVER` in
  `web/src/lib/lab.ts` at it.

### F. Ports
- App `:8770`, llama.cpp `:8099`, tailnet https `:8443`, Ollama `:11434` if used —
  all already overridable via env vars in `start.sh`. Only worth touching if
  something on your machine already uses one of them.

## Step 3 — decide per item, then verify

For each thing in Step 2, given what Step 1 told you about the real machine, pick
one:
1. **Leave it** — harmless/ignored on this platform (most of section A).
2. **Relax it** — this machine has more headroom than the old one, so the constraint
   should loosen (most of sections B and C — bigger batch size, bigger block length,
   skip quantization, skip CPU offload/streaming).
3. **Replace it** — platform-specific code that has no equivalent on this OS/GPU
   (sections D and E).

Then verify before trusting it: run a small training job to completion (a few dozen
steps on a small base model is enough to prove the backend/quantization path works),
confirm `/monitor` shows real numbers (or accepted blanks, if you skipped section D),
and confirm `/chat` and `/code` can serve a model. Don't declare it ported on
typecheck/build passing alone — none of the platform-specific failure modes here show
up at compile time.
