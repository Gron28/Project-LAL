# Experiment ledger

This ledger is the evidence contract for the active program in
[`PLAN.md`](PLAN.md). Improvement experiments are prospective: create an entry
before changing the measured behavior, with a falsifiable hypothesis and a
named comparison. Baseline inventories, contract repairs, and platform
qualification also need acceptance records, as described below. A
fixture test can show that code works; it cannot by itself confirm a live
reliability, training, or portability claim.

Machine-readable entries live in `benchmarks/experiments/ledger.jsonl`. No
experiment is certified until it has both a baseline and a follow-up artifact
from the same task set and a recorded decision. Missing evidence is
`PARTIAL`, not success. This initial ledger defines the contract and records
no fabricated artifact IDs. Historical phase numbers now identify the matching
gates in [ACCEPTANCE.md](ACCEPTANCE.md). [PLAN.md](PLAN.md) owns milestone order.
Historical entries are not recertified by a plan revision.

## Acceptance records and experiment boundaries

For baseline, execution, migration, and platform checks, record the milestone,
acceptance gate, accountable
implementer, source/build identity, exact command or scenario, expected result,
observed result, artifact location/hash, status, remaining failures, next action,
and rollback where state changes. Store these records beside their artifacts
and link the gate's evidence here. A failing baseline is valid evidence, not a
successful qualification. Do not invent a before/after improvement to record a
contract test, documentation edit, or fresh platform check.

Use the experiment schema below when claiming a harness, model, or training
improvement. Gate 5 requires a valid matched measurement protocol and the
relevant execution checks; a failed task campaign may motivate the experiment.
Gate 3 applies to migration, not every direct-CLI improvement. Gate 7 is
independent of gate-6 training. Keep historical entries intact; attach new
evidence under new artifact IDs.

Prospective records must specify the primary gain threshold, per-task and
resource regression guards, maximum run budget, and stopping rule in
`hypothesis`, `taskSet`, and `metrics`. Preserve scheduled failures, timeouts,
and missing observations. Partial campaigns cannot certify a gain. A changed
grader or task set requires a version change and a new matched comparison.

## Required entry fields

Every experiment entry must contain the following fields. Keep it immutable after
the experiment starts except for appending follow-up evidence and the final
decision.

| Field                    | Requirement                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | Stable, unique identifier, for example `exp-2026-09-18-001`.                                                                                                                                                                        |
| `createdAt`              | UTC timestamp written before the code or configuration change.                                                                                                                                                                      |
| `phase`                  | Matching numbered acceptance gate from `ACCEPTANCE.md`, plus the delivery milestone from `PLAN.md`. Keep the historical `phase` field name for compatibility.                                                                                                                                                                  |
| `hypothesis`             | Prospective and falsifiable: name the changed seam, expected metric movement, task population, and regression guard.                                                                                                                |
| `change`                 | Exact files, configuration, commit/diff identifier, and one behavior changed. Do not bundle unrelated interventions.                                                                                                                |
| `taskSet`                | Stable task IDs, suite/version, sample count per task, held-out exclusions, and ordering/randomization seed.                                                                                                                        |
| `baselineArtifactId`     | Immutable artifact ID for the pre-change run; include the metadata baseline and the relevant report.                                                                                                                                |
| `followupArtifactId`     | Immutable artifact ID for the matched post-change run. `null` is allowed for `PROPOSED`, `RUNNING`, or `PARTIAL`; it never supports a confirmed gain. |
| `environmentFingerprint` | Source/build identity, OS/architecture, runtime versions, model artifact/quantization, tokenizer/template, hardware, and flags. Capture metadata with `scripts/capture-plan-baseline.mjs`; also retain restorable source and exact executable hashes. Its untracked-path hash does not hash file contents. |
| `metrics`                | Raw numerator/denominator and the planned comparison: pass@1, pass^k, per-condition failures, duration/decay, held-out score, or portability result as applicable.                                                                  |
| `decision`               | One of `pending`, `adopt`, `rollback`, `refute`, or `inconclusive`, with the observed evidence and threshold used.                                                                                                                  |
| `rollback`               | Exact reversible action, target revision/configuration, and the artifact that proves the prior state can be restored. A vague “revert if bad” is not sufficient.                                                                    |
| `status`                 | `PROPOSED`, `RUNNING`, `PARTIAL`, `CONFIRMED`, `REFUTED`, `INCONCLUSIVE`, or `ROLLED_BACK`.                                                                                                                                         |

