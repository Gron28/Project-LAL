# Changelog / engineering log

A running log of what got built, what broke, and what was learned — kept honest on
purpose, including the runs that didn't work. Newest first.

## 2026-07-19 — Tool-call reliability and terminal visibility fixes

Runtime `0.1.0-lal.22` redraws the J-space certainty wave: it now spans the full
terminal width instead of a fixed ~47-sample strip, and each bar is colored by its
own confidence tier (green/amber/red) rather than a single flat gray, using an
eight-level bar instead of three for a smoother line. It renders as its own
full-width row below the rest of the footer instead of sharing space with the
right-hand indicators, which is what was capping its width before.

Runtime `0.1.0-lal.21` fixes five defects found by blind-testing the terminal agent
end to end. Replaying reasoning as inline `<recalled_thinking>` text broke Qwen3.5's
native tool-call format — the model stopped closing `</think>` and its tool call
never executed; Qwen3.5 models now get the untouched `reasoning_content` field
instead, which their template already renders correctly. A loop-recovery nudge that
recursed into the same in-flight stream deadlocked the whole turn forever with no
error; recovery now waits for the stream to close first. Ministral's chat template
enforces strict user/assistant alternation, which routine agent nudges placed right
after tool results legitimately violate, 500ing the request; message history is now
repaired to satisfy that invariant before it's sent. Headless (`-p`) runs were
silent for the entire length of a long think, indistinguishable from a hang; thinking
and response text now stream live to the terminal as they're generated. And the
J-space certainty footer never rendered on any tool-carrying turn because the
inference server rejects `logprobs` alongside streamed tool definitions; the gateway
now requests the equivalent signal through a parameter the server does accept.

## 2026-07-14 — LAL becomes its own native Windows CLI

Forked the selected Apache-2.0 terminal foundation into `@local-ai-lab/lal-cli`.
The executable, banner, help, prompts, session UI, documentation bundle, and managed
update behavior now identify as LAL. Upstream copyright and derivation notices remain
intact. The Windows release is a self-contained `lal-cli-win-x64.zip` hosted by
`main-pc`, includes its own Node runtime, and is SHA-256 verified before an atomic
install with rollback. It no longer installs, discovers, or invokes a `qwen` command.

The installer preserves `~/.lal` settings, device identity, credentials, and
project-scoped chats. `lal update` now advances the native LAL runtime. Native
Linux/macOS artifacts are the next packaging step; their recovery installer remains
available during the transition.

Runtime `0.1.0-lal.2` replaces the wordmark with LAL's compact paired-L mark: two
angled L forms meet around the central A, while a deliberately detached lower stem
keeps the silhouette from reading as a T. The managed `lal update` path preserves
all existing settings and project chats while applying the new banner.

Runtime `0.1.0-lal.3` corrects the first mark's uneven hand-spaced geometry. Every
non-empty row now shares center column 13, all outer groups are mirrored around that
axis, and the detached stem sits directly below the center group.

Runtime `0.1.0-lal.4` widens the central A and removes the punctuation-like detached
stem. A one-cell tail now connects directly to the lower center leg, while the wider
crossbar and mirrored arms remain centered on a single axis.

Runtime `0.1.0-lal.5` adopts the user-approved ten-row monogram verbatim. Its two
angular L paths, open center, crossbar, internal center marks, and lower tail are all
centered on column 19; no geometry is inferred or normalized beyond that approved
spacing.

Runtime `0.1.0-lal.6` removes the inherited Qwen provider onboarding from managed
LAL. The updater now backs up existing settings once, preserves user preferences,
and refreshes only the main-PC connection, model, authentication, and LAL context
fields. If that managed connection is ever invalid, LAL shows a focused repair
message instead of Alibaba/Qwen setup or upstream terms. `LAL.md` is now the primary
managed project-context filename, with `AGENTS.md` and legacy `QWEN.md` still read
for compatibility.

Client `0.3.6` fixes the Windows settings migration writing UTF-8 with a byte-order
mark, which the inherited JSON loader rejected. Managed settings are now explicitly
written as BOM-free UTF-8, matching Node's JSON parser and preserving the repaired
main-PC connection across launch.

Runtime `0.1.0-lal.7` gives the LAL header a fixed product palette independent of
the selected editor/syntax theme: cyan `#22D3C5`, green `#55E06F`, and restrained
yellow `#E6D85C`. The monogram uses the three-color gradient, with a cyan panel
border, green LAL title, and yellow version accent; blue and purple are absent from
the branded header.

## 2026-07-13 — Installable LAL terminal client and tailnet inference gateway

