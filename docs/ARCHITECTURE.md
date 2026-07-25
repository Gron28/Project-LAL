# Project-LAL — what exists

Reference map of the repository as it actually is. Not a plan and not a promise:
`docs/PLAN.md` is the only plan. This file answers "where is the code that does
X" and "what will break if I touch it".

Produced 2026-07-24 by direct inspection. Every count in it was measured, not
recalled.

---

## 1. What Project-LAL is

A local AI lab and terminal agent. Two applications share one host:

- **The host** (`web/`) — a Next.js app on `:8770`. It owns model inventory,
  serving, the inference gateway, durable runs, and the browser UI.
- **The terminal client** (`apps/cli/`) — a fork of qwen-code, distributed as
  `lal`. It runs on this box and on Windows.

The boundary that defines the product: **tool execution stays on the client;
model inference and authenticated internet egress come from the owner host.**
A client keeps working offline against its last synchronized profile.

---

## 2. The spine

The path a normal CLI turn takes. Follow this before reading anything else.

```
  lal (terminal, Windows or Linux)
    │
    │  OpenAI-compatible chat completions
    │  apps/cli/packages/core/src/core/openaiContentGenerator/
    ▼
  http://<host>:8770/api/llm/v1/chat/completions
    │  web/src/app/api/llm/v1/chat/completions/route.ts
    │    · authorizes the device            (lib/lal-cli.ts)
    │    · acquires the single GPU lease    (acquireCliGpuLease)
    │    · resolves the model profile       (lib/lab.ts)
    │    · FILTERS the tool list            (LAL_TERMINAL_TOOLS, line 10)
    │    · compacts tool schemas            (compactTools, line 82)
    ▼
  llama-server (:8099, Vulkan)  ──or──  Ollama (:11434)
    │  spawned and supervised by web/src/lib/lab.ts
    ▼
  streamed tokens + native tool_calls
    │
    ▼
  back to the CLI, which executes tools LOCALLY
    apps/cli/packages/core/src/tools/   (83 files, 44k LOC)
```

Three facts about this path that explain most observed behavior:

1. **The gateway silently drops tools.** `route.ts:94` — `if
   (!LAL_TERMINAL_TOOLS.has(name)) return []`. A tool outside the 18-name
   allowlist vanishes from the payload with no log and no error. The model is
   never told. *(Checked 2026-07-24: `agent`, `tool_search`, `web_search`, and
   `web_fetch` are all in the list and match `tool-names.ts`, so this does not
   explain the shell-fallback bug — but it is a live trap for anything else.)*
2. **Tool descriptions are truncated, not removed.** 700 chars for tools, 240
   for parameters. Stripping them entirely previously left 4B models with
   undocumented tools and caused looping.
3. **One GPU, one lease.** The host serializes model access. `~/Desktop/inbox`
   competes for the same GPU through Ollama on `:11434` and is not managed here.

### The other entry points

| Surface | Path | Notes |
|---|---|---|
| Web chat / code | `web/src/app/chat`, `/code` | Same profiles, same gateway |
| Attach mode | `apps/cli/.../lal/attach/` | CLI mirrors a host-side run over SSE |
| Durable runs | `web/src/lib/runs.ts` | A run outlives the HTTP request that started it; events append to NDJSON |

---

## 3. Repository layout

| Path | Tracked | Size | What |
|---|---|---|---|
| `apps/cli/` | 3,170 | 978M | The qwen-code fork. ~575k LOC. |
| `web/` | 241 | 2.2G | The host. `web/src` is 25.7k LOC. |
| `scripts/` | 48 | 584K | Training, data import, operations |
| `docs/` | 2 | — | `PLAN.md`, this file |
| `packages/protocol/` | 2 | 24K | The shared web↔CLI contract |
| `tests/` | 4 | 64K | Python host/distribution tests |
| `bin/` `deploy/` `data/` | 9 | 192K | Entry points, systemd unit, seed data |
| `models/` | 0 | 34G | GGUFs — untracked |
| `out/` | 0 | 3.2G | Training outputs — untracked |
| `llama/` | 0 | 244M | llama.cpp Vulkan build — untracked |
| `workspace/` | 0 | 424K | Agent scratch — untracked |

