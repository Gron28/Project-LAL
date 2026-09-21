# Project-LAL delivery plan

Updated 2026-09-20. This is the canonical roadmap. Detailed checks live in
[ACCEPTANCE.md](ACCEPTANCE.md); evidence and experiment decisions live in the
[ledger](EXPERIMENT-LEDGER.md). The [historical archive](PLAN-HISTORY-2026-09-20.md)
retains earlier work. No software milestone is newly certified by this revision.

## The outcome

Make useful personal AI something people can own, run offline, adapt to their
hardware, and share. Begin with a concrete job: **open LAL in an existing
project, request a change, receive a working result, and recover cleanly when
something interrupts the work.**

The working product direction is the CLI, the owner's existing Qwen 3.5 9B
Heretic setup, and project-local tools using local or paired-host inference.
The web interface supports observation and lab controls. Expand into cowork,
local research, and other personal work after this first workflow is dependable.

Success means useful work completed with acceptable waiting and supervision.
The user should not need to understand the execution engine to start, inspect,
stop, resume, or recover a task.

## Strategy and scope

Deliver a small working path, observe where it fails, repair the highest-cost
failure, and repeat. Prove the direct CLI path early. Consolidate workflow
ownership in bounded migrations, validating each replacement before retirement.
Use the existing tools, serving, storage, and tests wherever they meet the need.

For the first milestone, support one existing-project coding task on the
current setup. Keep the model and runtime fixed unless a reproduced failure
requires changing them. Use disposable project copies for diagnostics.

For everyday-use qualification, cover artifact creation, existing-project
fixes, multi-file edits, and repair after failed checks. Preserve project
ownership, permissions, truthful completion, cancellation, and recovery.

New engines, additional runtimes, more concurrent agents, training, broad model
tuning, and additional product surfaces enter only through a demonstrated need.
They are not prerequisites for delivering the first useful increment.

## Execution order

These are delivery milestones. Technical gate numbers in the acceptance guide
remain stable for the historical ledger; they do not dictate delivery order.

| Milestone | User-visible result | Delivery position | Completion evidence |
|---|---|---|---|
| M1. One useful task end to end | A requested project change works, is verified, and leaves an inspectable result | **Next**; implementation exists, current acceptance pending | Identified installed build; one independently checked task; one controlled failure/recovery exercise |
| M2. Dependable everyday CLI | Several ordinary tasks complete with predictable effort and recoverable failures | After M1; fix one failure class per increment | Execution contract and live task campaign on the named route/platform |
| M3. Consistent task controls | Ordinary and coordinated work share understandable controls and history | After the affected native path works; integrate alongside M2 where needed | Approval/cancel/resume parity, live replacement checks, history/rollback checks |
| M4. Installable offline product | A second installation performs the supported work and recovers offline | After the relevant M2 path; discover platform constraints now | Fresh install, offline tasks, recovery, upgrade/rollback, explicit support matrix |

Milestones can improve independently. Missing Windows hardware blocks Windows
qualification, not Linux repairs. Migration does not hold back a qualified
direct CLI. Training does not hold back a qualified platform. A release covers
only the combinations that passed; broader platform coverage can follow.

### M1 — prove a useful path and locate the bottleneck

1. Select a representative existing-project change with explicit expected
   behavior. Prefer a recent owner task or failed run; if none is available,
   use a repository fixture that requires a real edit and an independent test.
2. Preserve the selected source/build and identify the actual installed CLI,
   model/runtime, workspace, and invocation. Reuse baseline capture; retain
   source contents as well as hashes. Record a wall-time and retry budget.
3. Follow the whole path: start, inspect, edit, check, report/export. Observe the
   first failure or largest delay; distinguish connection, execution, model,
   validation, and interface problems before choosing a fix.
4. Reproduce the problem, make the smallest repair, then rerun the same task.
   Exercise a relevant controlled interruption/recovery in a disposable project.
   Keep a regression check for the failure.

