# Project-LAL architecture and operator handbook

This is the map of the system that exists in this repository. It is written for
an owner who may need to understand, explain, operate, and repair Project-LAL
without an agent or an internet connection.

The short version is:

> Project-LAL is a local control plane around model servers. The web host owns
> models, GPU scheduling, durable history, training, and measurement. A browser
> is a view and controller. The `lal` terminal client can borrow inference from
> the host while keeping project files and tools on the computer where the
> project actually lives.

The system is intentionally not one giant executable. It is a set of processes
and durable files with explicit boundaries between them.

## 1. The mental model

Imagine a workshop:

- The **web host** is the workshop manager. It receives requests, keeps records,
  decides which model is loaded, and starts specialist machinery.
- A **model backend** is the engine. It turns messages into tokens. Project-LAL
  currently uses either Ollama or `llama-server`.
- A **run** is a job folder and logbook. It survives the browser going away.
- The **browser** is a window into the workshop. Closing the window should not
  destroy the job.
- The **terminal client** is a remote worker. It sends thinking work to the host
  GPU, but uses files and tools on its own computer.
- **Hive** is an adaptive workflow policy and visualization surface. It chooses
  a direct artifact path, iterative research, staged coding, or an explicit
  saved graph; checks task evidence and persists checkpoints.
- **Training and benchmarks** are the improvement loop. Training creates a
  candidate; benchmarks decide whether the candidate is actually better.

There are two supported physical arrangements.

### Everything on one machine

```text
Browser
   │ HTTP/SSE
   ▼
Next.js host :8770
   ├── durable state in web/.data/
   ├── local project tools
   ├── training processes
   └── model request
          ├── llama-server :8099 ── local GGUF
          └── Ollama       :11434 ── Ollama model
```

### Terminal on one machine, GPU host on another

```text
Windows/Linux/macOS project machine
┌─────────────────────────────────────────────┐
│ lal terminal UI                             │
│ file, Git, shell, LSP, MCP and approvals    │
│ execute here, beside the real project       │
└──────────────────┬──────────────────────────┘
                   │ authenticated HTTP/SSE
                   │ usually over Tailscale/LAN
                   ▼
Linux GPU host
┌─────────────────────────────────────────────┐
│ Next.js host :8770                          │
│ inference, model settings, durable run log  │
│ Ollama :11434 or llama-server :8099         │
└─────────────────────────────────────────────┘
                   ▲
                   │ same run can be observed
                   │ or continued with text
               Phone browser
```

The most important boundary in the second diagram is this:

> The host must not pretend it owns a path on the terminal machine.

The terminal may send a display label such as a project name and may mirror
observable events. The host does not resolve that label as a server path. This
is why terminal file operations continue to work against the correct machine
and why the phone bridge is limited to submitting text rather than remote shell
commands.

## 2. The five kinds of truth

When diagnosing Project-LAL, first decide which kind of truth you are looking
for. Many confusing failures come from reading the wrong one.

| Kind | Meaning | Primary location |
|---|---|---|
| Source truth | What the software is supposed to do | tracked files in this repository |
| Build truth | The compiled web/CLI code currently available | `web/.next/`, `apps/cli/dist/` and CLI package outputs |
| Runtime truth | What is alive right now | `/api/sysinfo`, systemd, process list, model backend health |
| Durable local truth | Conversations, runs, settings, benchmarks, jobs | `web/.data/` and platform data directories |
| Model/artifact truth | Large weights, adapters, datasets and logs | `models/`, `out/`, `data/`, `llama/` |

A Git commit can be current while the deployed build is old. A deployed build
can be healthy while a model backend is dead. A backend can be healthy while a
particular run is stuck. Always name the layer before changing anything.

## 3. The request spine

Almost every feature follows the same spine:

```text
user action
   ↓
React page in web/src/app/
   ↓ fetch or EventSource
route handler in web/src/app/api/
   ↓
domain/runtime module in web/src/lib/
   ├── durable write to web/.data/
   ├── tool/process action
   └── inference through Ollama or llama-server
   ↓
append events to a run ledger
   ↓
SSE replay + live tail
   ↓
one or more browser/terminal views
```

This division answers the most common “where do I change this?” question:

- Appearance and interaction belong in `web/src/app/` or
  `web/src/components/`.
- HTTP validation and response shape belong in `web/src/app/api/`.
- Reusable behavior and durable rules belong in `web/src/lib/`.
- Host lifecycle belongs in shell scripts and `deploy/systemd/`.
- Native terminal behavior belongs under `apps/cli/`.
- Shared host/terminal wire vocabulary belongs in `packages/protocol/`.

