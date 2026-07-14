# LAL CLI product plan

Status: approved planning baseline, rewritten 2026-07-14 after a full audit of the
web UI feature set and the fork's actual state. Organizing principle: **the CLI is
the Local AI Lab web experience — chat, code, hive, research, lab — delivered in a
terminal**, not a renamed upstream CLI with LAL colors.
Last updated: 2026-07-14

## Product goal

`lal` must feel like Local AI Lab in a terminal. From any folder on any
Tailscale-connected computer, the user launches one command, selects a Local AI Lab
model and operating mode, sees reasoning and work stream in real time, and lets the
client modify the project on that computer while inference runs on `main-pc`.

Most of the web UI's features — chat with thinking and token confidence, the code
agent with approvals and diffs, HIVE mission control, deliberate research, training
and benchmarking — must be reachable from the CLI. The client must also preserve
project-scoped conversations, resume them from the same folder, update in place,
and identify every connected device.

## Reality audit (2026-07-14)

### The fork is near-vanilla

`lal-cli/` is qwen-code with only the LAL monogram/palette landed
(`packages/cli/src/ui/components/Header.tsx`, `AsciiArt.ts`, `README-LAL.md`,
`NOTICE-LAL.md`). Alibaba/ModelStudio onboarding is intact
(`packages/core/src/providers/presets/alibaba-*.ts`), the model picker is upstream
(`packages/cli/src/ui/models/availableModels.ts`), ~2000 Qwen references remain,
and the only mode-like command is upstream `/effort` with tiers `low..max`.

### The features already exist — in `web/`

Almost everything the CLI needs is already running server-side. The CLI work is
mostly **terminal rendering over existing APIs**, not new backend:

- **Detached runs + resumable stream.** Chat, code, deliberate, and hive all run as
  server-side "runs"; clients attach to `GET /api/agent/runs/{id}/stream` (SSE,
  per-event `seq` as SSE id, full replay from `?after=0`, `Last-Event-ID`
  reconnect). Run manager: `web/src/lib/runs.ts`. Event unions: `ToolLoopEvent` in
  `web/src/lib/toolloop.ts` (including token-probability `p`/`alts` — the J-space
  raw material), `DeliberateEvent` in `web/src/lib/deliberate.ts`, hive events in
  `web/src/lib/hive/engine.ts`.
- **Deliberate research engine** (`web/src/lib/deliberate.ts`): perspective scoping
  → per-role research → cross-examination debate → convergence → synthesis +
  process retrospective, with durable `.md` artifacts.
- **HIVE engine** (`web/src/lib/hive/engine.ts`): staged DAG, typed handoffs,
  verifier verdicts, citation verification, repair loops, pause/resume/replay,
  durable event ledger.
- **Autopsy + report cards** (`web/src/lib/autopsy.ts`): deterministic run
  diagnosis (`GET /api/agent/runs/{id}?trace=1`) and per-model report cards
  (`GET /api/agent/runs/report`).
- **CLI gateway surface**: `/api/lal/client-settings`, `/api/lal/heartbeat`, and
  the OpenAI-compatible `/api/llm/v1/*` endpoints already authenticate CLI devices
  (`web/src/lib/lal-cli.ts`).

The protocol is **not yet versioned** — no schema version field or shared type
module. That, plus terminal rendering, is the genuine net-new work.

## Two execution topologies

Every feature below falls into one of two topologies. This is the architecture
cornerstone; get it right once and every mode reuses it.

1. **Attach topology** — the run executes on `main-pc`; the CLI is a renderer.
   Applies to Chat, Deliberate Research, Hive (research kind), Train, Bench,
   Library, Dashboard/status. The CLI POSTs to start (or lists existing runs),
   then attaches to the same SSE stream the browser uses, replaying from seq 0 on
   resume. Closing the terminal never kills the run.
2. **Local-tools topology** — the tool loop runs **in the CLI on the client
   machine** (inherited qwen-code file/shell/Git/LSP/MCP tools) while inference
   streams from the gateway's OpenAI-compatible endpoint. Applies to Default and
   Code modes. The non-negotiable rule: **project tools execute where the project
   lives.** No server-side path may mutate a remote client's repository.