Selected and cloned Qwen Code as the Apache-2.0 foundation for the full terminal
client after auditing Qwen Code, OpenCode, Pi, Goose, Codex, Gemini CLI, Aider, and
Crush. A live compatibility proof showed the required split works: the mature client
and its file/shell tools run inside the project on the client computer while only
OpenAI-compatible inference runs on `main-pc`. Project-scoped JSONL sessions resume
locally without copying the repository to the server.

Added a bearer-authenticated `/api/llm/v1` gateway, client model/settings discovery,
single-GPU request serialization, and context-aware model reloads. The safe default
is Qwen3-4B at 32k; a full 19k-token agent schema completed successfully, while an
overlapping 8B/32k experiment honestly reproduced a Vulkan device loss on the 8GB
card and established why the queue/model profile is necessary.

Added idempotent Linux/macOS and Windows installers served over Tailscale, a pairing
token command, a pinned standalone runtime, isolated `~/.lal` settings/sessions, and
`lal update`. Runtime and LAL client versions are independent so frequent overlay
changes do not reinstall the large runtime. An isolated end-to-end install test used
the installed wrapper to create an exact file in the client project through a remote
model tool call and persisted the session under that client's project history.

Added persistent random device identities, authenticated launch heartbeats, request
activity tracking, rejected-token counters, and `./start.sh --list-cli-devices` as a
main-pc security view. The audit registry is deliberately metadata-only: it never
stores prompts, project paths, tool arguments, or file contents.

Windows release `0.2.1` fixed the installer treating the octet-stream response for
`lal.cmd` as a printable byte array (`64 101 99 ...`) instead of decoding it as
UTF-8 text. Re-running the idempotent installer repairs the wrapper without
reinstalling the then-pinned foundation runtime or replacing chats/settings. Release
`0.3.0` supersedes that runtime with the native LAL fork described above.

## 2026-07-11 (later) — Base locked, first specialist dataset built, first training run

Base-model bake-off for the specialist cohort, run under identical frozen
conditions (same binary, flags, suites, token budgets): **Qwen3-4B stays.**
Qwen3.5-4B (hybrid DeltaNet, no MoE at 4B — already servable by the b9835
binary) lost on speed (47.5 vs 82 decode tok/s; 29 vs 62 at 6K context) and on
coding (17/20 vs 19/20), and scored 1/14 on planning because its thinking
overruns the frozen 1536-token budget — an honest operational failure even if
not a capability one. Agentic 8/8 was its only win. No Qwen3.6 4B exists;
Gemma 4 12B already loses agentic/planning locally and the pipeline is
Qwen-specific.

Built the first production role dataset: `data/hive_coder_v1.jsonl` — 3,001
bounded decision windows (first_mutation/repair/verification) carved by the new
`scripts/convert_swe_traces.py` from 939 resolved, permissively-licensed
Open-SWE-Traces trajectories, block 2048, repo-grouped 2797/204 split, zero
builder drops, registered in HIVE provenance as `ds-846ee6002f404256dde0885a`.

Trainer upgrades in `finetune_hqq.py`/`finetune_sft.py`: `--grad_accum`,
`--warmup` + `--cosine`, `--balance_sources`, and per-message `"train": false`
loss masking (teach the recovery, not the mistake) — all wired through the
train API. HIVE engine now serves specialist adapters with
`enable_thinking:false` to match their no-think SFT format (prompted roles
unchanged). 100-step smoke run on the new dataset launched the same afternoon.

## 2026-07-11 — HIVE specialist cohort and live workspace foundation

Implemented the coding-first specialist architecture around a shared Qwen3-4B base:
coordinator/planner, coder/repairer, and read-only verifier roles; typed bounded
handoffs; observable net workspace mutations; fresh post-mutation checks; post-repair
independent review; machine-readable failure classes; and strict adapter/cohort
promotion gates. llama.cpp can now preload promoted LoRA adapters and select one per
request without leaking global adapter state or counting an adapter activation as a
full model swap.

Added the provenance-rich role dataset builder, task-family validation isolation,
production tool-schema normalization, permanent blind-probe guards, verified-run
harvesting/quarantine, adapter-only Qwen3-4B training/conversion, and immutable
candidate manifests. **No adapter is promoted by this work alone**: real blind results
are still required.

The HIVE UI now includes one live Workspace view for the active file tree, read-only
code, in-flight write/edit argument drafts, plan/research streams, and durable
artifacts. HIVE shell work and deterministic checks run with only the selected
workspace persistently writable, home credentials hidden, a scrubbed environment,
and no network.

## 2026-07-09 — Hive: multi-agent workflow runtime (experimental, not yet a win)

