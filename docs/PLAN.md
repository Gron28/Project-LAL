# Project-LAL maintenance plan

This is the canonical list of pending reliability and maintenance work.

Last audited: 2026-07-30

## How to use this plan

- Work from the highest priority section downward.
- Mark an item complete only after its acceptance checks pass.
- Add newly discovered work here instead of keeping a separate private list.
- Keep operational changes reversible and test them while no model job is active.

Status labels:

- `TODO` — not started
- `DOING` — actively being implemented
- `PARTIAL` — useful implementation exists, but one or more named acceptance
  checks remain
- `BLOCKED` — cannot proceed until the named dependency is resolved
- `DONE` — implemented and verified

## 2026-07-30 implementation result

The reliable baseline is now implemented: truthful terminal verdicts and task
contracts, policy-selected direct/research/staged routes, bounded repair,
evidence checks, loss-aware handoffs, durable reports, operator controls,
dashboard projections, held-out-suite storage and promotion gates, recoverable
retention, backups, health timers, log rotation, and graceful service recovery.

Live acceptance also verified both primary user paths. HTML-001 passed all nine
browser probes without page or console errors. A normal-budget research run
performed targeted follow-up, fetched canonical evidence, passed claim
entailment and source-independence checks, and completed with all three task
criteria linked to evidence. Rewinding only its deterministic report stage
preserved the audit trail, consumed zero inference tokens, explicitly retained
the external-side-effect warning, and produced a complete verdict with no open
gaps.

All repository-local work in this plan is implemented. The executable paired
evaluation persisted 120 complete trajectories (30 research and 30 coding
fixtures for both workflow and direct baselines) and passed all thirteen
promotion gates. Shared CLI/Hive validation and research semantics, the recovery
matrix, correlated Mission Control, safe plan/policy/evidence controls, and
linked trace/report exports are covered by the release suite.

One external platform gate remains: the ten-run HTML-001 qualification must
execute on an actual Windows machine. This Linux host has neither Windows nor a
connected Windows runner, so it cannot manufacture that evidence. The
repository now contains a guarded self-hosted Windows workflow that rejects
non-Windows and partial reports.

## P0 — restore the release gate

These items come first because the repository cannot currently complete its
top-level test contract. A permanently failing gate can conceal new regressions.

### DONE: remove Benchmark page hook lint failures

Location: `web/src/app/benchmark/page.tsx`

React's hook linter rejects synchronous state updates in the effects that open a
pending result and load a benchmark suite. Restructure this state flow so it
does not produce cascading effect renders while preserving archive selection and
suite-loading behavior.

Acceptance:

- `npm --prefix web run lint` passes.
- Selecting an archived benchmark still opens the intended model result.
- Changing suites still loads the suite once and shows correct loading state.

### DONE: update the tool-allowlist drift check

Location: `scripts/check_tool_allowlist_drift.mjs`

The checker still requires the removed computer-use files:

- `apps/cli/packages/core/src/tools/computer-use/schemas.ts`
- `apps/cli/packages/core/src/tools/computer-use/index.ts`

Update it to validate the current tool registry without weakening its primary
guarantee: every allowlisted tool name must resolve to a tool that the current
CLI can actually advertise.

Acceptance:

- `npm --prefix web run check:tool-allowlist` passes.
- A fixture or test proves that a misspelled/unresolvable allowlist entry fails
  the check.
- The check has no assumptions about deleted computer-use functionality.

### DONE: make the CLI shutdown test rejection-safe

Location: `apps/cli/packages/cli/src/serve/server.test.ts`

The test `force-closes connections after the shutdown timeout` starts a `fetch`
and attaches rejection handling only after closing the server. Under full-suite
load, the request can reject first and Vitest reports an unhandled rejection even
though all assertions pass. Attach handling immediately while retaining the
test's ability to detect a hanging shutdown.

Acceptance:

- The targeted shutdown test passes repeatedly.
- The test produces no `PromiseRejectionHandledWarning` or unhandled rejection.
- `npm run cli:test` exits successfully.

### DONE: certify the complete repository

This closes P0 only after the individual repairs above are complete.