Root files: `README.md`, `CHANGELOG.md`, `AGENTS.md`, `SECURITY.md`,
`package.json`, `start.sh`, `run_app.sh`, `update-all.sh`.

---

## 4. `web/` — the host

25,660 LOC across 201 files. This is the coherent, LAL-authored half of the
system.

### 4.1 `web/src/lib` — the engine room

**Core runtime**

| File | LOC | Responsibility |
|---|---|---|
| `lab.ts` | 1,963 | **The most important file.** Model discovery, llama.cpp/Vulkan serving, GPU offload ladder, profiles, file storage. Independent of Ollama's daemon but reads its GGUF blobs read-only. |
| `runs.ts` | 669 | Server-side run manager. A run lives here, not in the request. Appends events to on-disk NDJSON. |
| `toolloop.ts` | 672 | Streaming tool-call loop against an OpenAI-compatible endpoint. |
| `tools.ts` | 495 | Workspace-scoped tool executor, shared by the benchmark suite and agentic chat. |
| `agent-tools.ts` | 580 | "Mini Claude Code" toolset — file/shell/REPL/web/sub-agents/vision. Vision routes to Gemma. |

> **Duplication to be aware of:** `tools.ts`, `agent-tools.ts`, and `toolloop.ts`
> each hold part of tool dispatch, and the CLI holds a fourth. This is the
> target of PLAN Stage 2.4.

**Research and reasoning**

| File | LOC | Responsibility |
|---|---|---|
| `deliberate.ts` | 241 | Cycle-boxed multi-perspective research engine. Structurally distinct from a single tool loop. |
| `graders.ts` | 445 | Benchmark grading — substring/numeric (loose) plus exec/checks/tools (strict). |
| `autopsy.ts` | 182 | Rule-based diagnosis of a run's event ledger. The evolution loop's diagnostic organ. |
| `fact-store.ts` | 87 | Extract-and-dedupe fact loop. |
| `memory-pipeline.ts` | 160 | Session → daily → digest, three triggers, no cron. |
| `ast-cache.ts` | 197 | AST-aware structural file summaries. |
| `bm25.ts` | 64 | From-scratch BM25. Deliberately not a dependency — keeps "works on any machine" airtight. |

**HIVE** (`lib/hive/`, ~2,900 LOC) — `engine.ts` (1,220) is the scheduler;
`store.ts`, `contracts.ts`, `model-registry.ts`, `provenance.ts`, `graph*.ts`
surround it. Currently gated off pending PLAN Stage 8.

**Foundation slices** — `capability-registry.ts`, `jobs.ts` (durable job
ledger, no bytes or credentials), `lineage-evaluations.ts`, `media-artifacts.ts`,
`model-acquisition.ts` (deliberately has no HTTP client), `retention.ts`,
`host-profile.ts`, `host-context.ts`, `state-migration.ts`,
`workspace-grants.ts`, `request-identity.ts` (identity is separate from
authorization), `browser-mutation-guard.ts`.

**Host readers** — `sysinfo.ts` reads `/proc` and `/sys` directly; Linux-only
and fails soft to `null`. `runtime-processes.ts`, `runtime-status.ts`,
`tailscale.ts`.

### 4.2 `web/src/app` — routes

**Pages:** `/` (91), `/chat` (8, thin), `/code` (1,262), `/train` (865),
`/library` (656), `/hive` (543), `/benchmark` (360), `/models` (252),
`/monitor` (103), `/lens` (5), plus `agent/agent-chat.tsx` (1,319 — the chat
implementation itself).

**API, by family:**

| Family | Count | Purpose |
|---|---|---|
| `api/agent/*` | 22 | Runs, streams, fs, git, preview, projects, models, loop, deliberate |
| `api/hive/*` | 18 | Workflows, definitions, roles, provenance, approvals |
| `api/lal/*` | 10 | CLI client settings, runs, events, heartbeat, web-search |
| `api/llm/v1/*` | 2 | **The gateway.** `chat/completions` (252) and `models` |
| `api/v1/*` | 7 | Foundation slices — jobs, lineage, evaluations, acquisitions |
| others | ~15 | bench, compare, dashboard, train, suites, sysinfo, webshot |