## Artifact and comparison rules

1. Before changing measured behavior, run `node scripts/capture-plan-baseline.mjs` (or
   `npm run baseline:capture`) and save its JSON under an immutable artifact
   ID. Its repository hashes and runtime metadata are the environment
   fingerprint, not a substitute for the task report or source archive. Retain
   selected tracked patches and reviewed untracked source contents separately;
   prove the identified build can be restored without collecting owner secrets.
2. The baseline and follow-up must use the same task IDs, task-set version,
   model/runtime identity, budget, and acceptance graders, except for the single
   variable explicitly under test (for example a model in a model comparison).
   If an additional variable changes, open
   a new experiment or mark the comparison `inconclusive`.
3. Record full reports, not only a percentage. At minimum retain the
   pass/fail numerator and denominator, per-condition outcomes, task keys,
   durations, and incomplete/error reasons. `scripts/reliability-metrics.mjs`
   and `scripts/html001-metrics.test.mjs` define the task-level pass^k and
   condition/decay summaries used by the current program.
4. A decision must be made against the prospective hypothesis. If the expected
   improvement is absent, a guard regresses, or the task set is incomplete,
   choose `refute`, `rollback`, or `inconclusive`; do not relabel it `adopt`.
5. Rollback is part of the experiment, not an emergency note. Preserve the
   pre-change artifact and state exactly which commit, patch, dataset, adapter,
   or configuration restores it.

## Entry template

Copy this template into the experiment store used by the operator. Do not
replace `null` with a guessed report path or ID.

```json
{
  "id": "exp-YYYY-MM-DD-NNN",
  "createdAt": "YYYY-MM-DDTHH:MM:SSZ",
  "phase": "Gate 5 — Measured harness improvements; M2 everyday CLI",
  "hypothesis": {
    "claim": "A single named change will improve ...",
    "expectedDelta": "pass^3 +0.10 with no increase in incomplete outcomes",
    "regressionGuard": "zero observed false completions; all prescribed recovery checks exercised and passed; within the frozen task/time budget",
    "stoppingRule": "One predeclared complete batch per candidate; no sampling until favorable"
  },
  "change": {
    "files": ["path/to/file"],
    "revision": "git commit or tracked diff artifact",
    "scope": "one behavior changed"
  },
  "taskSet": {
    "id": "suite-name@version",
    "taskIds": ["task-001", "task-002"],
    "runsPerTask": 3,
    "maximumScheduledRunsPerCandidate": 6,
    "heldOut": [],
    "seed": 0
  },
  "baselineArtifactId": "artifact-...",
  "followupArtifactId": null,
  "environmentFingerprint": {
    "captureArtifactId": "artifact-...",
    "gitHead": "...",
    "trackedDiffSha256": "...",
    "untrackedPathInventorySha256": "...",
    "sourceArtifactId": "restorable-source-...",
    "executableSha256": "...",
    "runtime": "node/python/runtime versions",
    "modelRuntimeHardware": "model, quantization, backend, hardware, flags"
  },
  "metrics": {
    "baseline": {},
    "followup": {},
    "comparison": {}
  },
  "decision": {
    "value": "pending",
    "reason": "Awaiting matched follow-up"
  },
  "rollback": {
    "action": "Restore the recorded revision/configuration ...",
    "verificationArtifactId": null
  },
  "status": "PROPOSED"
}
```

## Current evidence map

These are implementation seams, not completed experiments. They make the
pending work concrete without inventing measurements:

| Seam                         | Implementation present                                                                                                                                   | Evidence still pending                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Baseline capture             | Capture script, root `baseline:capture`, historical `2026-09-18-native-cli-contract-v1` metadata | Restorable source/build, actual model/runtime identities, task contents, and new acceptance reports; the old artifact is not a complete reproducible baseline |
| Reliability summaries        | `scripts/reliability-metrics.mjs` with `scripts/html001-metrics.test.mjs`                                                                                | Repeated matched task runs and a decision supported by denominators                   |
| Native CLI durability        | `apps/cli/packages/core/src/agents/runtime/workflow-durability.test.ts`, journal, and orchestrator seams                                                 | Live interruption/restart/cancel/recovery acceptance through the native CLI           |
| Incomplete tool loops        | `web/src/lib/toolloop-incomplete.test.ts` exercises the max-rounds incomplete outcome                                                                    | Multi-task reliability comparison on the accepted execution path                      |
| Trace-stable training        | `scripts/build_hive_role_dataset.py`, `scripts/step_critic.py`, and `scripts/finetune_sft.py` support deterministic masking and held-out training inputs | Matched masked/unmasked training, held-out role results, and regression guards        |
| Control-path and portability | Existing CLI/Hive and desktop deployment seams                                                                                                           | Consolidation and Linux/Windows/macOS evidence; neither is currently claimed complete |