**Done:** the installed path produces the expected result and truthful evidence,
recovery works for the exercised case, and elapsed time, interventions, and
remaining limitations are recorded. One success demonstrates this increment;
it does not qualify all tasks or certify the platform.

**Decision:** identify the next failure with the greatest user cost. If the
path cannot work within the declared budget, retain its partial result and
reproducer, narrow the task or fix the blocker, and repeat M1.

### M2 — earn everyday use through repeated small repairs

Build a small task set from actual use and observed failures. Keep development
examples separate from held-out acceptance tasks. Expand the recovery matrix
as the path matures: approval denial, stale approvals, cancellation, process
restart, backend failure, full storage, and the crash window between a side
effect and its committed result. Preserve partial work and avoid duplicate
non-idempotent actions.

After each repair, demonstrate the affected task through the installed CLI.
Do not wait for a full migration to see live feedback. Once the candidate is
stable enough to evaluate, run the frozen campaign in acceptance gates 2 and 4.

**Done:** at least 10 distinct coding tasks with 3 runs each; at least 90%
verified completion and 2/3 per task; at least 90% within predeclared budgets;
zero observed false completions or duplicated harmful effects; all required
recovery cases pass. Windows also owes the separate 9/10 installed HTML-001
qualification. These are initial engineering gates, not population guarantees.

**Decision:** keep repairing the leading failure, or expand supported work when
its gate passes. Record whether the owner finds results useful and the wait
and supervision acceptable. Numeric passes alone do not establish usefulness;
without owner feedback, describe the result as technical qualification only.

### M3 — simplify controls through a reversible migration

Use the project machine as the owner of tools, permissions, task state, and
verdicts. The inference host owns serving and resource admission; observers
show task-owner events. Keep filesystem authority explicit.

Move one bounded Hive recipe onto the proven native executor. Carry the actual
user criteria, use one inference slot initially, and repair only when checks
require it. Make approval, cancel/resume, replay, and export consistent. Verify
live behavior and representative history reads before stopping legacy new-run
creation; delete duplicate code only after consumer and rollback checks pass.
Update CLI help, ownership documentation, and the deployment path together.

**Done:** acceptance gate 3 passes for the migrated route, its live tasks pass,
and previous histories remain readable. Keep direct execution available.
Coordination becomes the default only when a matched comparison establishes
that its benefit justifies its added time and complexity.

### M4 — prove a second installation, then broaden support

Start with a named second-machine configuration. Test provisioning, first run,
disconnected coding and cited local-document research, interruption/recovery,
export, upgrade, rollback, and actionable error messages. Separate artifacts
acquired while connected from what is needed during offline operation.

Use acceptance gate 7 to qualify Linux standalone, Windows attached/standalone,
and macOS standalone separately. Reuse model admission and hardware profiles;
include CPU-only configurations with suitable models and measured budgets.
Inspect dependency/platform and licensing constraints early, before investing
in integrations. Complete redistribution, backup/restore, retention, and
release checks before publication.

**Done:** another installation reproduces the advertised tasks and recovery
without hidden online dependencies. Publish exact tested hardware, runtimes,
tasks, limits, and resources. A public release is a separate owner decision.

## Choose work by evidence

Repair authority violations, lost work, false completion, and inability to stop
first. Next address the most frequent task blocker; then excessive waiting or
manual intervention; then broader capability. For comparable items, prefer the
smaller reversible change with better evidence and fewer new dependencies.

Each implementation slice must name one user problem, one reproducer, one
expected outcome, one accountable implementer, and a check. Finish with either
a verified improvement or a specific result that narrows the diagnosis. If a
slice spans multiple work sessions without either, split it or revisit the
assumption before expanding its scope.

Keep one active implementation slice and one live model job on the constrained
host. After every slice, inspect the result and update the next action. Review
priorities at each milestone or when new evidence invalidates a key assumption.
Estimate later work from measured repair and run costs; dates without that
information are not commitments. Freeze time/token/memory budgets before each
campaign, and stop at the cap without discarding failed attempts.

## Improvement and expansion decisions