3. Hive coding on a remote client project = attach topology **plus** reverse tool
   dispatch back to the authenticated client (late phase; see Step 8).

### Cross-device session continuity

A direct consequence of the attach topology, promoted here to a product
requirement: **a session started on one device is live on every other device.**
Start a chat with `lal` on a laptop, open the web UI from a phone over Tailscale,
and the phone must show the same chat streaming in real time and be able to send
the next message; the CLI then shows the phone's turn. This works because
attach-topology sessions are server-side conversations
(`/api/agent/conversations`) and the run stream is multi-client with full replay
— but it only works if the CLI honors three rules:

1. CLI chat/research/hive sessions create and continue **server-side
   conversations**, never a CLI-private history store. `~/.lal/projects` holds
   only local-tools (code) sessions and ledgers.
2. While an attach-topology session is open and idle, the CLI watches for new
   runs on the same `conversationId` started by another device (the web UI's
   resync-on-focus equivalent) and auto-attaches to them.
3. Continuing from any device targets the same conversation id; concurrent sends
   serialize server-side rather than forking the history.

Local-tools code runs execute on the client machine, so other devices cannot
drive them; an opt-in spectator mode (CLI mirrors its local event ledger to the
gateway, read-only) is a P2 follow-up.

## UI → CLI feature parity map

Priorities: **P0** = core parity, must ship; **P1** = full parity; **P2** = nice to
have; **handoff** = CLI opens/prints a Tailscale web URL instead of rendering.

### Chat (`web/src/app/agent/agent-chat.tsx`, `POST /api/agent/chat`)

| Feature (web) | Source | CLI treatment | Priority |
| --- | --- | --- | --- |
| Token streaming w/ think + text events | run stream | streamed markdown in terminal | P0 |
| Collapsible "Thinking…" block | `think` events | collapsible panel, `/thinking` + hotkey | P0 |
| Token confidence (CertaintyWave, avg/low counts, runner-up alts) | `p`/`alts` on text/think events; `certainty-wave.tsx` | unicode sparkline strip + avg%/low count; expand = last-N alts view | P1 |
| Telemetry HUD (ctx fill, tok/s, GPU/VRAM/temp, CPU/RAM) | `usage` events + `GET /api/sysinfo` | one-line status bar; `/status` for full view | P0 |
| Model selection | `GET/PUT /api/agent/models` | `/model` picker: name · family/role · loaded state · ctx | P0 |
| Sampling/system-prompt settings | `PUT /api/agent/models` options | `/settings` form (num_ctx, num_predict, temperature, top_p, top_k, repeat_penalty, system, idle unload) | P1 |
| Sessions: list/open/delete/copy, deep link | `/api/agent/conversations?kind=chat` | `/session` list + `lal --resume` | P0 |
| Reattach-if-live on focus/online | `resync` logic | reattach on CLI start + reconnect | P0 |
| Cross-device continuity: same chat live on phone/web, continue from either device | server-side conversations + multi-client run stream | CLI uses server conversations; idle watch for runs on same conversationId; see "Cross-device session continuity" | P0 |
| Edit message + resend (truncate), delete message, continue truncated reply | `PATCH /api/agent/conversations/{id}`, `continueIndex` | `/edit`, continue prompt on truncation | P1 |
| Web + docs grounding toggles, `/web` `/docs` prefixes | `GET/POST /api/modes` | `/ground web on|off`, `/ground docs on|off`, same one-off prefixes | P1 |
| Image attach → Gemma vision routing (fast/quality badge) | `attachments`, `api/agent/chat/route.ts` | attach by file path; print routed vision model | P1 |
| Voice: STT, mid-stream TTS, voice mode orb, barge-in | Web Speech API + `voice.ts` (browser-only) | **handoff**: `/voice` prints Tailscale URL + QR to web voice UI, same session; native audio revisited later | handoff |
| HTML artifacts + edit-diff blocks | artifact cards in chat | write artifact to file, print path + preview URL | P2 |
| GPU-crash suggestion banner | crash-signature detection | same detection, terminal notice | P2 |
| Handoff chat → code | `POST /api/agent/handoff` | `/mode code` carries the conversation | P1 |
| Stop / stop-all | `/api/agent/chat/stop`, `/api/agent/runs/stop-all` | Esc = stop; `/stop all` | P0 |