The first recorded consolidation entry is
`exp-2026-09-18-native-hive-001`. It remains `PARTIAL`: deterministic tests
prove native routing and single-slot ordering, while live-model execution and
legacy history migration remain deliberately unclaimed.


## 2026-09-20 — HTML-001 grading repairs (M2 enabling work)

Acceptance record for a contract bug fix; no model-quality improvement is claimed.
Implementer: Codex. Scope: gates 1/4 measurement integrity.

- Reproduced from the previous runner: a Linux 10-of-100 partial batch with
  nine passes reported `meetsBar: true`; a complete 9/10 Windows result exited
  with failure despite meeting the advertised bar.
- Added grader identity `html-001-grader/v2`, explicit successful CLI completion,
  timeout/error checks, full browser-probe and external-request guards, and
  complete Windows qualification. Page-only and full-run checks share the
  same page acceptance. Flush traces before reading; clean up failed-launch
  timers; reject invalid run budgets; aggregate all unmeasured conditions.
- Verification: `npm run test:contracts` passed **15/15** tests, including a real
  child-process launch failure/report and invalid-run-count test. Ran outside
  the sandbox because it blocks nested executables. `node --check
  scripts/html001.mjs` and the runner's `--help` passed. `npm run doctor` passed
  all required checks outside the sandbox. No inference or training was run.
- Source: `scripts/html001.mjs`, `scripts/html001-acceptance.mjs`, its test file,
  and root package scripts. Session pre-edit copies are in
  `/tmp/lal-small-fixes-before/`; they are temporary rollback aids, not a
  reproducible model baseline or durable release artifact. Existing v1 reports
  remain untouched. New comparisons must use matched v2 graders.
- Status: implemented and regression-verified on Linux. Native Windows, actual
  browser behavior, exact-value/range probes, live task performance, and
  interruption recovery remain unqualified. Next delivery work remains M1's
  representative installed-CLI task.


## 2026-09-20 — monitoring resource reductions (M2 enabling work)

- Implementer: Codex. Diagnosed duplicate CPU samples and synchronous
  `ollama ps` execution for concurrent status readers, plus overlapping SSE
  refreshes and a timer created after an early disconnect.
- Change: asynchronous Ollama observation, one shared in-flight sample, a
  one-second cache, and serialized/abort-aware SSE refresh with bounded queuing.
  Task execution and model-serving configuration are unchanged.
- Controlled comparison: [raw sampler measurements](../benchmarks/experiments/sysinfo-sampling-2026-09-20.json).
  The same ten-reader workload used a simulated 100 ms Ollama subprocess and
  real local sysfs/procfs. One before/after observation: 1238.7 → 204.6 ms,
  subprocess calls 10 → 1, maximum observed event-loop gap 632.7 → 10.1 ms.
  Immediate repeat 304.1 → under 0.1 ms. This demonstrates reduced duplicate
  work under that fixture; it does not establish production page-load or model
  performance. Both source hashes and environment identity are in the artifact.
- Verification: `node --experimental-strip-types --test --test-isolation=none
  web/src/lib/sysinfo.test.ts web/src/lib/dashboard-stream.test.ts` passed 5/5.
  From `web/`, `node node_modules/typescript/bin/tsc --noEmit --incremental false`
  passed; ESLint passed on the sampler, stream helper, tests, and stream route.
- Limits: hardware observations can be cached for one second after sampling;
  each module instance/server worker has its own cache. Other status readers
  still include synchronous work and were outside this bounded change.
- Status: source implemented and checked; production activation and actual
  page-load measurements remain pending. Existing guarded web rebuild applies
  these changes. Pre-edit copies in `/tmp/lal-perf-before/` are session rollback
  aids, not a permanent release archive.

