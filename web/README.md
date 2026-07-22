# Local AI Lab

Local AI Lab is a local-first model workbench. In addition to chat, coding, training, benchmarks, and persistent agent runs, it includes a typed **Hive** runtime for evidence-first research and verified coding workflows.

## Models

Open `/models` to see the actual local inventory, scan roots, active backend,
server build, and verified/native context limits. An empty inventory is shown
separately from a failed scan, and every page links back to the diagnostic when
models are unavailable.

The same page searches Hugging Face, inspects a commit-pinned GGUF file and its
license, and creates a durable download job only after explicit license
acceptance. Progress, cancellation, SHA-256 verification, model selection,
deletion, export, rescan, and context optimization are available without
leaving the app.

Production rebuilds should use `scripts/rebuild-local-ai-lab.sh`. It builds into
an isolated candidate directory, swaps only a successful build into service,
health-checks it, and restores the previous build if activation fails.

## Hive runtime

Open `/hive` to start and inspect a workflow. Hive uses deterministic, versioned DAG templates with bounded model-selected work. The coordinator only emits `dispatch`, `retry`, `verify`, `replan`, `finish`, or `request_user`; it has no worker tools.

State is checkpointed in `.data/hive.db` with Node 24's built-in SQLite. Large source snapshots and artifacts are content-addressed under `.data/hive/artifacts/`. The existing detached run manager remains the SSE, cancellation, and approval backbone, so a workflow can be reattached or resumed without repeating completed nodes.

Default effort budgets are:

- Normal: one repair cycle.
- Thorough: three repair cycles.
- Extra: six repair cycles.

Coding workflows use a three-role core (coordinator/planner, coder/repairer,
verifier), observable workspace mutations, fresh post-mutation checks, and an
independent post-repair review. The Hive Workspace tab shows the live file tree,
read-only code, decoded write drafts, plans, research, and artifacts in one view.
Qwen3-4B specialist LoRAs can share one resident base and are selected per request;
candidate training and promotion are documented in
[`../docs/hive-specialist-training.md`](../docs/hive-specialist-training.md).

Core endpoints:

- `GET|POST /api/hive/workflows` — list/start workflows and inspect templates, roles, budgets, and discovered models.
- `GET /api/hive/workflows/:id` — graph, typed node results, evidence, events, and deterministic diagnosis.
- `POST /api/hive/workflows/:id/{pause,stop,resume,replay,approve}` — lifecycle and approval operations.
- `POST /api/hive/workflows/:id/override` — while paused, retry a node or skip a predefined optional node.
- `GET|POST /api/hive/models` — discover or capability-probe a model before role assignment.
- `GET /api/hive/artifacts/:hash` — read a content-addressed artifact.
- `POST /api/hive/evaluation` — evaluate hive or specialist promotion gates.
- `GET|POST /api/hive/provenance` — immutable JSONL manifests, quarantined corrective examples, checkpoint lineage, promotion, and attribution reports.
- `GET /api/hive/self-test` — deterministic routing/schema/isolation regression battery (at least 25 cases).

Model probing checks backend compatibility, structured output, tool calling, context configuration, throughput, and memory metadata. Training examples retain stable IDs, hashes, source/license/generator/parents/role/checks/time and exact dataset membership. Training approval and active-role promotion are separate decisions.

## Running this app

This app is meant to be launched from the repo root, not started here directly — see
the root [`README.md`](../README.md) and `../start.sh`, which builds, frees the port,
exposes the app on your tailnet, and starts it on **:8770**.

For iterating on the frontend alone, `npm run dev` works as usual and serves on
**:3000** by default — just note the production path (`start.sh`) always uses 8770.

The UI uses local system fonts, so development and production builds do not depend on
a font CDN.