### Code (`web/src/app/code/page.tsx`) — local-tools topology

| Feature (web) | Source | CLI treatment | Priority |
| --- | --- | --- | --- |
| Agent loop w/ full event rendering (text/think/tool_request/tool_progress/tool_result/model_loading/nudges/context events) | `applyEvent`, `Ev` union | the core TUI transcript; typed runtime-state line replaces upstream's random phrases | P0 |
| Tool blocks: per-family icon/color, collapsible args, ok/failed state | `ToolBlock`, `TOOL_STYLE` | same visual grammar in terminal (glyph + color + collapse) | P0 |
| Approval flow w/ full args (shell command, git argv) | `approval_needed`/`PATCH /api/agent/loop` | inline approve/deny prompt showing full args; auto-approve toggle | P0 |
| Live diffs for file writes | tool results + git diff | unified diff render on write_file/edit_file | P0 |
| Mode presets: default / quick-edit / planning / deep-research / orchestrator | `MODES` in `api/agent/loop/route.ts` | `/mode` selects preset; budgets (rounds/tokens/ctx/think/temp) shown, mirrored locally | P0 |
| Thinking, auto-approve, auto-continue toggles | page state | `/thinking`, `/permissions`, `/settings` | P0 |
| Project/workspace picker, clone from GitHub, new project | `DirPicker`, `/api/agent/git op:clone` | CLI = cwd is the project (its whole point); `/project` shows identity; clone = `lal clone <url>` convenience | P1 |
| Git panel: status, per-file diff, staged commit | `git-panel.tsx`, `/api/agent/git` | `/git` status/diff/commit on the **local** repo via local git tool | P1 |
| File tree + editor w/ conflict handshake | `file-tree.tsx`, `editor-pane.tsx` | not replicated; `$EDITOR` open + `/tools` file ops; tree = `/project tree` | P2 |
| Dev-server preview w/ Tailscale URL | `run-panel.tsx`, `/api/agent/preview` | `/preview` starts local dev server, prints local + Tailscale URLs | P1 |
| Session resume, runs list, transcript adoption | `/api/agent/conversations?kind=code`, reattach | `/session`, `lal --resume`; local runs persist under `~/.lal/projects` | P0 |
| Autopsy diagnosis + model report cards | `autopsy.ts`, Library Runs tab | CLI writes the same `.ndjson` ledger locally; `/session doctor` runs diagnosis (upload ledger to gateway or vendored rules) | P1 |
| Image attach (upload into project, describe_image) | `/api/agent/upload` | attach by path; local file already in place | P2 |
| Truncation auto-continue (bounded) | `continueRun` | same bounded auto-continue, visible counter | P1 |
| Jump-to-latest scroll stick/unstick | scroll logic | follow-tail mode; any scroll unsticks; End re-sticks | P0 |
| Edit prior user message (rewind) | `editUser` | `/edit` rewinds transcript | P1 |
| Sub-agent output grouping (`agent` tag, spawn_agent) | tools | indented/labelled sub-agent blocks | P1 |

### Hive (`web/src/app/hive/page.tsx`) — attach topology