## 2026-09-21 — M1 first installed-CLI task and Gate-2 recovery repairs

- Implementer: Claude (orchestrator) with bounded Sonnet workers. Base commit
  `03ef6637`, dirty working tree. Installed CLI `~/.local/bin/lal` ->
  `apps/cli/dist/cli.js`, version `0.1.0-lal.43`, bundle built 2026-09-20
  23:39:59. Host `project-lal.service` active on `127.0.0.1:3130`.
- M1 task: fixture `01-window-boundary-bug` from `benchmarks/codex-harness-ab/`,
  driven through the installed CLI by `scripts/codex-harness-ab.mjs` in a
  disposable workspace, graded by a hidden check the model never sees.
- Result: **0/3 passed**, scores 70 / 55 / 65 (floor 55), wall 543 / 736 / 388 s.
  All three runs failed the identical hidden assertion: `summarizeWindow`
  destructures `{ now, windowMs }` in the parameter list, so a null `options`
  throws `TypeError` instead of the required `RangeError`. Every other hard gate
  passed in every run (publicCorrectness, buildAndTypecheck, safety, setup);
  0 tool errors and 0 workspace violations throughout. Trial 2 additionally
  recorded `completed: false` while producing the same defect.
- Classification: a reproducible **model** failure in defensive input
  validation, not a connection, execution, validation-instrumentation, or
  interface failure. This is the M1 reproducer; it is not a model-ceiling claim.
  Artifacts: `web/.data/codex-harness-ab/2026-09-21T03-09-24-998Z` and
  `.../2026-09-21T03-32-24-200Z`.
- Secondary observation: `firstToolLatencyMs` 136413 on run 1 (136 s before the
  first tool call), 349312 prompt tokens against 5163 completion tokens over 18
  model calls. Not yet diagnosed; recorded as a candidate user-cost item.
- Gate-2 repair (durability): the journal vocabulary was only `started`/`result`,
  and `workflow-orchestrator.ts` ordered `persist(started)` -> real side effect
  -> `persist(result)`. A crash in that window left a `started`-only key that
  `countedDispatch` treated as a cache miss and blindly re-executed. Added an
  `effect_complete` entry type plus `ambiguousEffects`; such a key is now
  refused rather than silently repeated. Old journals replay unchanged (they can
  never prove their effect ran) — stated limit, not an oversight.
  `JOURNAL_KEY_VERSION` deliberately not bumped: key derivation is untouched.
- Recovery exercise (M1 step 4): `scripts/m1-recovery-exercise.mjs`, disposable
  mkdtemp workspace, real SIGKILL at each boundary, graded against a durable
  on-disk action counter rather than a mock call count. All five scenarios pass:
  before_intent -> redispatched, after_intent -> redispatched,
  after-effect-before-result -> **refused-ambiguous**, after_result -> cached,
  baseline -> full cache replay; every effect count exactly 1. Residual and
  undetectable: a crash during the `effect_complete` append itself.
- Other repairs, each with tests: false `complete` in `native-hive-recipe.ts`
  (a run whose own checks failed still reached `registry.complete()`) and its
  unconditional repair dispatch; SIGINT never reaching the workflow abort, so
  the snapshot `finally` did not run on Ctrl+C; undisclosed approval scope
  (users saw only "Run a workflow script (N chars)"); `/hive` failing without
  naming `QWEN_CODE_ENABLE_WORKFLOWS=1`; harness gateway defaulting to a dead
  port 8770 and thereby misattributing connection failures to the model;
  `capture-plan-baseline.mjs` raised to schema v2 with CLI/model/backend
  identity and retained tracked-diff blob.
- Verification: core durability 26/26; `workflow.test.ts` 38/38 after the
  integrator updated a stale assertion that pinned the old two-entry journal;
  `native-hive-recipe.test.ts` 7/7; hive command/client 12/12; gemini signal
  suites 49/49; recovery self-tests 25/25; `npm run doctor`, `test:contracts`
  15/15, web sysinfo/dashboard 5/5, prompt-tool-visibility 31/31.
- Limits: nothing is committed; no build, deploy, or service restart was
  performed; no gate is newly certified. One fixture and one model do not
  qualify M1's Done criteria, which still require a task that actually succeeds.
- Status: M1's recovery half is demonstrated; M1's useful-result half is not.
  Next action is a decision on the reproduced model failure — cheaper harness or
  prompt fixes before any model change, per the plan's improvement table.

