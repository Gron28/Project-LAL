# Project-LAL foundation roadmap

Status: current delivery order. Last updated: 2026-07-14.

## Rule of the roadmap

Do not expand product surface while the current core flow is unreliable. New
models, Hive features, training runs, SDKs, integrations, and visual polish are
secondary to a system that starts, runs, reconnects, reports truthfully, and
stops cleanly.

## Milestone 0 — establish the truth

Create one reliable diagnostic picture before making broad changes.

- Record the supported host/client topology and actual platform assumptions.
- Inventory every process Project-LAL starts; assign each a named owner, PID,
  log location, health check, stop path, and cleanup rule.
- Make one status surface report the real state of the web server, model backend,
  GPU lease, active runs, training jobs, and known failed/orphaned processes.
- Make durable run records and logs easy to locate without scanning arbitrary
  folders.
- Turn existing failures into small reproducible tests before attempting fixes.

Exit criterion: after a failed run or restart, the owner can identify what is
still running, where its log is, whether it owns GPU resources, and how to stop
it safely.

## Milestone 1 — one dependable personal workflow

Make the essential end-to-end path work repeatedly:

1. Start the host on Linux and verify its model gateway and system state.
2. Run `lal` from a Windows project using host inference.
3. Show real streaming, tool calls, approval prompts, model loading, and errors.
4. Close or disconnect the terminal without losing an attach-mode host run.
5. Open the phone web UI, attach to the same conversation/run, and continue it.
6. Stop the run cleanly and confirm that no ghost process or GPU lease remains.

Exit criterion: this flow passes repeatedly with a deliberately interrupted
network connection and a deliberate model/backend failure.

## Milestone 2 — make state trustworthy

- Replace duplicated protocol definitions with one shared versioned package.
- Reconcile native CLI and attach-mode events so status, thinking, context,
  model state, and errors do not disappear depending on how a run started.
- Make the model catalog, actual context window, loaded state, and GPU status
  come from the host rather than static labels.
- Add bounded retention for conversations, logs, artifacts, caches, and
  training output.
- Add regression tests for startup, reconnect/replay, cancellation, process
  cleanup, protocol compatibility, and storage limits.

Exit criterion: every user-visible status item has a real data source and an
unknown or failed event degrades visibly rather than silently.

## Milestone 3 — clean the product boundary

Follow the repository migration plan. Consolidate into one repository, remove
the nested Git/submodule mechanics, reduce inherited Qwen surface, retire the
old `lab-agent` path, and replace contradictory documentation with the concise
Project-LAL documentation set.

Exit criterion: one clone has one authoritative README, one dependency story,
one release path, one protocol source, and no misleading upstream-facing
installation or telemetry flow.

## Milestone 4 — restore only proven capabilities

Bring back capabilities one at a time, only after the foundation flow stays
healthy:

- Chat and code parity required for daily work.
- Deliberate research after its artifacts and failure states are reliable.
- Hive only when its workflow lifecycle, process ownership, and evidence view
  are reliable; do not add remote project mutation before the client dispatch
  boundary is proven.
- Training and benchmarking only with bounded storage, reproducible fixtures,
  and a useful evaluation result.

Open-inquiry fine-tuning and new dataset generation are deferred. Existing
experiments have not yet produced significant results, so they are evidence to
summarize—not a reason to spend more GPU or disk.

## Later portability work

1. Run the host stack on Windows for a same-machine fallback.
2. Make host, ports, storage roots, and model backends configurable rather than
   tied to `main-pc` or a specific GPU.
3. Support Android/Termux as a client and observer where it adds real value.
4. Revisit macOS only when there is an actual user or maintainer need.

## Not current work

- A public launch, marketplace, community workflow, or broad contribution setup.
- New model-training campaigns or committing large datasets.
- Desktop app, IDE integrations, SDK maintenance, enterprise channels, or
  computer-use automation.
- Cosmetic redesign that conceals missing system truth.