Added `/hive`: a durable multi-agent workflow engine (plan → research/implement →
critique → repair → report), with pause/resume/override, replay from any node, and a
provenance trail for every claim. Built to test whether a small-model "hive" of
specialized roles can outperform one capable model on the same task.

**Evaluation result: it doesn't, yet.** Two fixture tasks (a contradiction-sensitive
research memo and a standard-library-only crash-recoverable DAG runner with adversarial
tests) were run end to end. The safety/verifier layer worked well — evidence gates,
deterministic test/lint execution, and a requirement audit caught every false "done"
claim honestly instead of rubber-stamping it. But the worker roles under-delivered:
research never reached citation synthesis, and the coding implementer left
`throw new Error("not implemented")` in place while claiming completion. Full writeup
in `web/docs/hive-evaluation-2026-07-09.md`. **Verdict: do not promote — a single
capable model still beats the hive on task completion.** The harness is a real,
reusable piece of infrastructure; the worker prompting/routing needs another pass
before it's a net win. Treat `/hive` as a research surface, not a finished feature.

## 2026-07-08 — Agent UI rebuilt: live telemetry + continue-on-truncation

Ground-up rework of the `/code` agent UI.

- Found a real gap: `/api/agent/models` was fetched by six different pages but the
  route didn't exist — every model dropdown was silently empty. Added it (GET
  models/current/serving/options/system; PUT patches any subset).
- **Live telemetry** (`stats-hud.tsx`): context-fill bar, decode tok/s, GPU%, VRAM,
  GPU temp, CPU, RAM. Token/speed numbers come from SSE `usage` events parsed off
  llama-server's final stream chunk; hardware comes from `/api/sysinfo`.
- **Continue-on-truncation**: when a reply is cut off by the context window, the run
  persists a `truncated` flag so reopening the conversation on another device offers a
  Continue button (or auto-continues, bounded to 4 per turn).
- New sticky command bar, a real mobile bottom-sheet controls menu, restyled composer
  and approval flow, replacing the old flat button row.
- New `agent-settings.tsx`: one slide-over for every knob — model, think mode,
  auto-approve, auto-continue, context/prediction size, sampling params, idle
  auto-unload timer, system prompt.
- Cross-device continuity works because runs live server-side (see below): open the
  same run from a different device and it reattaches to the live stream.

## 2026-07-07 — Agent runtime rework: server-side persistent runs

Root cause of "chat dies on tab switch / phantom running spinner / invisible GPU
loops": every agent run was welded to the browser HTTP request that started it.
Reworked to a server-side run model — runs live as persisted event logs
(`.data/runs/<id>.json` + append-only `.ndjson`), and every UI is just a detachable
client.

- `POST /api/agent/loop|chat|deliberate` return `{runId, conversationId}`
  immediately; the work continues detached. Clients attach via
  `GET /api/agent/runs/[id]/stream` (SSE, resumable), stop via
  `POST /api/agent/runs/[id]/stop`.
- **Stop is now real**: an `AbortSignal` threads through the whole tool loop,
  sub-agent spawns, and both chat pumps. Previously "Stop" only aborted the client's
  fetch while the loop kept running unattended for up to 120 rounds in orchestrator
  mode.
- A GPU idle reaper unloads the served model after N idle minutes (configurable,
  0 = never), held open while any run or training job is live.
- Training became callable from chat itself: `list_models`, `train_start`,
  `train_stop`, `bench_list`, `bench_results`, etc. — approval-gated tools that let
  the agent drive the training pipeline.

## 2026-07-07 — Snake-game blind test: two honest failure modes, no promotion

An unscripted, prompt-only blind test — "build a roguelike snake game (procedural
maps, powerups, enemies), one shot, via the agent's own tools" — run against several
candidate models to see how far agentic code-gen actually gets, independent of the
benchmark suite.

- **Round 1** (open-ended orchestrator prompt): both `victory6-8b` and `gemma4:12b`
  produced real partial work (a genuine cellular-automata map generator, buffered
  input) but neither shipped a working roguelike. Both shared the same failure
  pattern — solid research/planning, then stalling before finishing implementation,
  either by narrating intent without acting or by re-researching instead of building.
  Reproduced across three independent attempts per model.
- **Round 2** (toolset-restricted planner → implementer split, so the model can't
  escape into research mid-implementation): fixed the stalling — both models
  completed every step with real tool calls. But surfaced a *third* gap: neither
  model verified its own multi-step edits still parsed. Both outputs ended up
  non-functional (redeclared variables, calls to undefined functions, corrupted
  `edit_file` fragments) — worse than round 1's honest partial work.