| Feature (web) | Source | CLI treatment | Priority |
| --- | --- | --- | --- |
| Mission composer: kind research/coding, objective, workspace, budget (1/3/6 repair cycles), preferred model, supervised/autopilot | `POST /api/hive/workflows` | `/hive new` guided form | P0 |
| Run list + auto-select latest | `GET /api/hive/workflows` | `/hive` list view | P0 |
| Controls: pause / stop / resume / replay-as-new | per-id POST routes | keybound actions in hive view | P0 |
| Stat strip: progress, tokens vs budget, elapsed, evidence count, autopsy verdict | workflow snapshot | header strip in hive view | P0 |
| Conversation tab: operator + agent feed, send guidance, steer, continue mission | `/steer`, `/continue` | default hive pane; composer with send/steer/continue | P0 |
| Per-node detail: status, role, attempt, tokens, handoff summary, reasoning stream, tool chips, findings, verification checks, artifacts, uncertainties | `AgentMessage` | expandable node blocks in timeline pane | P0 |
| Retry / skip failed node | `/override` | actions on failed node | P1 |
| Live vitals: brain-wave certainty, "almost said" panel, tok/s, ctx meter, arg-decode progress | `LiveVitals`/`BrainWave` | sparkline + status line (shares chat confidence renderer) | P1 |
| Workspace tab: read-only tree, live file drafts, plan/research docs | inline panes | `/hive workspace` pane (read-only) | P1 |
| Plan tab (node timeline) | inline | `/hive plan` pane | P1 |
| Evidence tab: stance-tagged source cards + artifacts | inline | `/hive evidence` pane; open link prints URL | P1 |
| Agent Studio: role registry, edit prompt/preferred model, reset | `/api/hive/roles/[id]` | `/hive roles` editor | P2 |
| Audit tab: autopsy findings + durable event ledger | workflow ledger | `/hive audit` pager | P1 |
| Tool approval (supervised) | `/approve` | same inline approve/deny as code mode | P0 |
| Readiness badges (role data, promoted specialists) | provenance summary | line in `/hive` header | P2 |
| Hive coding on a **remote client project** | does not exist anywhere | reverse tool dispatch (Step 8) | P1 |

### Deliberate research (`POST /api/agent/deliberate`) — attach topology

| Feature (web) | Source | CLI treatment | Priority |
| --- | --- | --- | --- |
| Launch with query/project/model | deliberate route | `/mode research` then ask | P0 |
| Phase machine rendering: phase, roles, role_progress, debate_turn, convergence, inner | `DeliberateEvent` | phase timeline + live debate feed; inner events reuse code renderer | P0 |
| Durable `.md` artifacts per phase | `artifact` events | print artifact paths; `/ground` lists them | P0 |
| Convergence verdicts + process retrospective | events + synthesis | rendered verdict line per round; synthesis as final answer | P0 |
| Open-inquiry protocol (explorer/skeptic/judge prompts, calibrated confidence in synthesis) | planned — see `docs/design/open-inquiry-protocol.md` | arrives server-side; CLI renders the confidence line and any versioned new event kinds | P1 |

### Dashboard, monitor, status

| Feature (web) | Source | CLI treatment | Priority |
| --- | --- | --- | --- |
| Live system snapshot (GPU/VRAM/CPU/RAM/temps, serving state, train tail, runs, bench summary) | `GET /api/dashboard/stream` (SSE), `GET /api/sysinfo` | `/status` full-screen view + persistent one-line status bar | P0 |
| Resident-model badge + manual unload | `GpuBadge`, `DELETE /api/sysinfo` | shown in status bar; `/model unload` | P1 |
| Stop all agents | `/api/agent/runs/stop-all` | `/stop all` with confirm | P0 |
| Widget grid, quick-chat/train/bench widgets | dashboard grid | not replicated — the CLI's modes are the "widgets" | — |

### Lab: train, benchmark, lens (`/train`, `/benchmark`)

| Feature (web) | Source | CLI treatment | Priority |
| --- | --- | --- | --- |
| Start/stop training run (name, base, steps, lr, mode SFT/HQQ/raw, dataset, specialist role, HQQ recipe, auto-bench) | `GET/POST/DELETE /api/train` | `/lab train` guided form → live progress | P1 |
| Live run telemetry: loss/val/EMA, KPI strip, ETA, grad norm, throughput | `/api/train?name=` polling | text KPI strip + braille/ASCII loss sparkline; full charts = **handoff** URL | P1 |
| Dataset manager (upload/list/delete, PDF extract) | `/api/train/data`, `/api/extract` | `/lab data` list/upload from local path | P2 |
| Run suite benchmark, leaderboard, measurement matrix, pin baseline | `/api/bench`, `/api/suites` | `/lab bench <suite> <model>` → table output; pin/delete | P1 |
| Question-level evidence, webshots, radar/frontier charts | benchmark visuals | table of grades; charts/webshots = handoff URL | P2 |
| Model deltas / evolution / concept galaxy / logit lens | `/api/compare`, `/api/lens` | handoff URLs from `/lab` menu | handoff |