## 2026-09-21 — Ternary Bonsai 2 27B evaluation (candidate model, not adopted)

- Motivation: owner request. A 27B-class model at ~6 GB would move local
  capability parity more than any current plan item.
- Build: `PrismML-Eng/llama.cpp` at tag `prism-b10709-9a9394a` (newer than the
  required b10658), configured `-DGGML_VULKAN=ON` against the in-tree Vulkan SDK
  1.4.357.1 with `vulkan-sdk/user-lib/libvulkan.so`. Tree at
  `llama/experimental-bonsai2/`. No ROCm/HIP was installed or needed.
- Correction to the starting premise: the fork's Vulkan ternary kernels ARE
  present (`dequant_ptq1_0.comp`, `ptq1_0.glsl`, `mul_mat_vec_tq2_0.comp`;
  295 PTQ1_0 references in the built `libggml-vulkan.so`). The claim that AMD
  requires HIP/ROCm is out of date for this fork version.
- Artifact: `models/Ternary-Bonsai-2-27B-PTQ1_0.gguf`, 5.53 GiB, GGUF magic
  verified, from `prism-ml/Ternary-Bonsai-2-27B-gguf`.
- Hardware: AMD Radeon RX 6650 XT (RADV NAVI23), 8 GB, no matrix cores. NOTE the
  18.8 t/s figure circulating for this model is an RX 6800M (Navi 22, 12 GB,
  ~1.4x bandwidth) with a GPU-specific compile; it is not a like-for-like
  reference for this machine.
- Fit: loads fully offloaded at `-ngl 99`, `-c 8192`, `-fa on`, q8_0 KV, using
  5.83 GB of 8 GB VRAM. A 27B-class model is resident on an 8 GB card.
- Controlled comparison, same `llama-bench` binary, same flags, same GPU:
  Bonsai-2 27B PTQ1_0 (5.53 GiB, 26.90B): pp128 17.06 +/- 0.04, tg64 3.83 +/- 0.00.
  qwen35-9b-fable-heretic Q4_K_M (6.35 GiB, 8.95B): pp128 335.68 +/- 20.67,
  tg64 38.45 +/- 0.04. That is 19.7x slower prefill and 10.0x slower generation.
- Decision: **not adopted.** Prefill dominates this product's cost — the M1 run
  consumed 349312 prompt tokens, which is ~17 min of prefill at the current
  model's rate and ~5.7 h at Bonsai's. Even an optimistic GPU-tuned rebuild
  recovering the reference's ~5x would remain ~4x slower than the incumbent.
- Not measured, explicitly: coding or reasoning QUALITY. Prism's reported 84.78
  vs 86.32 FP16 average was not reproduced here and is not evidence for this
  machine. No held-out comparison was run, so no quality claim is made.
- Retained lever if revisited: a gfx1032/Navi-23-specific build, which the one
  public RDNA2 datapoint says was required to reach its number. PQ2_0 (7.21 GB)
  is likely excluded by the 8 GB VRAM budget once KV is added.
- Status: experiment complete and recorded. Incumbent serving model unchanged.

## 2026-09-21 — latency diagnosis addendum (supersedes the earlier "not yet diagnosed" note)

- The 136413 ms time-to-first-tool-call recorded above is now accounted for to
  within ~1 s, cross-validated between `trace-timing.jsonl` and
  `out/llama-server.log`: ~61.5 s CLI rebuild, ~23.6 s model cold-load,
  ~42.2 s prefill of that call's 13053 tokens, ~7.3 s decode. Run 3 skipped the
  rebuild and cold-load and reached its first tool call in 54251 ms, confirming
  both costs are once-per-batch rather than per-turn.
- **Correction.** The earlier framing of "349312 prompt tokens" as prompt bloat
  was wrong. That figure is the SUM of 18 growing per-call prompts (13053 ->
  25505 tokens each, exact arithmetic match), i.e. ordinary agent-loop context
  accumulation. Prompt caching is real and effective here — llama-server's own
  `graphs reused` counter and a 43 s -> 0.9 s prefill drop confirm it.
- The CLI rebuild fires because `bin/lal`'s stale-bundle check trips on the dirty
  `apps/cli` working tree. It is an artifact of active development, not a
  product defect, but it is paid on every CLI launch in a benchmark batch.