**Seed suites** (`lib/seed-suites/`): agentic, coding, instruct, open-inquiry,
orchestrator, planning, webgen. `open-inquiry.json` is the two-axis
over-refusal / harmful-compliance suite.

### 4.3 `web/src/components`

`charts.tsx` (914) and `widgets/index.tsx` (453) are the heavy ones. `ui/` holds
the small primitives (button, badge, panel, stat-tile, signal-trace). `code/`
holds the editor panes, file tree, git panel, dir picker.

---

## 5. `apps/cli/` — the terminal client

**The number that matters: of ~575,000 LOC, roughly 1,850 are ours.**

### 5.1 LAL-authored — everything we wrote

| Path | LOC | What |
|---|---|---|
| `packages/cli/src/lal/` | 1,804 | Gateway client, SSE client, renderer, reattach, remote-run mirror, managed settings sync, catalog |
| `packages/core/src/lal/` | 3 | Re-export bridge to `@project-lal/protocol` |
| `packages/cli/src/ui/themes/lal-{dark,light}.ts` | — | Branding |
| `scripts/lal-runtime-policy.mjs` | — | Forces `LAL_MANAGED=1`; disables inherited RUM and update checks |
| `NOTICE-LAL.md`, `README-LAL.md` | — | Derivation notice |

> **Read §11 before deleting anything here.** The "keep?" columns below were an
> initial reading; the census in §11 measured what actually ships and corrected
> several of them.

### 5.2 Inherited — `packages/core/src` (~235k LOC)

| Dir | Files | LOC | Keep? |
|---|---|---|---|
| `tools/` | 83 | 44,288 | **Load-bearing.** The tool implementations. |
| `utils/` | 120 | 33,976 | Load-bearing, largely generic |
| `core/` | 58 | 29,713 | Load-bearing — includes the OpenAI-compatible generator we depend on |
| `services/` | 44 | 28,292 | Mixed |
| `agents/` | 48 | 23,338 | Subagent runtime |
| `telemetry/` | 27 | 10,794 | **Strip** — includes `qwen-logger/` |
| `hooks/` | 22 | 8,260 | Mixed |
| `memory/` | 30 | 7,928 | Load-bearing |
| `config/` | 6 | 7,428 | Load-bearing |
| `permissions/` | 12 | 7,287 | Load-bearing |
| `lsp/` | 9 | 6,733 | **Deletion candidate** |
| `skills/` | 24 | 6,656 | Bundled skills |
| `extension/` | 21 | 6,740 | **Deletion candidate** |
| `mcp/` | 13 | 2,940 | Audit |
| `models/` | 8 | 2,884 | Audit |
| `subagents/` | 6 | 2,755 | Load-bearing |
| `qwen/` | 3 | 2,369 | **Strip — brand** |
| `ide/` | 7 | 1,928 | **Deletion candidate** |
| `providers/` | 16 | 1,892 | Cloud providers — **strip all but the default** |
| smaller | — | ~3,700 | followup, goals, plan-gate, prompts, confirmation-bus, output, resources |

### 5.3 Inherited — `packages/cli/src` (~264k LOC)

| Dir | Files | LOC | Keep? |
|---|---|---|---|
| `ui/` | 518 | 124,945 | **Load-bearing** — the terminal UI |
| `serve/` | 130 | 59,168 | **Largest deletion candidate.** qwen-serve daemon, OAuth device flow, enterprise channels. |
| `i18n/` | 13 | 21,097 | **Deletion candidate** — "broad locale machinery" |
| `acp-integration/` | 26 | 18,536 | **Deletion candidate** — Zed/ACP bridge |
| `commands/` | 88 | 15,294 | Mixed — includes inherited Arena/Insight/bug-report |
| `config/` | 35 | 13,199 | Load-bearing |
| `utils/` | 69 | 12,514 | Load-bearing |
| `services/` | 36 | 7,021 | Mixed |
| `nonInteractive/` | 16 | 6,434 | Load-bearing — headless `lal -p` |
| smaller | — | ~1,800 | startup, dualOutput, remoteInput, core, export, patches, types |

### 5.4 Other packages