Do not put important business rules only in a React page. A phone, terminal, or
reattached client must see the same truth.

## 4. What happens during common operations

### 4.1 Web chat

1. `/chat` renders `web/src/app/agent/agent-chat.tsx`.
2. The browser posts messages to `/api/agent/chat`.
3. The route stores or updates a conversation under
   `web/.data/conversations/`.
4. It calls `startRun()` and immediately returns a `runId`. A cold model load
   therefore does not hold the original browser request open.
5. `activatePublicModel()` chooses and verifies Ollama or `llama-server`.
6. Tokens, thinking, usage, confidence, loading state, and final status are
   appended to `web/.data/runs/<run-id>.ndjson`.
7. The browser attaches to `/api/agent/runs/<id>/stream`. The stream first
   replays stored events, then tails new events.
8. Partial assistant text is periodically checkpointed into the conversation
   so a process restart does not erase the entire reply.

Image attachments use an Ollama vision model. Text models can use either
backend.

### 4.2 Web coding agent

1. `/code` posts the selected project, model, mode, prompt, and approval policy
   to `/api/agent/loop`.
2. The route resolves only a granted workspace. The default repository
   workspace is the compatibility exception; other roots must exist in the
   workspace grant repository.
3. `makeAgentExecutor()` constructs the tool palette.
4. `runToolLoop()` repeatedly:
   - sends messages and tool schemas to the model,
   - parses streamed text/thinking/tool calls,
   - validates tool arguments,
   - requests approval where policy requires it,
   - executes the tool,
   - appends the result to the model conversation and run ledger,
   - checks context, repetition, completion, mutation, and verification guards.
5. The browser renders the same durable event vocabulary used by replay.

The local web agent’s base filesystem and shell implementation is in
`web/src/lib/tools.ts`. Additional abilities such as research, memory, training,
image description, benchmarks, and helper agents are assembled in
`web/src/lib/agent-tools.ts`.

Workflow modes are enforced by removing tools, not merely by asking the model
to behave:

- a planner can inspect and research but cannot edit;
- an implementer can edit and test but cannot fall back into endless research;
- an orchestrator must delegate rather than secretly doing worker work.

### 4.3 Native `lal` terminal session

The terminal is derived from Qwen Code. Its inherited foundation supplies the
terminal UI, local tool loop, approvals, session recovery, MCP/LSP, sandboxing,
Git/worktree support, and headless modes. Project-LAL adds the managed host
connection, local-first policy, remote run mirroring, release/update path, and
product restrictions.

For a normal model turn:

1. The terminal loads its settings and project context locally.
2. Its OpenAI-compatible provider points at
   `/api/llm/v1/chat/completions` on the Project-LAL host.
3. The host authenticates the pairing token, applies the owner’s durable model
   settings, filters the terminal tool schemas through the shared allowlist,
   obtains the single-GPU lease, and activates the requested model.
4. The model’s tool call comes back to the terminal.
5. The terminal asks for local permission and executes the tool locally.
6. The result is sent in the next model turn.

When remote-control/run mirroring is active:

1. The terminal registers a client-owned run at `/api/lal/runs`.
2. The host creates a run ID plus per-run ingest and control capabilities.
3. The terminal mirrors text, thinking, tool activity, approvals, usage, and
   checks into the host ledger.
4. It heartbeats. After missed heartbeats the host marks the run interrupted
   instead of claiming it is still alive.
5. A phone may enqueue only a bounded text submission. The terminal leases,
   accepts, and acknowledges that command.
6. Stop becomes a cancellation request observed by the terminal heartbeat.

The remote bridge deliberately cannot send an arbitrary shell command, tool
call, approval, or filesystem path.

### 4.4 Hive workflow

Hive is not a free-form “group chat of agents.” It is a versioned directed
acyclic graph (DAG):

```text
task envelope
   ↓
recorded workflow-policy decision
   ↓
direct, research, staged, or saved workflow
   ↓
ready node selected from dependencies
   ↓
role + bounded handoff + model capability match
   ↓
stage result with findings/artifacts/evidence/checks
   ↓
verification gate
   ├── pass → next node
   └── fail → bounded retry/repair/replan
```

Important files:

- `web/src/lib/hive/contracts.ts` defines the data shapes.
- `packages/protocol/src/agent-runtime.js` with
  `packages/protocol/src/agent-runtime.d.ts` defines surface-neutral completion,
  research-coverage, event, and artifact-validator contracts.