Acceptance:

- `npm run test` exits successfully from a clean checkout.
- TypeScript, runtime, protocol-conformance, protocol-drift, Windows release, and
  CLI suites all pass.
- No generated test report or build artifact is accidentally left tracked.

## Agentic system rebuild — ordered workstream

This workstream records the 2026-07-30 Hive/CLI/agent-runtime audit. It is an
ordered reliability program, not a request to replace the existing system or
copy another framework. Google ADK 2.0 is a design reference for runner-owned
events, graph state, lifecycle hooks, resumability, observability, and
evaluation. LAL remains local-first and keeps its own runtime and storage.

Audit baseline:

- The retained Hive corpus contains two research runs: one recorded success,
  one cancellation, and no coding run.
- The recorded success took 384.7 seconds and approximately 18,445 inference
  tokens. Its gap stage requested follow-up, the normal-budget policy skipped
  follow-up, synthesis disclosed uncovered domains, and the workflow was still
  marked successful.
- Citation verification currently proves only that attached evidence IDs exist;
  it does not prove that the sources entail the claims.
- 6,703 of 6,753 retained Hive events are token-level reasoning/output
  fragments. Important lifecycle events are present but difficult to analyze.
- 240 of 261 artifact records are no longer linked to a retained workflow.
- Hive release gates describe a useful standard, but their self-test supplies
  synthetic task counts and success rates rather than measured held-out runs.
- Better primitives already exist in the CLI: resumable dynamic workflows,
  structured subagent output, bounded parallel dispatch, research coverage
  control, per-phase budgets, and artifact acceptance checks.

### Foundations — non-negotiable semantics

These are the basics every later improvement depends on.

#### DONE: make terminal status represent task outcome

Separate scheduler execution from task outcome. A workflow may finish executing
while its task remains incomplete.

Required terminal outcomes:

- `complete` — every required acceptance criterion passed.
- `incomplete` — execution ended with unmet or unchecked required work.
- `blocked` — a named external input or authority is required.
- `cancelled` — the operator stopped the run.
- `failed` — the runtime could not continue because of an execution fault.

Acceptance:

- A node result of `needs_followup` cannot be stored as scheduler success without
  an explicit downstream route that owns the follow-up.
- No workflow becomes `complete` merely because no node row is marked failed.
- The final status links to the exact acceptance evidence that justified it.
- Autopsy, UI, training harvest, model routing, and reports consume the same
  terminal verdict.

#### DONE: make the task contract explicit and editable

Every run must persist:

- objective and latest user request;
- requested deliverables and artifact paths;
- constraints and permissions;
- task-specific acceptance criteria;
- properties the runtime cannot verify;
- budget and control mode.

Acceptance:

- The operator can inspect and edit the contract before execution and while a
  run is paused.
- Generic defaults such as "deterministic checks pass" cannot replace concrete
  user requirements.
- Each criterion has an `unknown`, `pass`, `fail`, or `blocked` state with
  evidence.

#### DONE: establish one canonical runner event boundary

Agents, model calls, tools, checks, approvals, state changes, artifacts, and
human input must yield events through one runner-owned commit path. Consumers
must not mutate session history or workflow state behind the runner.

Every durable event must carry:

- schema version and monotonic sequence;
- run, invocation, trace, span, and parent-span IDs;
- node, attempt, agent, model, and tool-call IDs when applicable;
- wall-clock timestamp and lifecycle state;
- redacted payload plus artifact references for large content.

Acceptance:

- State/artifact changes are durably committed before the runner advances.
- Web, CLI, Hive, replay, autopsy, and evaluation read the same event vocabulary.
- Live token streaming remains responsive without storing one database event per
  token; durable text is chunked and lifecycle events remain easy to query.
- Unknown event versions degrade visibly instead of disappearing.

#### DONE: make completion runtime-owned and task-aware

A model stopping or claiming success is a completion proposal. The runtime must
validate produced state and either accept it, return concrete defects for a
bounded repair, or report incomplete work.

Acceptance:

- HTML uses the existing artifact validator and adds browser-level checks when
  behavior or appearance matters.
