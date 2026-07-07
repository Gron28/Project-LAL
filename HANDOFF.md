# Handoff — Beat Gemma 12B with Qwen3-4B

**Goal:** fine-tune Qwen3-4B to beat locally-hosted Gemma 12B (Ollama) on every suite of a
6-suite battery, and run faster. Then optionally scale to 7-8B.

## 🛠️ 2026-07-07 — collapsible global sidebar SHIPPED

Left nav rail (`w-14 lg:w-44`, always-on) was eating a lot of laptop-width screen.
Added a full hide/show toggle: `web/src/app/nav-shell.tsx` (new client wrapper) holds
`collapsed` state (localStorage `nav_collapsed`), renders `<Nav>` + the content
padding div together so both react to one source of truth; `nav.tsx` now takes
`{collapsed, onToggle}` — collapsed state renders NO rail at all (zero layout space)
plus a small floating chevron button (`fixed left-2 top-3`) to bring it back;
expanded state gained a "hide" button at the rail's bottom. `layout.tsx` now renders
`<NavShell>{children}</NavShell>` instead of `<Nav/>` + a hardcoded padding div.
Mobile's bottom tab bar is untouched (this was a desktop-only complaint).

**Cross-cutting gotcha**: `/code`'s own fixed elements (composer bar, tree sidebar)
hardcode `md:left-14 lg:left-44` to sit beside the global rail — collapsing the rail
without updating those would leave a dead gap instead of reclaiming space. Fixed via
a new `web/src/app/nav-context.tsx` (`useNavCollapsed()`) that `code/page.tsx` reads
to drop those offsets to 0 when the rail is hidden. **Any other page with its own
fixed-position elements referencing the rail's width needs the same treatment** —
none currently exist besides `/code`, but check before adding one.
Verified: rail fully disappears, composer's computed `left` is `0px` when collapsed,
persists across navigation + reload, mobile bottom bar unaffected, re-expand works.

## 🛠️ 2026-07-06 (2) — /code mobile fixes + clone-repo + run/preview SHIPPED

Follow-up request (remote, via tailscale — `https://main-pc.tail3ba909.ts.net:8443/code`):
make /code mobile-friendly, add easy repo cloning, and a way to host/visually see a
project while it's being worked on. All three shipped and verified live.

- **Mobile fixes** (headless-viewport-verified, iPhone 390×844): DirPicker's footer
  (path input + select button) was clipped off-screen — a flexbox `min-height:auto`
  default let the scrollable directory list expand past `max-h`, pushing the footer
  out; fixed with `min-h-0` on the scroll region + `shrink-0` on the fixed sections +
  switched `max-h-[80dvh]`→`max-h-[85vh]`. The chat's floating "jump to latest" pill
  (z-40) was leaking visually over the full-screen mobile editor (z-30, since
  explicit z-index always wins over DOM order regardless of magnitude relationship
  to a differently-scoped stacking context) — hidden below `lg` while `openFile` is
  set. File-tree row tap targets bumped `py-0.5`→`py-1`.
- **Clone repos from the UI**: DirPicker gained a CLONE tab (same directory browser,
  navigate to a parent folder, paste a remote URL — name auto-fills from the URL,
  editable). `POST /api/agent/git {op:"clone"}` — hardened against git argument
  injection: URL must match `SAFE_CLONE_URL` (blocks `file://` and flag-injection
  strings), folder name must match `SAFE_NAME` (`[A-Za-z0-9._-]+`), and the actual
  spawn uses `git clone -- <url> <name>` (the `--` is defense in depth on top of the
  regex). Own runner (`cloneRepo`, 180s timeout) since `runGit`'s cap is 30s. Verified
  end-to-end: cloned `octocat/Hello-World` into `~/Desktop`, UI auto-switched the
  active project to it.