`channels/` (21,395 — enterprise channels, deletion candidate),
`sdk-typescript/` (30,698 — deletion candidate), `acp-bridge/` (19,995 —
deletion candidate), `web-templates/` (3,317), `audio-capture/` (116),
`vscode-ide-companion/` (empty).

### 5.5 Brand surface

`qwen` 2,402 occurrences · `google` 1,194 · `gemini` 397 · 59 file paths
containing qwen/gemini, including `packages/cli/src/gemini.tsx` (the main
entry point) and `GeminiRespondingSpinner.tsx`.

### 5.6 Known broken

The full CLI build references `packages/webui` and `packages/web-shell`, which
**do not exist**. Only the headless standalone packaging path works today.

---

## 6. `scripts/`

**Operational — do not delete**

| Script | Purpose |
|---|---|
| `rebuild-local-ai-lab.sh` | Build + restart **project-lal.service** + health check. The deploy path. |
| `release-lal-cli.sh` | Windows release build. Bakes `LAL_HEADLESS_STANDALONE=1`. |
| `install-project-lal-service.sh` | Install/switch the Linux user service |
| `install-local-lal.sh` | Install the in-repo CLI for the Linux host |
| `update-lal-release-manifest.mjs` | Checksum-pinned release manifest |
| `check-protocol-drift.mjs` | Guards the `packages/protocol` import boundary |
| `smoke-project-lal.sh` · `smoke-attach-replay.sh` · `smoke-terminal-lifecycle.mjs` | Guarded real-host smokes, deliberately outside `npm test` |
| `lal-doctor.mjs` · `inventory-host-assumptions.mjs` | Redacted host capability snapshots |

**Training (dormant, gated behind PLAN Stage 8)**
`finetune_hqq.py` (the 8GB survival trainer), `finetune_sft.py`,
`finetune_qlora.py`, `finetune.py`, `finetune_sft_offload.py`, `build_mix.py`,
`build_sft.py`, `build_hive_role_dataset.py`, `build_contemplative_sft.py`,
`build_sovereign.py`, `verify_sft.py`, `compare_adapters.py`, `lens.py`,
`check_hqq.py`, `check_4bit.py`, `fakebin/rocminfo`.

**Data generation** — `gen_*.py` ×7, `distill_gemma.py`, `convert_swe_traces.py`.

**Unreferenced by anything** — `import_coderforge.py`, `import_gsm8k.py`,
`import_hermes.py`, `import_mbpp.py`, `import_openr1_math.py`,
`import_swenext.py`. Six files, zero inbound references. First candidates in the
PLAN Stage 0.2 census.

---

## 7. Untracked working roots — 37G

| Path | Size | Written by | Read by | Safe to delete? |
|---|---|---|---|---|
| `models/` | 34G | Downloads, training merges | `lab.ts` inventory | Per-file only; check the registry first |
| `out/` | 3.2G | Training runs (`*.train.log`, checkpoints) | Nothing at runtime | Yes — archive logs first |
| `llama/` | 244M | Manual download | `lab.ts` spawns the server | No — required to serve |
| `workspace/` | 424K | Agent runs, `_deliberation/` | `retention.ts` evicts | Managed; don't hand-delete |
| `web/.data/` | — | Runs, suites, profiles, devices | Everything | **No.** Live state. |

`web/.data/context-profiles.json` holds the per-model profiles the whole system
reads. `web/.data/runs/` holds one JSON + NDJSON per run.

---

## 8. Host assumptions and porting

*Absorbed from the former `PORTING.md`, which this file replaces.*

### The machine this was built on