- `web/src/lib/hive/orchestration-policy.ts` records why a workflow was chosen.
- `web/src/lib/hive/presets.ts` defines roles, budgets, and workflow graphs.
- `web/src/lib/hive/engine.ts` executes and resumes workflows.
- `web/src/lib/hive/store.ts` owns SQLite checkpoints, events, approvals,
  side-effect fingerprints, evidence, and artifacts.
- `web/src/lib/hive/model-registry.ts` discovers and probes model capabilities.
- `web/src/lib/hive/autopsy.ts` diagnoses workflow failures.
- `web/src/lib/hive/mission-dashboard.ts` produces correlated live projections.
- `web/src/lib/hive/post-run-report.ts` produces evidence-linked run reports.
- `web/src/lib/hive/provenance.ts` tracks training examples and checkpoints.

The coordinator has no worker tools. Specialist boundaries carry a typed,
bounded handoff rather than the entire preceding transcript. Side effects are
fingerprinted so an interrupted resume can distinguish “safe to replay” from
“outcome uncertain.”

Scheduler completion and task completion are different. New terminal task
outcomes are `complete`, `incomplete`, `blocked`, `cancelled`, and `failed`.
Only runtime acceptance evidence can produce `complete`.

Hive has two durable views of the same execution:

- the general run ledger powers SSE, stop, and reattachment;
- `web/.data/hive.db` stores graph-specific state and checkpoints.

### 4.5 Train, benchmark, promote

The intended improvement loop is:

```text
use → record failures → build/curate data → train candidate
    → benchmark champion and candidate → promote or reject
```

Training:

- The `/train` page calls `/api/train`.
- `startTrain()` in `web/src/lib/lab.ts` validates the configuration and starts
  a Python training script.
- Training scripts live in `scripts/`.
- Source datasets live under `data/`.
- Checkpoints, adapters, converted GGUF files, and logs live under `out/`.
- Deployable local GGUF models live under `models/`.
- Run summaries live under `web/.data/experiments/`.

Benchmarks:

- Suites are seeded from `web/src/lib/seed-suites/` or stored locally under
  `web/.data/suites/`.
- `runBench()` performs inference.
- `web/src/lib/graders.ts` scores outputs and expected tool behavior.
- Results live under `web/.data/bench/`.
- The battery identifies a champion and optional challenger in
  `web/.data/battery.json`.

Training completion does not prove improvement. A candidate becomes useful only
after an appropriate held-out measurement shows it improved without unacceptable
regression.

## 5. The major runtime modules

### `web/src/lib/lab.ts`: the current host kernel

This large file is the practical center of the web host. It currently owns:

- model discovery and settings;
- Ollama and `llama-server` activation;
- context profiles and GPU offload state;
- the one-model-at-a-time serving singleton;
- conversations and projects;
- benchmark suites and results;
- the document library and retrieval;
- web search;
- training, checkpoint comparison, and experiments;
- lens/model-inspection processes.

If a symptom crosses several UI pages, this is often the first domain file to
inspect. Its size also means changes here have a wide blast radius.

### `web/src/lib/runs.ts`: durable execution

For every ordinary run:

- `<id>.json` is compact metadata and current status.
- `<id>.ndjson` is an append-only sequence of events.

Live-only objects such as `AbortController`, stream subscribers, and approval
promises live in a `globalThis` singleton inside the one Node process.

On restart, a server-owned run that was still marked running is changed to
`interrupted`; the software does not pretend the lost JavaScript promise is
still executing. A terminal-owned run is judged through heartbeats.

The SSE attach algorithm subscribes first, replays the file, then flushes the
live buffer. This avoids both a replay/live gap and duplicate events.

### `web/src/lib/toolloop.ts`: the agent turn controller

This is the model/tool state machine. It handles streaming, native and recovered
tool calls, context estimation, compaction, duplicate-call defense, tool
validation, approvals, research-depth gates, mutation requirements, and
completion nudges.

If the model talks but never acts, loops, stops too early, loses tool calls, or
overflows context, inspect this file and the corresponding run ledger.

### `web/src/lib/tools.ts`: the local execution boundary

This file defines core tool schemas and implements workspace-contained file,
shell, and Git operations.

Key safety rules include:

- path resolution rejects lexical and symlink escapes;
- Hive shell commands use Bubblewrap with a writable workspace, masked home and
  temporary directories, and no network;