- Coding completion requires fresh relevant mechanical checks plus
  requirement-by-requirement evidence.
- Research completion requires scope coverage, source independence, fetched
  sources, claim-to-evidence entailment, contradiction handling, and explicit
  unresolved gaps.
- Validators list unchecked properties; unknown is never converted to pass.
- Repair loops are bounded and preserve correct prior work.

#### DONE: define durable resume and side-effect semantics

Use checkpoints and append-only journals to resume completed work rather than
replaying whole missions. Tool execution is treated as at-least-once unless a
tool proves stronger semantics.

Acceptance:

- Every side-effecting call has an idempotency key or a documented duplicate
  prevention strategy.
- Resume reinstates successful model/tool results and starts from the first
  uncommitted step.
- Pause, cancellation, approval waits, process interruption, and backend restart
  have deterministic recovery tests.
- Rewind preserves the audit log and explicitly reports external side effects it
  cannot undo.

### First repairs — stop known false success

#### DONE: repair the current research workflow

- Remove the unconditional normal-budget follow-up skip.
- Route material gaps back to search/read/extract until resolved, blocked, or the
  bounded evidence policy is exhausted.
- Rank and classify sources before synthesis.
- Replace evidence-ID existence checks with claim/source entailment checks.
- Require an evidence-linked user-facing report artifact.
- Do not harvest research trajectories as verified training data until these
  gates pass.

Acceptance:

- A fixture with a deliberately uncovered sub-question cannot finish complete.
- An unrelated but valid evidence ID cannot support a claim.
- A contradictory pair of sources remains visible through synthesis and report.
- A normal-budget run can perform targeted follow-up.

#### DONE: provide a reliable fast path for simple artifacts

A simple HTML request should normally use one capable tool-using coding agent
and a bounded validate/repair loop. Planning, specialist handoffs, and
independent review are added only when task complexity or risk warrants them.

Acceptance:

- The HTML-001 fixture creates the requested file, passes static validation,
  loads in a browser without uncaught errors, and satisfies its interaction
  checks.
- The simple path does not pay for unrelated research, multiple planners, or
  three fixed implementation packages.
- Escalation to a larger workflow records the concrete reason.
- The direct path is retained as the baseline against which orchestration is
  judged.

### Consolidation — reuse the strongest existing mechanisms

#### DONE: create a shared task-runtime package

Move or adapt the strongest primitives so web code mode, Hive, and CLI consume
one implementation:

- CLI artifact acceptance registry and bounded repair feedback;
- CLI research controller and evidence-coverage state;
- CLI workflow journal, structured outputs, budgets, and resume cache;
- shared tool identity, approval, cancellation, and side-effect records;
- shared task contract, terminal verdict, trace events, and report schema.

Hive becomes a workflow policy and visualization surface over this runtime, not
a second tool loop and completion engine.

Acceptance:

- The same HTML validator and research controller run from CLI and web/Hive.
- A conformance suite replays one fixture trace through every renderer.
- No surface keeps a private incompatible meaning for success, tool result,
  usage, approval, or cancellation.
- Existing data is preserved through explicit migrations.

#### DONE: remove duplicated policy and telemetry paths

Inventory the web tool loop, Hive engine, CLI agent runtime, CLI workflow
orchestrator, run ledger, and Hive database. For each duplicated responsibility,
select one owner and migrate callers before deleting old code.

Acceptance:

- The inventory names the owner of routing, acceptance, research coverage,
  retries, budgets, checkpoints, events, artifacts, and evaluation.
- Duplicate code is removed only after parity and migration tests pass.
- CLI/TUI and browser behavior remain available throughout the migration.

### Adaptive orchestration — use agents only when they add value

#### DONE: replace fixed task tax with policy-selected workflows

The policy router chooses among:

- direct tool-using agent;
- iterative research workflow;
- coding plan/implement/verify workflow;
- explicit saved/custom workflow.

Acceptance:

- Routing is deterministic where possible and records its features and reason.
- Agent count and graph depth come from task complexity, not a preset constant.
- Independent work may fan out; dependent work remains ordered.
- Gap, verify, and repair loops are dynamic and bounded.
- Model residency and measured capability influence routing so unnecessary model
  swaps do not dominate local execution time.