| Candidate | Evidence needed to start | Adoption decision |
|---|---|---|
| Harness, retrieval, or configuration change | A recurring failure/delay with a plausible mechanism | Matched held-out benefit within resource and regression guards; otherwise rollback or keep experimental |
| Different model or optional training | A demonstrated model limitation after relevant cheaper fixes | Compare against the unchanged base; require held-out gain, retention, provenance, and rollback |
| Extra roles, routing, or concurrency | Direct execution fails a task or wastes measurable time | Benefit must exceed coordination/resource cost; preserve isolation and recovery |
| Cowork, research, audits, authorized defensive security | A concrete owner task needs the capability | A separate task/quality suite; research must handle source support, contradictions, and gaps |
| Shareable skills, recipes, agents, or tuning bundles | Run/export and profile formats are stable | Versioned dependencies/licenses/provenance, second-machine import, no accidental owner data or absolute paths |

### Parked candidates (not active work)

These are recorded so they are not rediscovered from scratch. None is scheduled;
each re-enters only through its evidence row above, after the current milestone.

- **Ternary/extreme-quantization serving.** Ternary Bonsai 2 27B was evaluated on
  2026-09-21 and rejected on measured speed, not on fit: it loads fully offloaded
  in 5.83 GB of 8 GB VRAM, but runs 19.7x slower prefill and 10.0x slower
  generation than the incumbent on this GPU. Full numbers, build recipe, and the
  corrected hardware claims are in the ledger. Re-enters if a tuned build or a
  natively-trained ternary model changes the speed term; capability parity is the
  motive, so a 27B-class model at ~6 GB stays interesting.
- **Ternary Vulkan kernel optimization (RDNA2).** Inspection of the Prism fork's
  `ptq1_0.glsl` shows the trit decoder runs a serial base-3 recurrence per weight
  and returns float, while this GPU reports integer dot-product support that the
  shader does not use. A lookup-table decode and target-specific build are the
  obvious first experiments. This is upstream-shaped work with no bearing on the
  current milestone; it is a side project, not a plan item.

Use acceptance gates 5–6 and the experiment ledger for improvement claims.
Contract bug fixes need a reproducer and regression evidence; routine work
does not need a research campaign. Revalidate external proposals before adopting
them. Rejected or inconclusive experiments remain recorded.

## Assumptions to test

| Working assumption | Largest risk | How the plan tests it |
|---|---|---|
| The current model can do useful bounded coding | Infrastructure work hides a model ceiling | M1 exposes real results early; classify model failures before adding more orchestration |
| Native execution can support consistent task ownership | Replay or permissions fail at fault boundaries | Gate-2 assertions and live recovery before migration; evaluate alternatives if a concrete limitation persists |
| The task set represents owner work | Benchmark passes do not translate to usefulness | Use real examples, retain holdouts, track owner feedback and interventions |
| Local ownership can transfer between platforms | Host-specific dependencies emerge late | Early dependency review, then a real second installation and per-target qualification |

These are working assumptions, not established conclusions. Source-inspection
findings and their limits are retained in the acceptance reference.

## Immediate work and definition of done

**Next work item: M1, select and reproduce one existing-project task.** Preserve
its build/input, inspect a recent failure if available, then trace the installed
CLI path within a declared budget. Use the result to choose the first repair.
The side-effect crash window remains a mandatory recovery check, not an assumed
explanation for every user failure.

The current implementer owns diagnosis, scoped changes, checks, and evidence.
The owner supplies product priorities, acceptable wait/resource tradeoffs, and
feedback; deployment or publication uses the existing authorization rules.
Unavailable inputs block only the dependent work. No implementation is marked
active merely because this plan was edited.

An item is **done** when the intended behavior works on the identified build,
relevant tests pass, applicable live acceptance passes, user-facing commands
and documentation match, and rollout/rollback is covered where required.
Otherwise record partial progress or a specific blocker with the next action.
Keep evidence in the ledger, completed changes in `CHANGELOG.md`, and host
procedures in [OPERATIONS.md](OPERATIONS.md). Preserve existing backup, retention,
health, and shutdown checks while changing the product.