- **Run + preview a project while it's being worked on**: new "run" tab in the /code
  sidebar (`web/src/components/code/run-panel.tsx`) backed by
  `web/src/app/api/agent/preview/route.ts` — starts the project's dev command
  (`npm run dev`, etc.) as a managed detached background process (log ring buffer,
  start/stop), and — the actual "host it" part — calls `tailscale serve --bg
  --https=<port> http://127.0.0.1:<port>` (`web/src/lib/tailscale.ts`) so the exact
  same port is reachable from **any tailnet device** at
  `https://main-pc.tail3ba909.ts.net:<port>`, no manual tailscale config needed. One
  preview at a time (mirrors the GPU single-tenant precedent — simpler than juggling
  multiple serve mounts); starting a second while one runs gets a 409. Verified live:
  `python3 -m http.server 3900` → tailscale confirmed the mount
  (`serve --https=3900 off` printed to tear down), local fetch 200, stop cleanly
  removed both the process and the tailnet mount. Best-effort iframe preview + copy
  link + open-in-new-tab in the panel.
- **Confirmed**: this box's OS user can run `tailscale serve`/`tailscale status`
  without sudo — no credential plumbing needed for the preview feature.

## 🛠️ 2026-07-06 — /code repo integration + UI file editing SHIPPED; Gemma speed work

**North star reframed (memory: self-recreation-vision):** the lab is becoming a self-improving
local Claude-Code replacement — the acid test is telling it "integrate Kiwix from that hard
drive" and having it safely modify its own code. Kiwix EXISTS on a currently-disconnected HDD
(future `local_search` grounding organ — do not build until connected). Feature decisions
should be scored against "does this close the self-modification loop."

**Shipped (built, headless-browser-verified live on 8770):**
- **`/api/agent/fs`** — project-confined list/read/write for the /code UI (reuses
  `resolveSafe`); PUT has an mtime handshake → 409 on conflict so human and agent edits never
  silently clobber each other (verified: create → stale-mtime 409 → correct-mtime 200).
- **`/api/agent/browse`** — $HOME-confined dirs-only listing for the new project picker
  (/etc → 403 verified). **`/api/agent/git`** — status/diff/commit with fixed argv shapes
  (runGit now exported from tools.ts); untracked files diff via `--no-index /dev/null`.
- **/code UI**: left sidebar (files tree + git tab, lazy-loaded, `fsTick` auto-refresh when
  agent tool_results touch files), right CodeMirror 6 editor pane (dynamic import only — never
  static-import CM in page.tsx; Ctrl+S; conflict/changed-on-disk banners), DirPicker modal
  replacing the window.prompt project picker. Layout rule respected: panels reflow the chat
  via PADDING on an outer wrapper only — chat keeps window scrolling (stick/jump logic intact).
- **Project persisted per conversation** (`Convo.project`, saved in loop snapshot, restored in
  openConvo with missing-folder fallback + inline warning; sessions dropdown badges the folder).

**Gemma speed (task in flight):** root cause confirmed = gemma4:12b (7.6GB Q4_K_M) + f16 KV
doesn't fit 8GB VRAM → `ollama ps` shows **24%/76% CPU/GPU split** → baseline measured
**12.9–13.9 tok/s decode** (fixed 512-tok story prompt, cold+warm). Fix staged but NOT applied
(needs sudo): `/etc/systemd/system/ollama.service.d/perf.conf` with `OLLAMA_FLASH_ATTENTION=1`
+ `OLLAMA_KV_CACHE_TYPE=q8_0`, then daemon-reload + restart ollama, re-measure same prompt
(script: scratchpad gemma_bench.py — 512-tok story, temperature 0). Rollback if RDNA2 FA
regresses. If the split barely moves, next lever is dropping ~2 layers' worth of KV by
capping num_ctx, or accepting e4b (47–62 tok/s, also vision-capable) for vision calls only.

## 🧭 2026-07-04 night — separate track: agentic workflow modes + orchestrator (not started)