#### DONE: make handoffs loss-aware

Persist both bounded handoff summaries and references to the original artifacts,
tool results, decisions, and evidence. A specialist must be able to retrieve the
source context when a summary is insufficient.

Acceptance:

- Every handoff shows what was included, omitted, and linked.
- A context-loss detector catches missing requirements or contradictory
  summaries before downstream completion.
- Repeated summarization does not erase the task contract or acceptance state.

### Operator observability and control

#### DONE: build a correlated mission dashboard

The dashboard must answer "what is happening, why, what is it costing, what is
still unproven, and what can I change?" without requiring inspection of raw
events.

Required live views:

- Mission: objective, deliverables, criteria states, current conclusion, next
  action, blocker, and forecast.
- Graph: nodes, routes, dependencies, attempts, critical path, concurrency,
  checkpoints, and skip reasons.
- Timeline: model loads, inference, tools, approvals, waits, checks, retries,
  interventions, and idle gaps.
- Model/agent: role, model/version/adapter, input/output/cache tokens, context
  fill, time to first token, decode rate, finish reason, load/swap time, and
  structured-output validity.
- Tools: provenance, redacted arguments, approval, latency, result size,
  success/error, retry, idempotency, and side-effect class.
- Research: scope matrix, queries, fetched sources, origins, authority/freshness,
  claims, entailment, contradictions, gaps, and marginal return.
- Coding: files read/changed, live diff, tests, browser checks, screenshots,
  acceptance findings, unchecked behavior, and workspace state.
- Resources: CPU, RAM, GPU, VRAM, temperatures, resident model, backend queue,
  processes, disk/network latency, and GPU idle time.
- Quality: acceptance, groundedness, task rubric, trajectory/tool efficiency,
  first divergence, false-completion guard, and baseline comparison.

Acceptance:

- Selecting any visible fact opens its supporting event, artifact, check, or
  evidence record.
- Critical-path and per-stage duration add up to the run timeline.
- Dropped events, reconnects, stale snapshots, and checkpoint age are visible.
- The raw durable ledger remains available but is not the primary diagnostic UI.

#### DONE: expose safe operator controls at the same boundary

Required controls:

- pause, resume, cancel, retry, skip, fork, and rewind;
- approve/deny tool calls with scope and consequence;
- edit objective, deliverables, constraints, criteria, plan, model, and budget;
- redirect the active or next node;
- pin/reject evidence and mark an output useful or defective;
- export a reproducible trace and comparison report.

Acceptance:

- Every intervention is durable, timestamped, attributed, and shown in reports.
- The UI explains what state will and will not be rolled back.
- Controls cannot bypass required verification without producing an explicit
  operator override in the final verdict.

### Reports, evaluations, and the improvement loop

#### DONE: generate one structured post-run report

Every run report must include:

1. terminal outcome and deliverables;
2. requirement matrix with evidence;
3. changes made or knowledge produced;
4. tests, research checks, and unchecked properties;
5. claim/source matrix where applicable;
6. critical path and resource/budget use;
7. failures, retries, recovery, and operator interventions;
8. first divergence and wasted-work analysis;
9. comparison with the applicable direct-agent baseline;
10. suggested runtime, prompt, tool, model, and evaluation improvements;
11. workflow/model versions, event range, checkpoint, and environment fingerprint.

Acceptance:

- Reports are generated from durable facts, not a model's recollection.
- Each summary claim links to underlying evidence.
- Reports can be compared across workflow/model versions.
- Sensitive content is redacted in exports without damaging local provenance.

#### DONE: replace synthetic release evidence with held-out evaluation

Create versioned suites for:

- single-file HTML and interactive artifacts;
- existing-project fixes and greenfield coding;
- ordinary and contradiction-sensitive research;
- interruption/resume and duplicate-side-effect prevention;
- tool errors, malformed structured output, and unavailable backends;
- user redirection, approval denial, and changed requirements;
- long-context compaction and handoff preservation.