### Library (`/library`)

| Feature (web) | Source | CLI treatment | Priority |
| --- | --- | --- | --- |
| Models: set current, rename, export, delete | `/api/agent/models`, `/api/download` | `/model` manage submenu | P1 |
| Documents + folders (grounding corpus) | `/api/docs`, `/api/folders` | `/ground docs` list/upload | P2 |
| Chats list (chat/code) | `/api/agent/conversations` | `/session` (already above) | P0 |
| Runs: history, diagnosis trace, report cards, delete | `/api/agent/runs*` | `/session runs` + `/session doctor` + `/session report` | P1 |
| Experiments (training records) | `/api/train?name=` | `/lab history` | P2 |
| Projects registry + tree/editor | `/api/agent/projects` | CLI is per-project by nature; `/project` covers it | — |

## Identity cleanup (unchanged in intent, condensed)

Remove or hide from the default experience, in two stages (hide/disconnect first,
delete after dependency tracing):

- Alibaba/ModelStudio onboarding, token plans, upstream terms/support links, cloud
  channels, IDE/desktop promotion, telemetry destinations, surveys.
- Qwen/Gemini names in prompts, help, warnings, settings, env guidance, generated
  files. `LAL.md` is the primary project memory; `AGENTS.md`/`QWEN.md` remain
  compatibility inputs.
- Provider leakage: `[openai]` tags, `LAL · model` mojibake label, raw Base
  URL/API-key fields in the normal picker (advanced connection screen only).
- Random loading phrases → typed runtime states (queuing, loading model, thinking,
  calling tool, waiting for approval, verifying).
- Duplicate slash commands and upstream docs/translations/SDKs not needed to ship.
  Keep Apache-2.0 license and derivation notices.

Keep and harden: Ink full-screen rendering, streaming tool loop, local
file/shell/Git/LSP/MCP tools, folder trust, approval modes, sandbox hooks, session
resume, context accounting, headless operation, accessibility primitives.

## Command surface

| Command | Purpose |
| --- | --- |
| `/model` | Pick/manage Local AI Lab models (name · family/role · status · ctx); unload. |
| `/mode` | Default, Code, Hive, Research, Chat, or Lab. Mode switch keeps the session. |
| `/effort` | Reasoning/tool budget. Fork ships upstream tiers (`low..max`) today; renaming to fast/balanced/high/maximum is Step 2 work, mapped onto the server mode presets' budgets. |
| `/thinking` | Toggle/collapse the live thinking panel. |
| `/jspace` | Toggle confidence sparkline; expand to alts/event timeline. |
| `/status` | System + connection view (GPU, VRAM, serving state, runs). |
| `/project` | Project identity, root, Git state, loaded instructions. |
| `/session` | Resume, name, fork, search, export, archive, delete; `runs`, `doctor`, `report`. |
| `/context` | Context sources, size, compression state. |
| `/memory` | Edit/reload persistent project guidance (`LAL.md`). |
| `/tools` | Local tool inventory and availability. |
| `/permissions` | Approval and sandbox policy (auto-approve, supervised). |
| `/git` | Status/diff/commit on the local repo. |
| `/preview` | Start/stop local dev-server preview; print Tailscale URL. |
| `/ground` | Web/docs grounding toggles, sources, citations, artifacts. |
| `/hive` | Mission control: new, list, attach, steer, pause, resume, replay, panes. |
| `/lab` | Train, bench, datasets, history; handoff URLs for heavy visuals. |
| `/voice` | Web voice handoff (URL + QR), same session. |
| `/stop` | Cancel generation/tool; `all` variant. |
| `/settings` | LAL settings (sampling, system prompt, idle unload, UI). |
| `/update` | Update the managed client in place. |
| `/help`, `/quit` | Concise guide; exit without losing the resumable session. |

Advanced foundation commands stay discoverable under `/advanced` until adopted or
removed.