- **Round 3** (a later, stronger checkpoint, same test): shipped *valid* code this
  time — `node --check` passed — but implemented almost none of the requested
  systems (79 lines of bare classic Snake), and its own completion report falsely
  claimed all four systems were done. A new failure mode: clean code, confabulated
  self-report.

None of these results were promoted. They're kept as the project's standing
regression probe — this game is intentionally never trained on or added to the
benchmark, so it stays a clean out-of-distribution test.

## 2026-07-07 — victory9-8b: mixed result, not promoted

Full result vs the served `victory6-8b` baseline across the 7-suite battery: 5/7
suites tied exactly, webgen +1, 8–13% faster across the board — but planning
regressed by 2 points. Under this project's promotion bar (a new checkpoint must
match or beat the baseline on *every* suite, no exceptions), any regression fails,
so `victory9-8b` was kept as a side artifact rather than replacing the served model.

## 2026-07-06 — `/code` repo integration, in-browser editing, mobile support

- File system, git, and browse APIs scoped to a confirmed project root, with a full
  file tree + CodeMirror 6 editor pane (conflict detection via an mtime handshake so
  a human editing a file and the agent editing the same file can't silently clobber
  each other).
- Repo cloning from the UI, with the clone URL and target folder name validated
  against strict allow-lists before ever reaching a shell (defense against argument
  injection).
- A "run" tab that starts a project's dev server as a managed background process and
  exposes it over the tailnet at the same port — so a project the agent is working on
  can be previewed live from any device on the network, no manual tunnel setup.
- Mobile layout fixes (clipped modals, overlapping z-index elements, tap targets).

## 2026-07-04 — Reality-gap pivot: the benchmark had been gamed

A private blind test ("code a snake game in HTML, one shot") showed Gemma 12B
comfortably beating every fine-tuned Qwen candidate on open-ended web app generation
— while the benchmark's coding suite had both scoring a tied 20/20. The suite was
measuring the wrong thing. Response:

- Added a **webgen suite**: 12 one-shot web app tasks, graded by actually running the
  output in headless Chrome and probing DOM/behavior, with a screenshot captured per
  run for visual sanity-checking in the UI — not just checking that *some* HTML came
  back.
- Locked a permanent rule: the snake-game probe never enters training data or any
  graded suite. It stays a clean, ungamed check on real capability.
- Locked the promotion bar: a candidate must match-or-beat the baseline on every
  suite and be at least as fast, ties count, any regression anywhere fails it.

## Bugs and lessons worth keeping

A few findings that cost real debugging time and would silently recur without a note:

- **Reasoning models get starved by token caps sized for non-reasoning models.**
  Several scoring bugs (planning suite, tool-use suite) turned out to be the model
  correctly reasoning inside `<think>` and then hitting a token cap before it could
  answer — a 0/N score that looked like a capability failure was actually a harness
  bug. Rule of thumb adopted project-wide: a 0/N score from a model that can trivially
  do the task by hand should be treated as a measurement artifact until proven
  otherwise, not a real result.
- **Think-displacement**: SFT rows whose assistant content answers immediately (no
  `<think>` block) quietly teach a reasoning model to stop reasoning. The tell was
  raw throughput — every fine-tune that lost the `<think>` habit got faster and
  measurably worse on math/logic. Fixed by matching training data format to each
  suite's actual think mode instead of standardizing on one style.
- **A convergence gate can lie**: an early-stop gate based on smoothed training loss
  once declared a run "converged" at 7% of its step budget while validation loss was
  still falling — a lucky streak of short, easy examples had faked the signal. Made
  the gate validation-aware so it can't be fooled by training-loss alone.
- **Cross-backend GPU contention**: switching from one model-serving backend to
  another without explicitly unloading the first blew past available RAM and
  triggered a system-wide OOM kill that took out unrelated system services. This box
  runs one model at a time by design now, enforced in both directions (training
  unloads serving; serving refuses to start while training is alive).
- **Runaway generation**: the agent's tool loop had no per-round token cap, so a
  multi-round tool-use task could hang for minutes generating unbounded output.
  Fixed with an explicit cap threaded through every round.

## Where things stand

Local training (LoRA/QLoRA + HQQ quantization on a single 8GB consumer GPU),
GGUF conversion + quantization, a 7-suite auto-graded benchmark battery, a full
agentic coding UI with server-side persistent runs, live system telemetry, and an
experimental multi-agent workflow runtime (`/hive`) all run end to end inside this
one app. The serving/training pipeline, benchmark, and agent all share the same
code paths, so the benchmark measures the real product surface rather than a mock.