- destructive recursive deletion is blocked in the sandboxed shell;
- Git uses argv rather than a shell string;
- mutating Git operations require approval and some dangerous forms are refused.

### `packages/protocol/src/`: shared wire and task-runtime law

The host and terminal must agree on event names and terminal tool identity. That
contract lives here:

- protocol version;
- run/event types;
- context and working-state types;
- known event kinds;
- the terminal tool allowlist;
- task completion, research coverage, and artifact-validator contracts.

`scripts/sync-protocol.mjs` makes the web install’s copy deterministic.
`scripts/check_protocol_drift.mjs` and the protocol tests detect stale copies.

When adding a run event or changing a terminal boundary, start here and update
both consumers through the sync/check path.

## 6. Directory atlas

### Tracked product source

| Path | Purpose |
|---|---|
| `web/` | Next.js user interface, HTTP API, host runtime, and tests |
| `web/src/app/` | pages and route handlers |
| `web/src/components/` | reusable visual components |
| `web/src/lib/` | domain logic and runtime services |
| `apps/cli/` | Qwen-derived native terminal client and its workspaces |
| `packages/protocol/` | shared host/terminal event and tool contract |
| `scripts/` | doctor, build/deploy, smoke tests, data preparation, training, evaluation, release |
| `deploy/systemd/` | Linux user-service definition |
| `bin/` | launchers, compatibility commands, pairing/device helpers |
| `tests/` | root-level distribution and launcher tests |
| `data/` | small tracked guidance plus untracked local training datasets |

### Local, generated, or machine-shaped

| Path | Purpose | Safe to recreate? |
|---|---|---|
| `web/node_modules/` | web dependencies | yes, with `npm --prefix web install` |
| `apps/cli/node_modules/` | CLI dependencies | yes, with `npm --prefix apps/cli install` |
| `web/.next/` | active compiled web build | yes, but use the safe rebuild path |
| `web/.data/` | owner state and history | **no; back it up** |
| `models/` | local GGUF models and adapter manifests | only by redownload/retraining |
| `llama/` | local llama.cpp build/tooling | yes if build source/process is available |
| `out/` | training outputs, checkpoints, adapters, and logs | often expensive or impossible to reproduce exactly |
| `.venv/` | Python training environment | yes from known dependencies |
| `workspace/` | default agent workspace | depends on its contents |

Git deliberately ignores machine-shaped directories. A clone contains source,
not the owner’s models, runtime data, Python environment, compiled web bundle, or
CLI release archives.

## 7. Durable state atlas

All relative paths below are under `web/.data/` unless stated otherwise.

| File/directory | Contents |
|---|---|
| `settings.json` | selected model, global defaults, per-model runtime settings, system prompt toggles |
| `context-profiles.json` | requested, active, verified context and hardware fingerprint |
| `conversations/*.json` | chat and code transcripts |
| `runs/*.json` | run metadata/status |
| `runs/*.ndjson` | append-only run events |
| `runs/*.client.json` | hashed per-run terminal capabilities and command queue |
| `cli-token` | owner pairing bearer token; secret |
| `cli-devices.json` | connection metadata, not prompts or bodies |
| `workspace-grants.json` | explicit browser-accessible filesystem roots |
| `hive.db*` | Hive SQLite database plus WAL files |
| `hive/artifacts/` | content-addressed Hive artifacts when present |
| `bench/*.json` | benchmark results |
| `suites/*.json` | owner-created benchmark suites |
| `battery.json` | champion/challenger suite battery |
| `experiments/*.json` | training experiment summaries |
| `docs/*.json` | imported document-library text |
| platform state `jobs.sqlite*` | durable general job ledger when initialized; on Linux this defaults below `~/.local/state/project-lal/` |
| `model-imports/` or platform data | verified download staging and artifact records |
| `runtime/process-events.ndjson` | bounded process observation journal |
| `usage/YYYY-MM.ndjson` | append-only token/request usage ledger |
| `agent-memory/` | retrieved session/daily/digest memory |

Project memory is intentionally split:

- `<project>/.agent-memory/*.md` contains small standing facts injected across
  project sessions;
- `web/.data/agent-memory/` contains larger retrieved history keyed by a
  path-derived project slug.

Do not copy only `.git` and assume the system is backed up. The owner’s lived
state is mostly outside Git.

## 8. Ports and processes