## Step-by-step delivery plan

### Step 0 — stabilize the prototype (fork hygiene)

1. Fix encoding and settings migration permanently, with fixtures for Windows code
   pages, UTF-8 without BOM, and atomic rollback.
2. Set model ownership to `local-ai-lab`; remove `[openai]` tags and the duplicate
   `LAL ·` label path (kills the mojibake at the source).
3. Ensure no startup path can reach Alibaba onboarding or upstream terms
   (`providers/presets/alibaba-*.ts`, `auth.ts`, `useProviderSetupFlow.ts`).
4. Smoke tests: install, update, launch, model list, one streamed tool call,
   session resume, device audit.
5. Make build, release, verification, deployment, and desktop launch repo-owned
   one-command operations.

### Step 1 — version the event protocol (server side, small)

1. Create a shared schema module in `web/src/lib/protocol/` that re-exports the
   existing unions (`ToolLoopEvent`, `DeliberateEvent`, hive event kinds, run
   envelope kinds `run/turn/usage/status/approval_needed/approval_result`) plus an
   explicit `v: 1` on the stream handshake.
2. Compatibility rule, written into the module header: adding an event kind is a
   minor change (clients ignore unknown kinds); changing an existing kind's shape
   requires a version bump. No new event kinds anywhere without going through this
   module.
3. Publish the types to the CLI as a generated/mirrored TS file in
   `lal-cli/packages/core/src/lal/protocol.ts` with a drift test (CI compares
   hashes).
4. Conformance fixture: record one real code run and one hive run as `.ndjson`;
   replaying them through any client renderer must produce a stable snapshot.

### Step 2 — LAL gateway client core in the fork

1. Gateway client: auth + device identity against `/api/lal/client-settings` and
   `/api/lal/heartbeat`; model catalog from `GET /api/agent/models`; inference via
   `/api/llm/v1/*`. Present it as a managed LAL connection — endpoint/protocol
   detail lives only in an advanced screen.
2. Replace the model picker with LAL rows (name · family/role · loaded · ctx ·
   serving computer), from the catalog. Delete `QWEN_OAUTH_MODELS` path from the
   default flow.
3. Typed runtime-state component replacing random phrases, driven by real events
   (`model_loading`, `model_ready`, tool states, approval waits).
4. Home screen: LAL mark, project + branch, model/mode/effort, `main-pc`
   connection and GPU state (`/api/sysinfo`), context use, permission state,
   shortcuts (resume/model/mode/settings/help).
5. Persistent status bar: ctx fill, tok/s, confidence avg, GPU/VRAM, connection.
6. `/status`, `/model`, `/settings` commands backed by the same routes the web UI
   uses (`PUT /api/agent/models` for options/system prompt).

### Step 3 — run-stream attach engine (the parity workhorse)

1. SSE client with replay-from-seq-0, `Last-Event-ID` resume, heartbeat handling,
   and terminal-state detection (`done/error/stopped/interrupted`).
2. Renderer registry mapping every protocol event kind to a TUI block: text/think
   (with `p`/`alts` captured), tool_request/progress/result, nudges, context
   events, run envelope, approval events. Unknown kinds render as a dim debug
   line, never a crash.
3. Reattach-if-live: on start and reconnect, query `GET /api/agent/runs` and offer
   to reattach to live runs owned by this device/session.
4. Follow-tail scrolling with unstick-on-scroll and a jump-to-latest affordance.
5. Token-delta buffering on a fixed flush clock (the web uses 150 ms) so the
   terminal never repaints per token.

### Step 4 — Chat mode (first attach consumer)

1. `POST /api/agent/chat` + attach; sessions via `/api/agent/conversations?kind=chat`
   (list/open/delete/rename); `lal --resume` and `--new`. Chat history lives
   server-side so every device sees the same session.
2. Cross-device co-presence: while the session is idle, poll `GET
   /api/agent/runs` for a live run with this `conversationId` (started from the
   phone/web) and auto-attach; refresh the transcript from the conversation
   record when a foreign turn completes.
3. Thinking panel (collapsible, auto-open while streaming), stop via
   `/api/agent/chat/stop`.