Use deterministic environment/tool simulation where live dependencies would
make results slow or irreproducible. Store complete trajectories so evaluators
can score final response, acceptance, groundedness, tool use, trajectory,
latency, and resource efficiency separately.

Promotion acceptance:

- At least 30 held-out research and 30 held-out coding tasks.
- Results compared with the best direct-agent baseline on identical tasks and
  budgets.
- At least 10 percentage points verified-completion improvement before Hive is
  eligible to become a default route.
- False-completion rate below 1%.
- At least 90% of runs remain within their declared effort budgets.
- Resume and provenance gates pass without duplicate harmful side effects.
- No specialist, adapter, prompt, or routing change self-promotes from its own
  generated labels.

Verified result:

- Evaluation `eval-2f6906c0-87a9-4fb8-a4af-3283f8cca8b3` stored 120 paired
  trajectories with complete checks, events, budgets, and provenance.
- Workflow verified completion was 100% in the deterministic runtime fixtures;
  the direct baseline was 16.7% for research and 50% for coding.
- Budget compliance was 100%, false completion was 0%, restart exactly-once and
  provenance gates passed, and no coordinator authority violation occurred.
- See `docs/EVALUATION-2026-07-30.md` for scope and the explicit distinction
  between deterministic runtime qualification and stochastic live model quality.

#### BLOCKED: complete the Windows HTML-001 qualification

The browser harness already passed ten of ten consecutive Linux runs, and the
Windows release/installer contract passes its repository tests. The promotion
bar nevertheless requires the real installed Windows client, filesystem, shell,
and browser.

The manual GitHub workflow `.github/workflows/html001-windows.yml` runs the ten
fixtures on a self-hosted Windows runner labelled `lal-html001`, persists the
report, and refuses a non-`win32`, partial, or sub-9/10 result.

Blocked dependency:

- connect an actual Windows x64 runner with an installed `lal` command and
  Chrome/Edge, plus a reachable Project-LAL gateway and `LAL_API_KEY` secret.

This is an external hardware/credential dependency, not unfinished repository
implementation.

#### DONE: make improvement proposals reviewable

Autopsy may propose changes to prompts, tools, routing, workflow policy,
acceptance checks, or model selection, but proposals remain quarantined until
replayed against held-out suites.

Acceptance:

- Every proposal names the supporting failures and expected metric movement.
- Candidate and control runs use the same fixtures and environment.
- Improvements require held-out gain without unacceptable core regressions.
- Rejected proposals and their evidence remain queryable to prevent repetition.

### Data hygiene and quality of life

#### DONE: add retention and integrity policies for agent data

- Garbage-collect unreferenced artifacts only after a recoverable retention
  window.
- Compact token streams without losing final text or timing.
- Bound logs, traces, screenshots, source snapshots, and evaluation artifacts.
- Check database foreign references, hashes, event sequences, and checkpoint
  consistency.
- Include agent data in the owner-data backup and restore drill.

Acceptance:

- A dry-run command reports what would be compacted or removed.
- Retention never removes data needed by active runs or pinned evaluations.
- Restore recreates representative runs, artifacts, reports, and trace links.
- Storage growth and dropped-event counts are visible on the monitor page.

## P1 — operational reliability

### DONE: harden graceful service shutdown

Locations:

- `deploy/systemd/project-lal.service`
- `web/run_web.sh`
- model-process ownership and shutdown code in `web/src/lib/lab.ts`

Historical controlled stops have exceeded `TimeoutStopSec=15`, required SIGKILL,
or been recorded as failures after an ordinary SIGTERM. Ensure the web process
and every managed model child receive a controlled shutdown, then configure the
service unit to classify the intended exit status correctly. Increase the
timeout only if measured shutdown behavior still requires it.

Acceptance:

- Start an idle service, stop it, and confirm systemd records a clean stop.
- Repeat while a model is resident but no inference is active.
- No managed `llama-server` child remains after either stop.
- Restart recovery still works after a genuine non-zero crash.

### DONE: rotate the llama-server log

Locations:

- `out/llama-server.log`
- the append-only log setup in `web/src/lib/lab.ts`