The user wants toggleable `/code` agent modes (default/quick-edit/planning/deep-research) plus
an experimental "orchestrator" mode: a context-light coordinator that delegates through a
researcher→planner→red-team→planner→iterate→presentation pipeline using sub-agents of
DIFFERENT model sizes (8B down to 0.5B), each getting only the context it needs, with a
digest/summarizer step so nothing downstream needs full raw transcripts. Explicitly framed as
slow-but-fine, opt-in, for overnight hard-project runs — not the default path.
Full research + current-codebase analysis + a recommended (not decided) scoping is written up
for a fresh model to pick up cold: **`docs/orchestrator-research.md`**. Read that before
touching this — it covers what already exists (`spawn_agent` in `agent-tools.ts` already does
single-level context-isolated delegation), external research (orchestrator-worker is the
dominant 2026 pattern; a formal paper explains why star topologies of agents saturate and a
hierarchy avoids it; model-cascade routing literature), and this box's hard constraints
(single-tenant 8GB GPU, model swaps aren't free, RAM is 15GB).

## ⚡ 2026-07-04 REALITY-GAP PIVOT (read this first — supersedes the victory framing below)

The user revealed the battery was Goodharted: his private blind test ("code a snake game in
HTML", one-shot) shows **Gemma 12B beautifully aces open-ended webapp generation while every
Qwen (4B/8B) is mediocre** — the saturated coding suite (20/20 both) measured the wrong thing.
**HARD RULE: snake must NEVER appear in training data or any suite — it stays his blind probe.**
Other locked decisions: speed gate = raw decode tok/s; victory bar = ≥ everywhere + faster
(ties at ceiling count); images route to Gemma as the agentic app's vision backend (training
stays text-only Qwen3-8B). Plan: `~/.claude/plans/lovely-cuddling-storm.md`.

**Built tonight (all verified):**
- **webgen suite** (7th suite, in battery + seeds): 12 one-shot webapp tasks (pong, breakout,
  minesweeper, todo, calculator, …) with 1-3 contract ids each; graded in headless Chrome
  (`gradeWebgen` in graders.ts, puppeteer-core + system google-chrome): error gate + per-item
  `probes` JS (partial credit in detail) + **screenshot per run** shown in the benchmark UI
  (`/api/webshot?id=`). Grader validated: reference apps pass, broken/no-HTML fail.
- **First sweep (budget 6144) reproduced the felt reality: Gemma 9/12, stock qwen3:8b 4/12.**
  8 of 8B's fails = "no HTML found": it burned the entire budget inside <think> (half never
  emitted a line of code) or truncated mid-file. That's bug-genus #11 AND real usage at once.
  → canonical re-sweep at maxTokens 16384 (adaptive num_ctx in both bench paths now) with a
  qwen3:8b think:false variant running as of this writing; if no-think 8B scores well, the
  webgen training format answer is "skip/shorten think".
- **q4 pipeline**: convert() now llama-quantizes to Q4_K_M after GGUF; local model discovery
  prefers `-q4.gguf`; victory3 + qwen3-4b-stock quantized (8.1GB→2.5GB, VRAM-resident).
- **finetune_hqq.py**: HqqConfig quantize-on-load (transformers 5.12 has it; old comment was
  stale) — no more 16GB fp16 CPU materialization for the 8B on the 15GB box. `--legacy_load`
  keeps the old path. Smoke test still pending (GPU busy with sweep).
