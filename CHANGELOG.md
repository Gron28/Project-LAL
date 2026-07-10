# Changelog / engineering log

A running log of what got built, what broke, and what was learned — kept honest on
purpose, including the runs that didn't work. Newest first.

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