The log was approximately 9.2 MB at the 2026-07-30 audit and currently grows
without an explicit retention policy. Add size- or time-based rotation with a
small bounded history. Rotation must not interrupt a running model server.

Acceptance:

- Force a rotation in a safe test and confirm new messages reach the active log.
- Retained logs have a documented maximum size or age.
- A running inference is not interrupted by rotation.

### DONE: create and verify owner-data backups

At minimum inventory and protect:

- `web/.data/`
- machine/user configuration required to reconstruct the installation
- model manifests and acquisition metadata
- irreplaceable training, benchmark, lineage, and exported artifacts

Large reproducible model binaries may use a separate policy, but the policy must
be explicit. A backup is not considered working until a restore has been tested
into a temporary location.

Acceptance:

- One documented command creates a dated backup.
- Retention and backup destination are documented.
- Secrets and bearer tokens are stored with appropriate permissions or excluded
  with a documented recovery procedure.
- A restore drill reconstructs the selected data in a temporary directory and
  verifies representative records.

### DONE: add scheduled read-only health checks

Add a lightweight daily check for the web service, system information endpoint,
storage headroom, and state-file readability. Add a deeper weekly smoke test
that runs only when no inference, training, Lens, or agent job is active.

Acceptance:

- Checks never interrupt active work or load a model during the daily probe.
- Failures are recorded somewhere visible and bounded by retention.
- A deliberately failed probe produces a useful diagnostic and non-zero result.

## P2 — agent longevity and test hygiene

### DONE: make coding-loop completion reserve task-aware

Location: `web/src/lib/toolloop.ts`

The coding loop currently reserves about 42,000 tokens before every model call.
This protects whole-file generation, but it can prematurely stop inspection,
verification, or short-edit rounds. Use a larger reserve when a whole-file
mutation is plausible and a smaller reserve for bounded follow-up work. Continue
compacting old tool output before refusing the next round.

Acceptance:

- Whole-file tool calls retain enough completion space to avoid truncation.
- A long run with roughly 29,000 input tokens can perform a bounded follow-up
  within a 65,536-token context when its requested output fits.
- The backend never receives a request whose input plus output allowance exceeds
  the configured context.
- Context-limit events continue to report estimated input, reserved output, and
  total context.

### DONE: eliminate unexplained listener warnings in CLI tests

The 2026-07-30 CLI run emitted repeated `MaxListenersExceededWarning` messages
for sockets and process events, plus repeated session-reaper startup messages.
Some stress tests intentionally create many listeners, so first identify which
warnings are expected. Fix missing teardown, interval disposal, or listener
removal rather than globally suppressing non-AbortSignal warnings.

Acceptance:

- The complete CLI suite produces no unexplained listener warnings.
- Session reapers and process/socket listeners are disposed during teardown.
- Production warning handling still exposes genuine listener leaks.

### DONE: remove web test module-format warnings

Node reparses TypeScript tests as ES modules because `web/package.json` does not
declare a module type. Choose a configuration compatible with Next.js and the
existing scripts, then remove the repeated warning without changing production
module behavior.

Acceptance:

- Web runtime and protocol tests produce no module-type reparsing warning.
- The production web build and start commands still pass.

## P3 — documentation stewardship

### DONE: commit the architecture and plan documents

The `docs/` directory was untracked at the 2026-07-30 audit. Review and commit:

- `docs/ARCHITECTURE.md`
- `docs/PLAN.md`

The owner explicitly requested completion of every remaining documented item,
including this previously blocked repository-history step.

Acceptance:

- Both documents are tracked by Git.
- README links resolve in the repository viewer.
- The architecture guide and this plan do not contradict current commands,
  ports, or ownership boundaries.

## Explicitly deferred

Do not change these without new evidence:

- Increasing concurrent GPU agents
- Removing single-owner GPU coordination
- Keeping models resident indefinitely
- Replacing the model-serving architecture
- Broad model-parameter tuning

At the last audit, the service was healthy, idle unloading worked, disk headroom
was ample, and the machine's single-GPU constraints made the current conservative
ownership policy appropriate. Reliability work above has a clearer payoff than
speculative throughput tuning.