- **Data landed**: `data/webgen_sft.jsonl` (17 Claude-authored exemplar apps, disjoint from
  the suite, ALL pass the real grader — generator: `web/scripts/gen_webgen_data.ts` +
  task registry `web/scripts/webgen-train-tasks.ts`; teacher mode for Gemma queued to run
  after the sweep); `data/toucan_agentic.jsonl` (300 judge-filtered, length≤512-token,
  Qwen3-32B-generated tool traces from Toucan-1.5M, converted to our {messages,tools} shape);
  `data/openr1_math_short.jsonl` (300 Math-Verify-verified R1 think-traces ≤1024 tokens —
  only ~8% of the dataset is that short; drop-don't-truncate).
- **runBench**: `temperature` opt; ollama path now sets num_ctx (was silently 4096 —
  truncation artifact); local path grows llama-server ctx for long-generation suites.

**Next when GPU frees**: read canonical sweep (Gemma vs 8B think vs 8B no-think vs 4B vs
victory3) → decide webgen train format → 3-step HQQ smoke on Qwen3-8B → build mix v4
(webgen_sft + toucan + openr1 + planning_hard 250 + gsm8k:200 + agentic_sft:150, NO generic
instruct/coding) → run 1 with autoBench all 7 suites.

## ⚡ 2026-07-04 morning — victory4-8b LAUNCHED (finetune_hqq rewritten to fit the box)

**Run live**: `victory4-8b` via the app (port **8770** — port 3000 is the OLD inbox app with
auth, don't post there), Qwen3-8B + victory_mix4_8b.jsonl, steps 2500, lr 5e-5, patience 500,
val_frac 0.1, autoBench all suites. ~698 train / 75 val blocks at block 1024 (433 over-length
rows dropped — see below).

**finetune_hqq.py was unusable for 8B as written; it took 5 fixes (all smoke-tested end-to-end,
merge verified tensor-by-tensor against base):**
1. **HqqConfig quantize-on-load raises NotImplementedError** in transformers 5.12 (HQQ not
   ported to the new core_model_loading). `--legacy_load` (full fp16 on CPU) drove the 15GB box
   to 9.4GB swap → kernel OOM killer territory. Replaced BOTH with a shard-streaming loader:
   init on meta, stream safetensors shards, HQQ-quantize LoRA-target linears straight onto GPU.
   Peak CPU RAM ≈ 1 shard.
2. **Do NOT quantize lm_head**: HQQ's PYTORCH backend dequantizes the whole 1.16GB head on
   EVERY forward — costs more peak VRAM than it saves (and its proximal optimizer OOM-killed
   the box when run on CPU: several fp32 copies of a 2.5GB tensor).
3. **Chunked cross-entropy** (`chunked_ce_loss`): at block 1024 Qwen3's 151k vocab makes
   full-sequence logits ~1GB fp32 — the single biggest transient. Body forward once, then
   lm_head+CE per 256-token chunk under gradient checkpointing. Val uses it too.
4. **Embeddings serve from CPU RAM** (`CPUEmbedding`): row-gather is trivial on CPU; frees
   1.2GB VRAM. That's the margin that let step 2 survive AdamW's lazy ~350MB state allocation.
5. **Streaming merge** (`stream_merge_and_save`): folds LoRA deltas into the ORIGINAL fp16
   shards one shard at a time (never the quantized copy, never 16GB resident). Index json gets
   a real total_size.
   Resulting VRAM during training: ~5.7GB of 8GB. ~8-15s/step at block 1024.

**Data finding — victory_mix4_8b.jsonl was silently truncation-poisoned**: the old default
block 512 mid-answer-truncated ~46% of the mix (webgen median 935 tok, openr1 median 1587,
toucan p90 5884). Trainer now **drops** over-length rows instead of truncating
(`dropped_overlength` in the model event) and block defaults to 1024. Still dropped: 433/1206
rows incl. ~⅓ of webgen exemplars — **consider a block 1536-2048 test or splitting long
exemplars before run 2.**

**Ops notes**: kernel OOM killer was the mystery killer of background trainer runs (check
`journalctl -k` for "Out of memory: Killed process"); `rocm-smi`/`rocminfo` aren't installed —
read VRAM via `/sys/class/drm/card*/device/mem_info_vram_used`.

**Bug-genus alert — the `target_loss` converged gate is bs=1-EMA-flawed like the old plateau
gate was**: first victory4-8b launch "converged ema 0.090" at step 173/2500 (a quarter of one
epoch) while val was still falling 0.50→0.28→0.24. The 8B's losses run low enough that a lucky
streak of short rows drags EMA under 0.1. Relaunched with `targetLoss: 0` (gate disabled;
val-aware plateau patience is the stop condition). Consider making convergence val-gated in
the trainer before anyone trusts the default 0.1 again.

**Second instance of the same genus — the plateau patience gate has a live blind spot**: by
step 1500/2500 (epoch 2-3, 698 unique rows), val loss climbed 0.1755(best,step700)→0.19→0.22→
0.25 — textbook memorization/overfitting — while `best_step` kept resetting because the raw
per-example EMA hit new lows (0.02-0.09) from memorizing repeated rows, masking the val
regression from the `step - best_step >= patience` check. The dual-criterion design (val OR
EMA improvement resets the clock) protects against stale-EMA-overrides-real-val-progress but
has no protection against the reverse: EMA memorization masking real val degradation
indefinitely. Didn't intervene — best-val checkpoint (step 700) is what gets merged regardless
of how long training continues past it, and a manual stop via the app's `stopTrain()` SIGKILLs
the process (`train.stopping=true` before kill skips the done()-handler, so merge/GGUF/quantize/
autoBench never fire) — cheaper to let it run out the step budget than to hand-reproduce that
pipeline. **Fix before run 2**: gate patience on val-only once val_frac>0, or track best_step
separately per-criterion so EMA can't paper over val regression.

**victory4-8b RESULT (early-stopped step 2124/2500 on plateau, best-val checkpoint step 700,
val 0.1755)** — full autoBench vs Gemma 12B / stock qwen3:8b:

| Suite | Gemma | Stock 8B | victory4-8b |
|---|---|---|---|
| coding | 20/20 | 20/20 | 20/20 (tie) |
| planning | 4/14 | 6/14 | **10/14** — best of any model tried, any size |
| agentic | 6/8 | 7/8 | **8/8** |
| instruct | 15/15 | 15/15 | 14/15 (-1) |
| gsm8k | 53/60 | 53/60 | 51/60 (-2) |
| capability | 30/31 | 30/31 | **31/31** — beats ceiling |
| webgen | **9/12** | 4/12 | 8/12 — +4 over stock, still -1 vs Gemma |
| speed | 13-25 tok/s | 42-49 tok/s | 28-42 tok/s |

Not a full victory (webgen/instruct/gsm8k still below Gemma by 1-2), but real progress on the
two suites this run targeted (planning, webgen). **Next experiment**: 433/1206 mix rows were
dropped for exceeding block 1024 (incl. ~1/3 of webgen exemplars) — try a larger block (VRAM
headroom exists: training ran at 5.7GB/8GB) to recover them, and check whether instruct/gsm8k
dip is mix-composition or run-variance before concluding anything.

Full original plan + addendum: `~/.claude/plans/i-have-been-experimenting-tidy-garden.md`
(5 phases: benchmark battery → training upgrades/data → dashboard → agentic chat → victory loop).

## Where things stand

| Phase | Status |
|---|---|
| 0 — tool-call spike | done |
| 1 — benchmark battery v2 | done |
| 2.0 — fix planning suite + re-baseline | done |
| 2.1 — trainer v2 (val split, checkpoints, resume, tool-trace encoding) | done, live-verified |
| 2.2 — auto-bench after training | done, live-verified |
| 2.3 — distillation data | **in progress** — see below |
| 3 — modular dashboard | done |
| 4 — agentic chat | not started |
| 5 — victory loop (goal-gap widget) | not started |

## Current baselines (champion Gemma 12B vs challenger stock Qwen3-4B, pinned)

| Suite | Gemma 12B | Qwen3-4B stock | Read |
|---|---|---|---|
| coding | 20/20 | 19/20 | nearly closed |
| planning | 4/14 | 6/14 | **challenger already ahead** |
| agentic (tool-use) | 6/8 | 7/8 | challenger already ahead |
| instruct | 15/15 | 11/15 | **real gap — main training target** |
| gsm8k | 53/60 | 53/60 | tied (regression control) |
| capability | 30/31 | 30/31 | tied (regression control) |

Stock Qwen3-4B already ties/beats Gemma on 4 of 6 suites before any training. Only instruct
is a confirmed real gap.

## What's built (all live in the app, not just code)

- **Benchmark battery** (`web/src/lib/graders.ts`): substring/numeric/exec/checks/tools graders.
  `tools` grading runs the exact production tool-executor + tool-loop (`web/src/lib/tools.ts`,
  `toolloop.ts`) — the benchmark measures the real product surface, not a mock.
- **Suite versioning**: every suite has a `rev`; pinned results store `pinnedRev`; stale pins are
  flagged in the UI when a suite changes. Don't silently trust an old pin after editing a suite.
- **`scripts/finetune_sft.py` v2**: `--val_frac` (hash-split, deterministic), epoch-shuffled
  sampling, `<out>_ckpt/{best,last}` checkpoints, `--resume`, multi-turn/tool-call encoding
  (loss-masks to assistant spans only, located via ChatML `<|im_start|>assistant...<|im_end|>`
  markers — prefix-diffing does NOT work for Qwen3 because its template strips `<think>` from
  prior turns).
- **Auto-bench**: `startTrain({autoBench: string[]})` in `web/src/lib/lab.ts` runs the battery
  right after GGUF conversion, before freeing the GPU. Train page has a checkbox for it.
- **Dashboard** (`/`, chat moved to `/chat`): hand-rolled drag/resize grid, 12 widget types incl.
  quick-chat/quick-train/quick-bench (trigger real actions without leaving the dashboard), a
  suite-wide filter dropdown, SSE-pushed live data (`/api/dashboard/stream`).
- **Data generators**:
  - `scripts/distill_gemma.py` — teacher = Gemma 12B via Ollama; modes `instruct`/`planning`/
    `coding`; every sample verified before inclusion (instruct via the same `checks` logic the
    benchmark uses; coding via actual execution; planning via gold-answer substring match).
    Task pools are randomized and disjoint from the bench suite items.
  - `scripts/gen_agentic_data.py` — verified-by-construction tool-call traces, no teacher needed.
    `data/agentic_sft.jsonl` (400 rows) already generated.

## In progress right now (updated 2026-07-03 night)

**The 8B track is live and the baseline is in.** Stock `qwen3:8b` (Ollama q4, fits 8GB VRAM
entirely) vs the pinned Gemma champion, all measurement artifacts fixed:

| Suite | Gemma 12B | victory3 (our best 4B) | **stock qwen3:8b** |
|---|---|---|---|
| instruct | 15/15 | 14 | **15/15 (tie, maxed)** |
| coding | 20/20 | 16 | **20/20 (tie, maxed)** |
| planning | 4/14 | 7 | **6** |
| agentic | 6/8 | **8/8 (×5 runs)** | **7/8** |
| gsm8k | 53/60 | 47 | **53 (tie)** |
| capability | 30/31 | 29 | **30 (tie)** |
| speed | 13-25 tok/s | 21-28 | **42-49 (3-4×)** |

Stock 8B already ≥ Gemma everywhere and dramatically faster. Next: a light mix-v3-style
fine-tune of `Qwen/Qwen3-8B` (finetune_hqq handles it) to convert ties/gaps into strict wins —
planning (best lever: by-construction data took the 4B to 7-8), agentic (victory3's traces
prove the data), the one instruct no-punct item. Pipeline gap to close first: fine-tuned 8B →
f16 GGUF is 16GB (won't fit VRAM); add a llama-quantize→q4 step after conversion.
Also: victory3-f16 (8.1GB) itself spills VRAM — quantizing it to q4 would raise its tok/s.

## Three 4B training iterations — scoreboard + what they taught (2026-07-03)

| Suite | Gemma | Stock 4B | victory1 | victory2 | victory3 |
|---|---|---|---|---|---|
| instruct | 15/15 | 11 | 14 | 12 | 14 |
| coding | 20/20 | 19 | 16 | 15 | 16 |
| planning | 4/14 | 6 | 7 | 8 | 7 |
| agentic | 6/8 | 7 | **8/8 ×3** | 8/8 | 8/8 |
| gsm8k | 53/60 | 53 | 46 | 44 | 47 |
| capability | 30/31 | 30 | 30 | 30 | 29 |

**The big lesson — think-displacement (measured, reproducible):** SFT rows whose assistant
content answers immediately teach Qwen3 to skip its native `<think>` deliberation. The tell is
tok/s: stock runs gsm8k at ~12 tok/s (long deliberation, 53/60); every fine-tune (including the
older sovereign/balanced) runs ~27-29 tok/s (little/no thinking, 44-48/60). Wrapping training
CoT inside `<think>...</think>` (mix v3) recovered +3 but taught *brief* thinking, not stock's
deep deliberation — the ~78% no-think majority of the mix still dominates. Corollary: the
speed gate punishes deliberation; decide whether it should mean raw throughput instead.

**Data-format-matching principle (validated):** sources whose format matches how the bench
exercises the model WIN (agentic traces → 8/8 three times; by-construction planning → beats
Gemma every run). Sources with mismatched style LOSE (MBPP's untyped terse style made coding
worse; no-think math made gsm8k worse). Match each suite's think mode and answer style.

**Data pipeline (all teacher-free or verified):** `import_hf_data.py` (Tulu-3 IF, 37% of
checkable rows fail own constraints — filter caught them), `import_gsm8k.py` (train split,
think-wrapped), `gen_instruct_hard.py` / `gen_coding_hard.py` (16 typed bench-style families)
/ `gen_planning_hard.py` (all verified-by-construction), `import_mbpp.py` (retired from the
mix), `build_mix.py` (cross-source dedupe + train-on-test leak guard over BOTH suite stores —
it caught real leaks incl. distill_gemma's coding pool overlapping the bench). Gemma is
retired as a teacher; it remains only the benchmark champion.

## Bugs found + fixed this session (worth knowing before you repeat the work)

## Bugs found + fixed this session (worth knowing before you repeat the work)

1. **Cross-backend OOM**: switching from an Ollama-served model to a local llama-server model
   without unloading Ollama's resident model first blew past 15GB RAM and triggered a
   system-wide OOM kill (took out NetworkManager, systemd-resolved, etc. — recovered, but scary).
   Fixed in `lab.ts` (`stopOllama()` via `keep_alive:0` before switching backends).
2. **Runaway tool-loop generation**: no `max_tokens` cap on the interactive tool loop → a
   multi-round agentic item hung 9+ minutes generating unbounded tokens. Fixed with per-round
   caps threaded through `runToolLoop`.
3. **`best_val` reset on `--resume`**: v2 trainer's val-loss tracking wasn't persisted across
   `--resume`, so the first post-resume validation always "won" and could overwrite a genuinely
   better checkpoint with a worse one. Fixed — `best_val` now round-trips through `state.json`.
4. **Planning suite was silently broken**: `think:true` + `maxTokens:400` meant Gemma errored on
   Ollama's `think` param (empty replies) and Qwen3 burned the whole budget inside `<think>`
   before answering — both scores were artifacts, not real signal. Fixed by raising the budget
   and re-baselining (bumped suite `rev`, so the old pin is correctly flagged stale).
5. **ROCm needs `HSA_OVERRIDE_GFX_VERSION=10.3.0`** set when spawning the Python trainer directly
   (this AMD GPU isn't in torch's arch table otherwise). `lab.ts` sets it when spawning via the
   app; if you invoke `finetune_sft.py` by hand, set it yourself or it'll silently mis-detect
   the GPU arch (though it still often works — HIP errors are inconsistent about surfacing).
6. **`HSA_ENABLE_SDMA=0` is also required** — the SDMA copy engine page-faults on this RDNA2
   card during HQQ's layer-by-layer host→VRAM transfers (kernel: "Faulty UTCL2 client ID:
   SDMA0"; two training crashes before diagnosis). `lab.ts` sets both env vars now; set both
   for any hand-launched GPU python.
7. **GPU is single-tenant and the app now enforces it both ways**: `startTrain` unloads
   EVERYTHING Ollama has resident (`unloadOllamaAll`) before spawning the trainer, and
   `ensureServing` refuses (pgrep guard) while any CLI-started trainer is alive — a user chat
   respawning llama-server mid-quantization page-faulted a run before this guard existed.
8. **CLI-started training is now visible in the app** (`externalTrainRun()` in lab.ts):
   dashboard/train pages show live progress + "running" status for trainers the app didn't
   spawn. LossChart x-axis anchors to the data window, not step 0 (dashboard tail is sliding).
9. **Trainer early-stop gates are val-aware** (both `finetune_sft.py` and `finetune_hqq.py`):
   plateau patience tracks smoothed EMA (a lucky raw bs=1 loss froze run 1 at 49% budget) AND
   resets on any val improvement (the EMA-only gate still stopped run 3 while val was hitting
   new bests). `finetune_hqq.py` is fully v2 now: val split, best-val checkpointing/merge,
   `--resume`, multi-turn/tool-trace encoding shared from finetune_sft.
10. **Shell gotcha for orchestration**: a `pgrep -f <trainer>` inside a monitoring/waiting
   shell matches its own command line — two "wait for trainer to exit" loops hung forever on
   themselves. Match on `'python[0-9.]* .*finetune'` or check pid files, and verify what
   pgrep actually matched before trusting it.
11. **Reasoning models get starved by token caps sized for non-reasoning models** (the third
   measurement-artifact bug of this genus, after the planning think-budget and the tool-loop
   512 cap): `runBench`'s single-shot default `maxTokens ?? 128` leaked into the tools-grading
   ctx, overriding gradeTools' own default — qwen3:8b hit finish_reason "length" mid-<think>
   on every agentic item and scored 0/8 while Gemma/victory3 (no thinking) passed untouched.
   Fixed: runBench passes the suite's own maxTokens (possibly undefined) to gradeItem;
   gradeTools defaults to 1536/round. Agentic suite rev bumped, champion re-pinned.
   **Rule of thumb: any 0/N score from a model that trivially does the task by hand = assume
   artifact; probe the model directly with curl before believing the bench.**

## The open question (updated after the strategic pass + 3 iterations)

The 2026-07-03 strategic pass answered the original question: Gemma is retired as teacher
(Claude-authored + HF-imported data, all filtered through the battery's own graders, replaced
it — plan: `~/.claude/plans/what-do-you-think-agile-backus.md`). Three 4B iterations later the
remaining open questions are:
1. **8B track** (now started, per the 3-red rule): does stock Qwen3-8B already beat Gemma
   where the 4B couldn't, and does the mix-v3 recipe close whatever remains?
2. **Deep-thinking restoration**: self-distillation (STaR-style — stock model generates its
   own verified `<think>` traces, train on those) is the untried lever for gsm8k/coding on
   either base; it removes the format-fight entirely.
3. **Speed gate semantics**: per-suite effective tok/s punishes deliberation; consider raw
   throughput instead before declaring any victory.
4. After victory: Phase 4 agentic chat (user-confirmed next), then Phase 5 victory loop,
   then the sovereign/flavor iteration (≤10% mix, regression-gated).