| Port/process | Owner | Purpose |
|---|---|---|
| `8770` | Next.js production host | UI and API |
| `3000` | Next.js development host | frontend development default |
| `8099` | Project-LAL-managed `llama-server` | OpenAI-compatible serving for local GGUF |
| `11434` | Ollama daemon | Ollama native and OpenAI-compatible inference |
| `8443` | Tailscale Serve listener | tailnet HTTPS proxy to host `8770` |

On the present Linux host:

- `project-lal.service` runs `web/run_web.sh`;
- `run_web.sh` starts the compiled Next app and applies the current AMD
  compatibility environment;
- the web process starts `llama-server`, training, and lens processes on demand;
- Ollama is an external daemon even though Project-LAL asks it to load/unload
  models;
- the runtime status page distinguishes managed, external, and unknown/stale
  processes.

The GPU is effectively a singleton. Model swaps drain active generations before
teardown. CLI requests are serialized with an in-process lease. This is a
constraint of the current 8 GB host, not a claim that the product must always
run only one request.

## 9. Model routing and context

A public model is discovered from:

- local files named `<name>-q4.gguf` or `<name>-f16.gguf` in a model directory;
- Ollama manifests in its store.

Local q4 is preferred over f16 because the current GPU cannot fit large f16
weights efficiently. Ollama models route to Ollama; local GGUFs route to
`llama-server`.

For every activation, do not confuse:

- **model maximum**: metadata says what the architecture can support;
- **requested context**: owner policy asks for this many tokens;
- **active context**: backend actually allocated this many;
- **verified context**: a probe proved it works.

`context-profiles.json` keeps these separate and fingerprints the model/backend
environment so stale verification is not presented as current fact.

The model control sequence is:

```text
discover → choose backend → drain old generation → unload conflicting backend
→ start/load requested model → health check → verify model/context/offload
→ publish model_ready → begin generation
```

If the UI says “loading forever,” inspect the run events, `out/llama-server.log`,
Ollama status, and `/api/sysinfo` before changing a React spinner.

## 10. User surfaces

| Page | What it controls | Main backend area |
|---|---|---|
| `/` | configurable dashboard and global stop | dashboard routes, sysinfo |
| `/chat` | ordinary durable conversation, documents/web grounding, artifacts | agent chat route, `lab.ts`, `runs.ts` |
| `/code` | project agent, files, Git, approvals, research/deliberation | agent loop routes, tool loop/executors |
| `/hive` | graph workflows, roles, evidence, workspace, audit, replay | Hive engine/store/routes |
| `/train` | datasets, configurations, training runs, comparison | train routes, `lab.ts`, Python scripts |
| `/models` | inventory, model settings, download/import, context probe | model/acquisition routes and libraries |
| `/monitor` | host/GPU/process facts | sysinfo/runtime status |
| `/library` | conversations, run traces, autopsies, documents | conversation/run/docs routes |
| `/benchmark` | suites, batteries, result comparison | bench/suite routes, graders |
| `/lens` | token/layer inspection | lens route and Python helper |

The navigation globally exposes an active run and resident GPU model because
those are host-wide facts, not page-local decorations.

The desktop sidebar (`web/src/app/nav.tsx`) is the only desktop navigation:
a Workspace group (Home, Chat, Code, Hive, Guardian) and a Lab group
(Training, Models, Evaluation, History, CLI). `LabNav` renders only below the
`md` breakpoint, where the phone tab bar has a single "Lab" entry. In-page view
switchers use the shared `.seg` segmented-tab class.

**Design tokens.** `design/tokens.json` is the single source for color, type,
spacing, radius, motion and layout values. `npm run tokens` runs
`scripts/build-design-tokens.mjs`, which generates:

- `web/src/app/tokens.css`: CSS variables, legacy aliases (`--accent-ai`,
  `--surface-1`, …) and a Tailwind `@theme` bridge;
- `web/src/lib/design-tokens.ts`: raw values for canvas charts, manifest and
  viewport metadata;
- `apps/cli/packages/cli/src/ui/themes/lal-palette.ts`: the `LAL Dark` / `LAL
  Light` terminal palettes and brand colors.

The build fails if any text/background pair drops below WCAG AA (4.5:1), and
`npm run tokens:check` (part of `npm test`) fails if a generated file is stale.
Fonts (Satoshi, JetBrains Mono) are bundled in `web/src/app/fonts/`; no remote
font request is made.

## 11. Authentication and authority

Project-LAL currently assumes a private, single-owner environment.

The terminal boundary uses:

- a random bearer pairing token in `web/.data/cli-token` or `LAL_CLI_TOKEN`;
- constant-time token comparison;
- device headers for attribution;
- per-run ingest and remote-control capabilities stored as hashes;
- bounded event batches and a known-event allowlist.

Important limitations:

- Browser routes are not a finished multi-user authorization system.
- Next.js route handlers do not expose the accepted socket peer, so forwarded
  address headers are not trusted as identity.
- Tailscale headers are trustworthy only with a verified loopback proxy path;
  the current request layer cannot prove that peer and therefore does not
  elevate those headers into universal identity.
- Possession of the pairing token is the present owner boundary. Protect
  `cli-token`, terminal `~/.lal/.env`, and remote-control deep links.

Filesystem authority is separate from identity. The workspace grant repository
fails closed on invalid state, canonicalizes real directories, and checks
containment before browser filesystem routes operate.

## 12. Startup, build, update, and rollback

### Preflight

```bash
npm run doctor
```

This separates:

- required cross-platform dependencies;
- optional capability dependencies;
- Linux/AMD development-host specifics.

Fix required failures first. Optional misses explain a missing feature rather
than proving the whole application is broken.

### Development

```bash
npm --prefix web run dev
```

This serves the development build, normally on port 3000. It is not the
production service on 8770.

### Safe production rebuild

```bash
bash scripts/rebuild-local-ai-lab.sh
```

The rebuild script:

1. takes a lock;
2. refuses to replace the app during live agent, lens, or training work;
3. builds into an isolated candidate directory;
4. leaves the active build untouched on compilation failure;
5. stops the service and atomically swaps the successful candidate;
6. starts and health-checks it;
7. restores the last good build if activation fails.

This exists because compiling directly into the live `.next` directory can
produce HTML that points at half-replaced assets.

### Complete host update

```bash
./update-all.sh
```

This is the canonical all-parts update on the current Linux host. It orders:

1. CLI version/release preparation;
2. CLI package and executable builds;
3. managed Ollama profile preparation;
4. connected-client packaging when enabled;
5. safe web deployment;
6. Tailscale route refresh and verification;
7. local CLI/settings/prompt refresh;
8. optional smoke testing.

A Git pull alone does not update a compiled Windows terminal client.

## 13. The offline troubleshooting ladder

Do these in order. Do not begin by deleting caches or reinstalling everything;
that destroys evidence and mixes layers.

### Step 1: Define the failed path

Write one sentence:

```text
On [browser/terminal], when I [action], I expected [result], but observed [exact symptom].
```

Record whether chat, code, Hive, training, models, or the entire host is
affected. A working chat narrows the problem differently from a working UI with
no model responses.

### Step 2: Check prerequisites and source state

```bash
npm run doctor
git status --short
git log -1 --oneline
```

This tells you whether the machine can run the source, whether local work is
present, and which code revision you are examining.

### Step 3: Check the host

```bash
curl --fail-with-body http://127.0.0.1:8770/api/sysinfo
systemctl --user --no-pager --full status project-lal.service
journalctl --user -u project-lal.service -n 200 --no-pager
```

If port 8770 is dead, do not investigate model prompts yet.

### Step 4: Check model engines

```bash
curl --fail-with-body http://127.0.0.1:8099/health
ollama ps
curl --fail-with-body http://127.0.0.1:11434/api/tags
```

Only one backend may be relevant to the chosen model. `8099` can correctly be
absent when no local GGUF is loaded.

Inspect:

```text
out/llama-server.log
```

for a local GGUF load or generation failure.

### Step 5: Find the run

Use `/library`, `/api/agent/runs`, or inspect:

```text
web/.data/runs/<run-id>.json
web/.data/runs/<run-id>.ndjson
```

The final events answer:

- Did model loading begin and finish?
- Did tokens arrive?
- Did the model request a tool?
- Was approval denied or never answered?
- Did a tool return an error?
- Was context exhausted or compacted?
- Did the run finish, stop, error, or become interrupted?

Run autopsy logic lives in `web/src/lib/autopsy.ts`; Hive has its own diagnosis
in `web/src/lib/hive/autopsy.ts`.

### Step 6: Check ownership

For a terminal run ask:

- Does metadata say `executionLocation: "client"`?
- Is the terminal still heartbeating?
- Is the host reachable with the pairing token?
- Is the failing tool local to the terminal machine?
- Is the UI incorrectly trying to open a server path for a client-owned run?

For a web/Hive run ask:

- Is the selected workspace granted?
- Does the path resolve within that workspace?
- Is Bubblewrap available for the sandboxed Hive shell?

### Step 7: Reproduce with the smallest contract

Use the smallest relevant check:

```bash
npm run test
npm run cli:test
npm run smoke:attach
npm run smoke:terminal
npm run smoke
```

`smoke` and `smoke:terminal` use real host/model resources and should run only
when the host is idle. Unit tests can prove logic; smoke tests prove that
processes, routes, credentials, and a real model work together.

### Step 8: Change the owning layer

Change the first layer whose evidence is wrong, then rerun the narrow check and
the broader acceptance check. Do not repair a backend failure by hiding it in
the UI.

## 14. Symptom-to-location guide

| Symptom | Inspect first |
|---|---|
| Entire site unavailable | service status, journal, port 8770, `web/run_web.sh` |
| UI changed in source but not in browser | deployed revision/build, safe rebuild, browser asset response |
| One page crashes | browser error plus that page and its `/api/...` response |
| Model list empty | `/api/agent/models`, model scan roots, `models/`, Ollama store |
| Model load hangs or crashes | run ledger, `lab.ts`, `out/llama-server.log`, Ollama |
| Wrong context displayed | `settings.json`, `context-profiles.json`, runtime `model_ready` event |
| Agent talks but never edits | tool schemas, tool loop events, mode-specific tool palette |
| Tool call malformed or buried in thought | `toolloop.ts`, `tool_request`/`think_recovered` events |
| File tool says path escape | selected/granted workspace, symlink, `resolveSafe()` |
| Shell works in web code but not Hive | Bubblewrap sandbox and network isolation in `tools.ts` |
| Approval waits forever | run’s `approval_needed`, live process, approval route, client reattach |
| Browser closed and work vanished | run status/ledger, conversation checkpoints, service restart time |
| Terminal inference works but file action fails | terminal tool/permission/shell; file execution is client-local |
| Terminal absent from browser | pairing token, device ID, run registration, heartbeat, mirror |
| Phone text not reaching terminal | client run capability, command queue/lease, heartbeat and ack |
| Bench page blank/wrong | result shape in `.data/bench`, bench route, `listBench()` |
| Training does not start | active run/GPU guard, Python env, dataset, experiment/log in `out/` |
| Hive cannot resume | `hive.db`, workflow/node status, run ledger, side-effect record |
| High idle GPU usage | `/api/sysinfo`, resident model, idle setting, active run guard |
| Protocol/tool mismatch | `packages/protocol`, sync script, drift and visibility checks |

## 15. Change-location guide

| Desired change | Begin here |
|---|---|
| Add or rearrange a page | `web/src/app/<page>/page.tsx`, `web/src/app/nav.tsx` |
| Change shared styling | `design/tokens.json` then `npm run tokens`; `web/src/app/globals.css`, `web/src/components/ui/` |
| Change an API payload | matching `web/src/app/api/**/route.ts` plus callers/tests |
| Add a web-agent tool | `agent-tools.ts` or `tools.ts`, tool palette, validation, tests |
| Change approval/sandbox rules | `tools.ts`, run approval path, security tests |
| Change loop/completion behavior | `toolloop.ts` and its acceptance measurement |
| Change run lifecycle/replay | `runs.ts`, protocol, stream routes, attach smoke test |
| Add an event type | `packages/protocol/src/index.ts`, sync, both renderers, conformance tests |
| Change model defaults/settings | `lab.ts`, settings routes/UI, context-profile tests |
| Support a new model backend | capability registry, `lab.ts`, model routes, runtime status |
| Add a Hive role/node/workflow | contracts/presets/engine/store plus graph/self-tests |
| Change training recipe | Python script, `startTrain()`, dataset contract, benchmark gate |
| Change a benchmark | seed suite/custom suite, `graders.ts`, result compatibility |
| Change terminal UI/tool behavior | `apps/cli/packages/cli` or `packages/core` |
| Change host-terminal connection | CLI `src/lal/`, `/api/lal`, LLM gateway, protocol |
| Change installed CLI release | CLI build/bundle, release scripts, manifest, installer tests |
| Change production lifecycle | `update-all.sh`, rebuild script, service unit, smoke checks |

For inherited CLI functionality, locate the implementation before editing:

```bash
rg "visible label or command name" apps/cli/packages
```

Most native agent mechanics live in `apps/cli/packages/core`; terminal
presentation and command wiring live in `apps/cli/packages/cli`. Project-LAL
connection-specific additions are intentionally grouped under
`apps/cli/packages/cli/src/lal/`.

