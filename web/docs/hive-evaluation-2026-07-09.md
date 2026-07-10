# Hive evaluation — 2026-07-09

## Scope

The built Hive runtime was exercised with `victory9-8b` after it passed live backend, JSON-schema, and tool-call capability probes at 41.3 measured tokens/second. The evaluation used:

1. A contradiction-sensitive research memo about Node 24 `node:sqlite`, SQLite WAL durability, contention, checkpoints, foreign keys, corrupt tails, and application-level idempotency.
2. An isolated coding repository requiring a standard-library-only crash-recoverable DAG runner with append+fsync journaling, recovery, retries, cancellation, budgets, idempotency keys, and nine adversarial `node:test` cases.

No model or Hive release was promoted.

## Observed runs

| Workflow | Result | Recorded node time | Tokens recorded | Tool calls | Evidence |
|---|---:|---:|---:|---:|---:|
| Research attempt 1 | Failed at intake persistence | 10.8 s | 788 | 0 | 0 |
| Research attempt 2 | Correctly failed evidence gate | 20.3 s | 1,512 | 1 | 0 |
| Research attempt 3 | Failed structured gap analysis | 134.1 s | 2,567* | 20 | 16 |
| Coding attempt | Correctly failed repair gate | 98.7 s | 6,279* | 2 deterministic checks | 0 |

`*` Failed model calls do not yet persist upstream usage, so these totals are lower bounds.

## Research findings

- The initial outer-only `StageResult` validation allowed malformed nested evidence into persistence. The run failed twice on an undefined excerpt. Nested validation and deterministic ownership of canonical evidence/artifacts were added.
- Without a dedicated query stage, the model echoed the objective and the runtime searched the entire prompt. Search returned no results; source reading produced zero records; the evidence gate correctly refused synthesis.
- A dedicated query role produced eight entries, but they were primary URLs rather than search phrases. Searching only the first four URLs yielded 16 fetched pages: 13 distinct hosts, 13 distinct content hashes, seven official Node/SQLite records, and two anti-bot pages.
- The evidence gate passed on count alone. Source quality was mixed and duplicated; direct URL handling and autopsy warnings for blocked/duplicate source content were added.
- The gap/contradiction verifier failed strict nested structured output after a repair attempt, retried once, and failed again. Attempt one consumed about 128 seconds. The model-facing schema was subsequently reduced while the persistent `StageResult` contract remains typed.
- Citation synthesis was never reached, so the research task did not pass.

## Coding findings

- Repository mapping initially passed only filenames and an artifact hash. Each node received only its direct parent's compact result, so the source skeleton and tests disappeared by the time the implementer ran.
- Intake, plan, critique, and implementer all claimed the code and tests were complete. The implementer made zero worker tool calls and left `throw new Error("not implemented")` unchanged.
- Deterministic `npm test` and lint execution took 358 ms. Tests failed, lint passed. The requirement audit rejected every completion criterion and entered bounded repair.
- Both repair attempts also made zero worker tool calls. The workflow failed rather than emitting a final success report.
- Independent rerun of the fixture confirms one validation test passes and eight behavior tests fail; the source remains unchanged.
- Typed context now carries bounded transitive results, repository mapping includes high-signal file excerpts, and implementation stages reject three consecutive text-only completion claims through a required-mutation nudge.

## What worked

- Capability probing rejected unverified role assignment and verified `victory9-8b` before use.
- The one-GPU queue serialized research and coding with zero model swaps.
- Pause, application restart, manual node override, and resume preserved completed nodes.
- Evidence gates, deterministic tests, requirement audit, retry ceilings, and final-report gates prevented false success.
- Full failed attempts and routing decisions remained inspectable.

## What did not work

- Small-model obedience to role semantics was poor: several stages converted requirements into claims of completion.
- Model-facing schemas were too complex at large context sizes.
- Search treated direct URLs as queries and source-quality scoring was initially count-based.
- Compact handoffs were too lossy when restricted to direct dependencies.
- Failed structured model calls did not record usage, making cost diagnosis incomplete.
- The post-hardening clean rerun could not be started because the execution environment rejected another local-server approval after its usage limit was reached. The hardened code type-checks, lints, and production-builds, but its behavioral improvement is not yet measured.

## Promotion decision

**Do not promote.** Verified completion is 0/1 for research and 0/1 for coding on this evaluation. The safety/verifier layer is substantially better than the worker layer: it catches failures honestly, but the hive does not yet outperform a single capable coding/research model on task completion.

Next evaluation should rerun the exact same fixtures unchanged, then add model-role comparisons (`victory9-8b`, Qwen 8B, Gemma 12B) and record failed-call usage. The key acceptance signal is not better prose: it is nonzero worker mutations followed by all nine coding tests and final citation verification passing.