4. Confidence sparkline + avg/low counts from `p`/`alts`; `/jspace` expands the
   last-N alternatives view.
5. Grounding: `/ground web|docs on|off` → `/api/modes`; support one-off
   `/web` and `/docs` prefixes.
6. Edit-and-resend (truncate), delete message, continue-truncated-reply
   (`continueIndex`).
7. Image attach by path → `attachments`; print the routed vision model badge.
8. `/voice` handoff: print Tailscale URL + QR for the web voice UI on the same
   conversation.

### Step 5 — Code mode (local-tools topology)

1. Keep the inherited local tool loop; point inference at the gateway. Emit the
   **same protocol events** internally so the Step 3 renderer draws local runs
   identically, and persist a local `.ndjson` ledger per run under
   `~/.lal/projects/<project>/runs/`.
2. Port the mode presets (default/quick-edit/planning/deep-research/orchestrator
   budgets from `web/src/app/api/agent/loop/route.ts`) into `/mode` + `/effort`,
   so budgets match the web semantics.
3. Approval UX: full-args prompt (special-case shell command and git argv),
   approve/deny/auto-approve; `/permissions` policy screen.
4. Live unified diffs on write/edit tool results; `/git` status/diff/staged
   commit on the local repo.
5. `/preview`: run the project's dev server locally, print local + Tailscale
   URLs (client-side `tailscale serve` when available).
6. Truncation handling: bounded auto-continue with a visible counter, or a
   continue prompt.
7. `/session doctor` and `/session report`: run autopsy over local ledgers —
   POST the ledger to a new gateway diagnosis route (server reuses
   `diagnoseRun`) or vendor the deterministic rules; report cards aggregate
   locally.
8. Chat→code handoff: `/mode code` inside a chat session carries the
   conversation (server `POST /api/agent/handoff` semantics).

### Step 6 — Research mode (deliberate attach)

1. `/mode research`: prompt → `POST /api/agent/deliberate {query, project?, model}`,
   attach to the run stream.
2. Render the phase machine: phase header timeline, role list, per-role progress,
   debate turns, convergence verdict per round, nested `inner` events through the
   Step 3 renderer, artifact paths as they land.
3. Synthesis renders as the final answer; the process retrospective is available
   under `/ground`.
4. Adopt the open-inquiry protocol upgrades as they land server-side (see
   `docs/design/open-inquiry-protocol.md`): calibrated confidence line in the
   synthesis, any new event kind arrives through the Step 1 versioning rule.

### Step 7 — Hive mission control TUI (attach)

1. `/hive new`: composer for kind, objective, workspace (coding), budget
   (normal/thorough/extra), preferred model, supervised/autopilot →
   `POST /api/hive/workflows`.
2. `/hive`: run list with status, auto-select latest, delete; attach = same SSE
   stream with hive event kinds.
3. Main pane = conversation feed (operator + agent messages, token streaming);
   composer sends guidance, `steer` (pause & redirect), `continue` after
   completion.
4. Node blocks: expandable detail — role, attempt, tokens, handoff summary,
   reasoning/output streams, tool chips, findings with confidence, verification
   checks, artifacts, uncertainties; retry/skip on failed nodes (`/override`).
5. Control keys: pause / stop / resume-from-checkpoint / replay-as-new, mapping
   to the per-id POST routes.
6. Panes: `plan` (node timeline), `workspace` (read-only tree + live drafts),
   `evidence` (stance-tagged sources + artifacts), `audit` (autopsy verdict +
   event ledger pager).
7. Vitals line reuses the chat confidence renderer (brain-wave sparkline, tok/s,
   ctx fill, arg-decode progress).
8. Supervised approvals reuse the Step 5 approval UX via `/approve`.

### Step 8 — remote tool dispatch (Hive/agents on client projects)

1. Define typed tool-dispatch requests/results as protocol events (through the
   Step 1 module, version bump if shapes change).
2. Gateway queues tool requests for the target device; the CLI executes them with
   its local tools under local approval/sandbox policy and streams results back.