## 16. How to read an unfamiliar feature

Use this repeatable method:

1. Find the visible text or route name with `rg`.
2. Open the page component and list every API endpoint it calls.
3. Open those route handlers and list every library function they call.
4. Find where those functions read/write files, spawn processes, or call a
   backend.
5. Find the event types emitted and how the UI renders them.
6. Find the closest unit test and smoke test.
7. Inspect one real durable record produced by the feature.

That produces a complete vertical slice from button to disk/process and back.
It is more reliable than reading directories alphabetically.

## 17. Backup and recovery

Before a risky host repair, preserve at minimum:

```text
web/.data/
models/
out/                         if training artifacts matter
data/                        if local datasets matter
workspace/                   if it contains owner work
<projects>/.agent-memory/
~/.lal/                      on paired terminal machines
```

Also record:

```bash
git log -1 --oneline
node --version
npm --version
ollama --version
```

Never restore `node_modules` or `.next` from another operating system as though
they were owner data. Reinstall/rebuild them on the target machine.

If the compiled web build is bad but source and state are intact, the safe
rebuild script can restore the last good build during activation. If the Node
process crashed mid-run, expect server-owned runs to become `interrupted`; use
the ledger and conversation checkpoint to decide whether to continue or replay.

## 18. Known structural limits

These are important when deciding whether behavior is a bug or an unfinished
boundary:

- The supported production service path is currently Linux/systemd-shaped even
  though much of the product logic is portable.
- Host monitoring reads Linux `/proc`, `/sys`, and systemd information and
  degrades on other platforms.
- The current host is tuned for one AMD RDNA2 8 GB GPU. Serialization, context
  compromises, and HQQ training are hardware adaptations.
- `lab.ts` still combines several domains. It is a practical kernel, not a clean
  final modular architecture.
- Browser authentication is not a finished multi-user security system.
- A live server-owned JavaScript job cannot survive a full web-process restart;
  its durable history survives and is marked interrupted. Hive adds checkpoints
  that support explicit resume.
- A paired terminal’s process-local device ID currently changes across launches;
  the pairing token remains the owner credential.
- Some product capabilities inherited from Qwen Code are much larger than
  Project-LAL’s intentionally exposed terminal tool boundary.

Do not “fix” these by weakening truthful status. Preserve the distinction
between unsupported, unavailable, interrupted, empty, and failed.

## 19. Glossary

- **Backend**: the process that actually runs model inference.
- **Candidate**: a trained model/adapter not yet accepted by evaluation.
- **Champion**: the current benchmark reference model.
- **Context**: tokens available to the model for prompt, history, tools, and
  output.
- **Control plane**: Project-LAL’s UI, APIs, scheduling, state, and policy around
  model engines.
- **DAG**: a dependency graph with no cycles; Hive’s workflow shape.
- **Event ledger**: append-only NDJSON history for a run.
- **GGUF**: local model file format served by llama.cpp.
- **Host**: machine/process running the Project-LAL web app and normally the GPU.
- **Inference**: generating model output from input.
- **LoRA/adapter**: smaller trained weights applied to a base model.
- **NDJSON**: one JSON object per line, suitable for append and replay.
- **Owner data**: untracked local state that belongs to the user, not the source
  repository.
- **Run**: durable unit of chat, code, deliberate, terminal, or Hive work.
- **SSE**: Server-Sent Events; one-way HTTP stream used for replay/live updates.
- **Tool loop**: repeated model → tool request → execution → result → model turns.
- **Workspace grant**: durable authority for browser-side filesystem access.

## 20. What to remember if everything else is forgotten

1. The browser is a view; the run ledger is the history.
2. The host owns inference; a paired terminal owns its project tools.
3. Ollama serves Ollama models; `llama-server` serves local GGUFs.
4. `web/src/app` is UI/routes, `web/src/lib` is behavior, `web/.data` is owner
   state, `apps/cli` is the terminal, and `packages/protocol` is their shared law.
5. Diagnose from outside in: prerequisites → host → backend → run → tool.
6. Never call a training result an improvement without a benchmark.
7. Never delete durable state or logs before preserving the evidence.
8. Use `npm run doctor`, the run ledger, and the narrowest relevant test.
9. Deploy through the safe rebuild/update path; source, build, and runtime are
   three different truths.
10. When uncertain, trace one complete vertical slice from UI action to route to
    library to disk/process and back through events.