- **OS:** Linux. **GPU:** AMD Radeon RX 6650 XT — RDNA2, `gfx1032`, presented to
  ROCm as `gfx1030` via override (the real arch is not in ROCm's support table).
  **8GB VRAM.** **RAM:** 15.6GB. One GPU, no CUDA anywhere.
- Every `torch.cuda` check in the Python code is real — PyTorch's ROCm build
  answers the same API.
- There is no `requirements.txt`. What was in `.venv`: `torch==2.5.1+rocm6.2`,
  `pytorch-triton-rocm==3.1.0`, `bitsandbytes` (ROCm continuous-release wheel,
  **not** the PyPI package), `hqq==0.2.8.post1`, `peft==0.19.1`,
  `transformers==5.12.1`.

### The mindset that matters more than any single fix

**Every quantization trick, batch cap, and chunking hack in the training code
exists to fit training inside 8GB VRAM and 15GB RAM.** They are scarcity
workarounds, not correctness. On a machine with real headroom they should be
*relaxed or removed, not inherited*. Do not treat these numbers as sacred.

### Probe first, then decide

GPU/VRAM (`rocm-smi` · `nvidia-smi` · `system_profiler`), RAM (`free -h`),
OS/arch (`uname -a`), cores (`nproc`). The delta against the spec above is what
you are actually porting for.

### What assumes this machine

**A. GPU backend env** — `lab.ts` `gpuTrainEnv()` sets
`HSA_OVERRIDE_GFX_VERSION`, `HSA_ENABLE_SDMA`, `PYTORCH_HIP_ALLOC_CONF`.
ROCm/HIP-only; CUDA and CPU torch ignore them. Override with
`GPU_TRAIN_ENV='{"KEY":"value"}'`. `scripts/fakebin/rocminfo` fakes `rocminfo`
output so bitsandbytes' arch detection sees a supported target — irrelevant off
ROCm. `HQQBackend.PYTORCH` is chosen for ROCm safety; CUDA may have faster.

**B. VRAM workarounds (8GB)** — `finetune_hqq.py` is *entirely* an 8GB survival
strategy: streaming shard quantization, 256-token chunked cross-entropy,
CPU-resident embeddings, streaming merge. On 16GB+, a plain QLoRA run is simpler
and faster. `finetune_sft.py:141` batch size 1. `finetune.py` caps block length
to 128 and batch to 1 above 2B params. `lab.ts`'s offload ladder
`[configuredNgl, 24, 12, 0]` encodes this card's failure points.

**C. RAM workarounds (15GB)** — shard streaming exists because materializing an
8B fp16 on CPU (~16GB) pushed this box into swap. `lab.ts` has an OOM check
keyed to 15GB for Ollama + a local GGUF resident together.

**D. Linux-only** — `sysinfo.ts` reads `/proc/stat`, `/proc/meminfo`,
`/sys/class/drm/card1/device/*`, `/sys/class/hwmon/*`; hardcodes GPU `card1` and
sensor names `amdgpu` / `k10temp` / `coretemp`. **Fails soft** — every reader
returns `null` on a miss, so the app runs with blank stats.
`OLLAMA_STORE = /usr/share/ollama/.ollama/models` is the Linux path. `start.sh`
and `web/run_web.sh` are bash — on Windows use WSL2. Owner belongs to the
`render` group, so the unit launches directly without `sg render`.

**E. llama.cpp** — `llama/llama-b9835/` is a Linux Vulkan build, gitignored and
downloaded separately. Point `LLAMA_DIR`/`LLAMA_SERVER` in `lab.ts` elsewhere as
needed. Metal usually beats Vulkan on Apple Silicon.

**F. Ports** — app `:8770`, llama.cpp `:8099`, tailnet https `:8443`, Ollama
`:11434`. All overridable via env in `start.sh`.

**Verify by running, not by compiling.** A few dozen training steps, `/monitor`
showing real numbers or accepted blanks, and `/chat` + `/code` serving a model.
None of these failure modes appear at typecheck time.

---

## 9. Operational runbook

| Task | Command |
|---|---|
| Deploy the host | `scripts/rebuild-local-ai-lab.sh` — builds, restarts **project-lal.service**, health-checks |
| Ship to Windows | Version bump **then** `scripts/release-lal-cli.sh`. A `git push` alone ships nothing. |
| Real VRAM in use | `cat /sys/class/drm/card*/device/mem_info_vram_used` |
| GPU wedged | `journalctl -k \| grep amdgpu` first, before blaming the model |
| Ollama contention | `sudo systemctl restart ollama` — must be user-run |

### Windows and phone attach smoke

Run only when the Linux host is idle — it creates one short chat run and unloads
its model afterward.

```bash
./scripts/smoke-attach-replay.sh          # durable stream contract, on the host
```

For the real Windows check, in PowerShell:

```powershell
$env:LAL_GATEWAY_URL = 'https://<tailnet-host>:8443'
$env:LAL_API_KEY = '<pairing token from ./start.sh --show-cli-token>'
lal
```

Then `/attach list`, `/attach <run-id>` (or bare `/attach` for the newest live
run). Open the same run in the phone web UI. Disconnect one client briefly,
reconnect, and confirm the stream resumes with no duplicated text. `/attach
stop` detaches the terminal only — it must not stop the host run.

**Dead unit name:** `localailab.service` no longer exists. Its `EADDRINUSE`
failures in the journal are noise. The live unit is `project-lal.service`.

**Not ours:** `~/Desktop/inbox` runs its own next-server on `:3000`, is not
systemd-managed, and shares this GPU via Ollama. Check `/proc/<pid>/cwd` before
touching any process.

---

## 10. Known traps

1. **Silent tool drop** — `chat/completions/route.ts:94` returns `[]` for any
   tool outside `LAL_TERMINAL_TOOLS`. No log, no error, no notice to the model.
2. **`web/` is not the Next.js you know** — see `web/AGENTS.md`. Read the guide
   in `node_modules/next/dist/docs/` before writing route code.
3. **Shallow-clone push** — `apps/cli` was a vendored submodule; check remotes
   before assuming a push works.
4. **Project-LALF is public** — never push without explicit per-instance
   confirmation. "Commit and keep going" is not push authorization.
5. **Broken CLI build** — `packages/webui` and `packages/web-shell` are
   referenced but absent.
7. **There is almost no dead code in the CLI** — see §11. Reduction is a
   product-scope decision, not a cleanup. Do not expect deletions to be free.
8. **Only two documents are authoritative** — `docs/PLAN.md` and this file.
   38 plans, notes, designs, and research documents were deleted on 2026-07-24;
   their load-bearing decisions live in PLAN Appendix A and in sections 8–10
   here. Code comments that cited them were rewritten to be self-contained in
   the same commit. Do not reintroduce a third planning document — put the
   decision in PLAN.md or it is not a decision.

---

## 11. Deletion census

PLAN Stage 0.2. Measured 2026-07-24. **Nothing here has been deleted** — this is
the evidence, and the decisions it enables.

### 11.1 Method, and what it can and cannot prove

Three passes, each with a known blind spot:

| Method | Result | Blind spot |
|---|---|---|
| Inbound-reference grep | Per-file citation counts | A script invoked by a human has zero inbound references and is still alive |
| Static import closure from `packages/cli/src/cli.ts` | 1,543 / 1,692 files reachable | Barrel `index.ts` re-exports pull entire trees in on one import — **overstates use** |
| esbuild metafile (`DEV=true node esbuild.config.js`) | 1,471 / 1,667 files enter the bundle | Tree-shaking removes *symbols*, not file entries — **also overstates use**. Externalized and dynamically imported packages never appear at all — **understates use** |

The third pass caught the second pass lying, and a manual check caught the third
pass lying: `packages/channels/*` is absent from the bundle yet is loaded at
runtime through `import('@lal/channel-telegram')` in
`packages/cli/src/commands/channel/channel-registry.ts:10-15`. Absence from the
bundle is not evidence of death.

### 11.2 The finding

**There is almost no provably dead code in `apps/cli`.** Of ~575k LOC, the only
things nothing can reach are a handful of vitest configs and bare package
`index.ts` re-export stubs — all of which are legitimately needed.

This inverts how PLAN Stage 7 should be approached. "Strip the qwen-code
cadaver" is **not** a dead-code cleanup that can be done safely and invisibly.
Every candidate below is live, reachable code implementing a feature we don't
want. Removing it means cutting import edges and accepting the loss of a
feature — a product decision each time, with a real regression risk that only
HTML-001 can bound. That is why Stage 7 sits after Stage 6, not before.

### 11.3 Category A — provably unreachable

| Unit | LOC | Evidence |
|---|---|---|
| `scripts/import_{coderforge,gsm8k,hermes,mbpp,openr1_math,swenext}.py` | ~1,200 | Zero inbound references from any live code, script, or config |
| `packages/{cli,core}/index.ts` re-export stubs | 20 | Not in bundle, not imported |

That is the entire list. It is much shorter than expected.

### 11.4 Category B — reachable, out of product scope

Deliberate cuts. Each row lists everything that must go together; deleting the
package alone leaves a broken import.

| Feature | Delete together | LOC | Notes |
|---|---|---|---|
| Messaging channels (Telegram, WeChat, DingTalk, WeCom, Feishu, QQBot) | `packages/channels/*` + `packages/cli/src/commands/channel/` | ~16,000 | Dynamically imported. May already be broken — the workspace `dist/` outputs the dynamic imports resolve to are not built. |
| Third-party SDK | `packages/sdk-typescript/src/{mcp,daemon-mcp,query,transport,types,utils}` | ~10,400 | Not in the bundle. **Keep `src/daemon`** — 21 files, 650KB, actively bundled. |
| Insight reports | `packages/cli/src/services/insight/` + `packages/web-templates/src/insight/` | ~2,400 | |
| HTML conversation export | `packages/cli/src/ui/utils/export/` + `packages/web-templates/src/export-html/` | ~3,000 | Distinct from LAL's own `/export` |
| Voice input | `packages/cli/src/ui/voice/` + `packages/audio-capture` | ~1,600 | `@lal/audio-capture` is an esbuild external — a native runtime dep |
| Zed / ACP integration | `packages/cli/src/acp-integration/` + `packages/acp-bridge` | ~38,500 | Both bundled and live. Large, and the biggest single win. |
| Locale machinery | `packages/cli/src/i18n/` | ~21,100 | **Bundled, 1.25MB of input.** Note `bundlePaths.ts` couples i18n asset lookup to the chunk dir name. |
| Vendor telemetry | `packages/core/src/telemetry/` incl. `qwen-logger/` | ~10,800 | PLAN 1.2 keeps local observability and removes only external reporting — this is a **partial** cut, not a directory delete |
| Cloud providers | `packages/core/src/core/openaiContentGenerator/provider/{dashscope,deepseek,mimo,minimax,mistral,modelscope,zai}.ts` | ~1,900 | **Keep `default.ts`** — it is how LAL reaches its own gateway |
| LSP / IDE / extensions | `packages/core/src/{lsp,ide,extension}/` | ~15,400 | Audit individually; `extension/` may carry skills machinery |

### 11.5 Needs a decision, not a census

`packages/cli/src/serve/` — 130 files, **59,168 LOC, 2MB of bundle input**, and
126 of its files are actively bundled. It is qwen-serve: an OAuth device flow, a
daemon, and enterprise channel serving. LAL does not use any of that, but it is
the single largest body of live code in the repository and cutting it is a
project, not a deletion. Decide explicitly in Stage 7; do not let it drift.

### 11.6 Scripts — manual invocation means references prove nothing

| Classification | Scripts |
|---|---|
| **Operational, keep** | `rebuild-local-ai-lab.sh`, `release-lal-cli.sh`, `install-*.sh`, `update-lal-release-manifest.mjs`, `check_protocol_drift.mjs`, the three smokes, `lal-doctor.mjs`, `inventory-host-assumptions.mjs` |
| **Training, dormant** — frozen behind PLAN Stage 8, not dead | the `finetune_*`, `build_*`, `gen_*`, `check_*`, `lens.py`, `verify_sft.py`, `compare_adapters.py`, `fakebin/rocminfo` |
| **Delete** | the six unreferenced `import_*.py` in §11.3 |

`lal-doctor.mjs` and `check_hqq.py` have zero inbound references and are alive —
they are run by hand. This is exactly why reference counting alone is not a
census.

### 11.7 Build health, observed while measuring

- `npm run bundle` **succeeds** — `node esbuild.config.js` completed clean and
  regenerated `dist/`. The bundle path is healthy.
- The declared workspace list resolves: all 14 exist on disk.
- Still broken, as previously recorded: `packages/webui`, `packages/web-shell`,
  and `packages/sdk-python` are referenced by scripts but absent.
- The metafile is written **only** under `DEV=true`. To regenerate this census:
  `cd apps/cli && DEV=true node esbuild.config.js` then read `dist/esbuild.json`.