- **Backend fault in run 2**: a ~336 s stall followed by a 50.9 s full re-prefill
  after the KV cache was lost — ~393 s, about 53% of that run's 736 s wall. This
  also explains that run's `completed: false`. Server log shows
  `E srv llama_server: exiting due to HTTP server error` and repeated
  `W common_fit_params: failed to fit params to free device memory`. Under
  Gate 2 a backend failure must yield recovery or an explicit blocker, never a
  silent multi-minute stall; the responsible seam is under investigation.
- Revised lever ranking for wall time: backend fault stability first (largest
  single-run cost), then decode throughput (60.7% of a CLEAN run — a larger
  lever than prefill), then rebuild-on-launch, then model cold-load. Tool-schema
  trimming is last and riskiest: this repo already has a tool-deferral mechanism
  and manual trimming risks repeating the recorded "deferred tools vs prompt
  drift" incident.
- The three M1 correctness failures are unaffected by all of the above: all
  three runs failed the identical hidden assertion, so the null-options guard
  remains genuine model behaviour, not an infrastructure artifact.

## 2026-09-21 — run-2 serving incident: corrected account and named seam

- **Correction, twice over.** This incident was earlier recorded here and
  reported as "a backend crash" causing "a ~336 s stall". Both descriptions are
  wrong and are retracted. (1) There was no stall: `out/llama-server.log` shows
  continuous decode of one unusually long completion, 5245+ tokens at a steady
  ~16 t/s with regular `print_timing` lines throughout — real work, not a hang.
  (2) There was no crash: the gateway kept the same PID (`run_web.sh[265620]`)
  across the whole window, and `/var/log/kern.log` and `/var/log/syslog` contain
  no OOM-kill, no unit restart, and no amdgpu/Vulkan entries anywhere near it.
- What the evidence does support: the socket broke mid-generation
  (`⨯ Error: failed to pipe response ... UND_ERR_SOCKET: other side closed`,
  03:41:15.139Z), and the host then re-launched llama-server —
  `[lal-serve] restarting llama-server ... model differs (have model=null ctx=0
  exit=none; want ctx>=121856)` at 03:41:17.184Z — paying a 50861 ms /
  14767-token re-prefill. Launch boundaries confirmed in the server log at
  03:33:25.980Z and 03:41:17.655Z.
- **Unresolved, stated rather than guessed:** why the socket broke. The evidence
  does not distinguish a transient localhost/Undici failure from an internal
  llama-server fault that left no log trace. Which caller invoked the unsafe
  stop is also not directly observed; `stopServing(force=true)` is a deduction
  by elimination across the `srv.model = null` call sites, not a sighting.
- **Named seam:** `web/src/lib/lab.ts` `stopServing()` (~line 593). Its default
  `force = true` unconditionally bypasses the `generationsInFlight() > 0`
  drain-or-refuse guard that every other restart path respects. That is its
  documented contract, but when it destroys a live generation it writes NO
  record: nothing distinguishes destroyed in-flight work from a routine idle
  unload. Gate 2 requires recovery or an explicit blocker/failure; silent
  destruction of in-flight work followed by an opaque costly recovery is
  neither. This is a recurrence of the repo's recorded mid-stream kill class.
- **Structural finding, larger than the bug:** `web/src/lib/lab.ts` — the host
  kernel per ARCHITECTURE — cannot be imported by this repo's test runner. Its
  relative imports omit extensions and resolve only under the Next bundler;
  `node --experimental-strip-types --test` fails with `ERR_MODULE_NOT_FOUND`.
  The host kernel therefore has no unit coverage, which is why a defect of this
  class can recur unobserved. Owner decision on 2026-09-21: make it testable,
  then fix. Import-resolution work plus an observability-only change is in
  progress; `next build` verification is a required gate before it is trusted.
- Also corrected: the CLI rebuild cost is once per BATCH, not per launch —
  first trial of a batch showed `firstToolLatencyMs` 122901, second 54251.
  A benchmark therefore should NOT set `LAL_SKIP_CLI_BUILD=1`: that would trade
  one minute per batch for the risk of measuring a stale bundle. `bin/lal` was
  instead changed so the pre-existing opt-out warns loudly on stderr when it
  skips a stale bundle, closing a silent-stale-run hole on the install/update
  paths where that variable is actually used.
