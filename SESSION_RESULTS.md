# Session results — monitoring + benchmark + proven train→improve loop

## ✅ Built this session
- **System Monitor** (`/monitor` + `/api/sysinfo`): live CPU, RAM, GPU, VRAM, temps (CPU/GPU/NVMe),
  and which model the inbox's Ollama has loaded. Updates every 2s, color-coded (amber ≥70%, red ≥90%).
- **Benchmark** (`/benchmark` + `/api/bench`): auto-graded suite to qualify a model. Categories:
  `math` (general capability) and `lore` (a fictional domain the base can't know). Reports score,
  per-category, and tok/s.

## 🎯 Proven: qualify → improve → re-qualify (the core "will of the system")
Same 0.5B model, before vs after a targeted fine-tune:

| model | math | lore | total |
|---|---|---|---|
| qwen05b-base (untrained) | 4/5 | **0/8** | 4/13 |
| aether-05b (fine-tuned on the lore) | 4/5 | **8/8** | **12/13** |

Training drove the targeted slice **0/8 → 8/8** while general math held **4/5** — and the benchmark
detected it. The full loop works end to end on this machine. Both models are in **Library → Models**
(and selectable in Chat / Benchmark).

## ⚠️ The single-GPU reality (now visible in Monitor)
The inbox's `gemma4:12b` reloads on its schedule and fills **VRAM (~84–92%)** + RAM. While it's
resident, our **GPU training OOMs**. This session that forced the fine-tune onto **CPU** (~16 s/step
for a 0.5B → ~40 min for 150 steps). Lesson: when the inbox holds the 12B, our heavy GPU work has to
wait or run on CPU. The Monitor page makes this state obvious at a glance.

## 🔧 Fixes applied so the Train page is robust
- `/api/train` now **auto-falls back to CPU** if the GPU run fails (e.g. inbox using VRAM), instead
  of crashing.
- It **surfaces the real error** (captures stderr tail) on the page instead of a silent "failed".
- So a training started from **/train now works under contention and shows the live loss curve**.

## Next (when you're back)
- Run the same loop with a **1–2B** base (your last fractal attempt) — design the fractal data + the
  benchmark slice that would reveal structural transfer. (GPU training of 1–2B needs the inbox's 12B
  to be unloaded — watch Monitor, or we schedule around it.)
- Deepen the benchmark (code-execution tasks, larger item counts, side-by-side compare view).