3. Prove the invariant with tests: no server-side execution path can mutate a
   remote client's repository; every mutation goes through the client executor.
4. Enable Hive coding missions against a remote client project end to end.

### Step 9 — Lab mode

1. `/lab train`: guided form mirroring the web config (name, base from
   `/api/train?name=` bases, steps, lr, mode SFT/HQQ/raw, dataset, HIVE
   specialist role, HQQ recipe, auto-bench) → `POST /api/train`; live KPI strip +
   ASCII loss sparkline from polling; stop/delete.
2. `/lab bench`: suite + model → `POST /api/bench`; render leaderboard and
   measurement matrix as tables; pin-baseline and delete via `PATCH/DELETE`.
3. `/lab data`: dataset list/upload from local path (`/api/train/data`).
4. `/lab history`: experiments records; heavy visuals (delta heatmaps, evolution,
   concept galaxy, logit lens, webshots) print handoff URLs.

### Step 10 — hardening and distribution

1. Per-device credentials, approve/revoke/rename, token rotation, last-seen
   metadata, rejected-attempt warnings; never record prompts/paths/file contents
   in the device registry.
2. Signed manifests, rollback, delta-aware updates; native Windows, Linux
   x64/ARM64, macOS x64/ARM64 builds.
3. Compatibility tests across CMD, PowerShell, Windows Terminal, bash, zsh, SSH,
   and phone-based terminal/web handoff.
4. Storage discipline (see below) verified with a disk-delta test in CI.

## Storage and retention

Every new chat, downloaded model, and generated artifact gets a single
well-defined storage root with an explicit retention/cleanup story from day one.
On 2026-07-14, ad hoc storage (stray experiment folders, duplicate model exports,
an unbounded Hugging Face cache) filled the primary disk to 100%. The CLI and its
gateway must not repeat that: sessions and ledgers live under `~/.lal/projects`
with a documented eviction policy; no writing large artifacts to arbitrary paths;
no silently-growing caches.

## Why this is not another CLI wrapper

Every popular terminal agent is a single tool loop with a model behind it. `lal`
is a terminal front-end to a lab that already runs multi-persona deliberate
research, a specialist HIVE with verifier gates and repair loops, deterministic
run autopsies with per-model report cards, and its own training/benchmark stack —
all on hardware the user owns. The CLI attaches to those live server-side runs
over one resumable, versioned event protocol shared with the web UI, executes
project mutations only on the machine that owns the project, and surfaces token-
level confidence as a first-class signal. The companion open-inquiry work
(`docs/design/open-inquiry-protocol.md`) closes the loop: the research engine
generates its own protocol-shaped training traces, failures become training data,
and small local specialists are promoted only through blind deterministic gates.

## Acceptance criteria

- A new user sees no Qwen, Gemini, Alibaba, or OpenAI product branding in the
  normal flow; attribution remains in licenses/about.
- Running `lal` in any project on an enrolled computer operates on that project
  locally with `main-pc` inference; closing the terminal never kills an attached
  server-side run, and reattach replays losslessly from the resume cursor.
- A chat started with `lal` on one computer is visible live in the web UI opened
  from a phone over Tailscale, the next message can be sent from the phone, and
  the CLI renders that turn — same conversation, no fork.
- Chat, Code, Research, and Hive modes each render their full event vocabulary;
  unknown event kinds degrade gracefully; decorative fake progress is absent.
- Approvals show full tool arguments; supervised Hive missions and local code
  runs share the same approval UX; no server path mutates a client repository.
- Thinking, token confidence, and system telemetry are live and truthful.
- Chats resume by project after restart and survive `lal update`.
- Every connected device is visible and revocable without collecting project
  content.
- The battery of parity features marked P0 in this document works end to end
  before any P1 work starts.

## Related documents

- `docs/design/open-inquiry-protocol.md` — epistemically-open research protocol:
  deliberate-engine prompt upgrades, `open_inquirer` specialist fine-tune, and
  calibration/refusal evaluation.
- `docs/design/lal-cli-distribution.md` — install/update channel and ownership
  split.
- `docs/lal-cli-foundation-research.md` — foundation choice record (qwen-code).
