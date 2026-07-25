# Project-LAL — the plan

**This is the only plan.** Status: authoritative, opened 2026-07-24. It replaces
every other plan, roadmap, gap audit, findings note, and research doc in this
repository. If something is not in this file, it is not committed work.

Three documents survive alongside it, and they are not plans:

- `README.md` — what Project-LAL is and how to run it.
- `CHANGELOG.md` — the append-only engineering log.
- `docs/ARCHITECTURE.md` — what exists today, produced by Stage 0.

Everything else in `docs/` is deleted at the end of Stage 0. Decisions worth
keeping from those documents are carried into Appendix A of this file. Git
history retains the originals.

---

## Start here — next session, in this order

State as of 2026-07-25, end of day. Stages 0, 1, 3, 4, 5, 6 complete; Stage 2
complete except **2.4**; Stage 7 partially applied. Working tree clean, 15,471
core tests pass, nothing pushed.

**Everything remaining is gated on one number that does not exist yet.** Eight
stages of behaviour changed after the last benchmark run (6/6, 2026-07-24), and
none of it has been measured.

### 1. Run HTML-001. This is the whole first step.

```bash
export LAL_API_KEY=$(./start.sh --show-cli-token | tail -1)
npm run bench:html001 -- --runs 10
```

Safe to interrupt now: the report is rewritten after every run and carries
`complete: false` until the loop ends. Output goes to `web/.data/html001/` —
**never** `web/.data/bench/`, which is the benchmark UI's results directory (four
reports written there on 2026-07-24 blanked the /benchmark page).

Compare against `web/.data/html001/html001-after-enforced-breaker-2026-07-24.json`
(6/6). Conditions 7 and 8 are now real measurements: the record carries
`interruptedWrites`, `resumedFromDraft`, `discardedDrafts`.

**The bar is 9 of 10 on Windows, unattended.** Until it is recorded in
`CHANGELOG.md`, Stage 7's deletions and Stage 8 do not begin.

### 2. Stage 7 — de-brand and delete (after the bar)

The two big mechanical jobs, in this order, each verified by `npm test` +
`node esbuild.config.js` + the full vitest suite after every batch:

- **7.3 name ownership.** ~3,000 files contain `qwen`; 364 CLI UI files alone.
  Most user-visible `Qwen` strings belong to the inherited **cloud OAuth
  surface**, so the fix there is 7.2 deletion, not renaming. Do the package
  rename (`@qwen-code/qwen-code-core` → a LAL name) as one atomic batch with the
  build as the gate; it is mechanical but touches nearly every file, so it needs a
  session where the whole thing fits in context.
- **7.1/7.2** apply the Stage 0.2 census and remove cloud providers, enterprise
  channels, the desktop/mobile surface, SDKs, the computer-use driver, and the
  `lab-agent` path.

### 3. 2.4 — the execution kernel. The one stage never attempted.

Read the three files before planning: they are **layers**, not copies
(`tools.ts` defs+executor, `agent-tools.ts` extended executor, `toolloop.ts` the
loop). The name-agreement duplication is already guarded
(`scripts/check_prompt_tool_visibility.mjs`, 26/26 in agreement). What remains is
collapsing the web executor/loop and the CLI's `coreToolScheduler` into one
component — and note the shared-package constraints in
`packages/protocol` before designing it (see "Traps" below).

### What landed 2026-07-25 — all unmeasured against HTML-001

| Stage | Change |
|---|---|
| — | benchmark page fixed (`listBench` validates shape); `/api/bench` 1.27 MB → 40 KB |
| 3.1 | write stash enforced: resume verified, smaller restart refused once, regeneration labelled |
| 4.2 | research completes on evidence (breadth / independent origins / plateau); citations must name opened origins; "stop" outranks the gate |
| 5 | read cache re-armed for fully re-embedded files; staged drafts survive compaction |
| 6 | acceptance-criteria registry; completion validated against artifacts on disk, bounded repair |
| 2.2 | one tool registry in `packages/protocol`; `sync-protocol.mjs` + doctor check |
| 2.5 | `ModelLease` bounds subagents to 1 with an announced queue; research forced headless |
| 3.3 | whitespace-drifted anchors match; damaging patches refused; `replace_all` bounded |
| 7.2 | `vitest run` at `apps/cli` root fixed; 20 dead npm scripts removed |
| 7.4 | fresh-clone onboarding for either machine; `npm run doctor` |
| 2.1 | **root cause found**: `web_search`/`web_fetch`/`send_message` were `shouldDefer:true` while prompts told the model to use them → the model passed tool names to the shell. All four 2.1 hypotheses now closed with evidence. |
| 1.2 | runtime decisions (gate rejections, refusals, verdicts) now recorded and shown in `/export` as `[runtime] …` |
| 3.2 | the five `ensureServing` clauses are instrumented; a restart names its own cause |

### Traps that have already cost real time

- `lal` runs from `apps/cli/dist`. Rebuild with `cd apps/cli && node esbuild.config.js`
  — it now also copies `dist/vendor/` (ripgrep). Missing that is why "ripgrep not
  available" appeared on every start.
- Deploy the host with `scripts/rebuild-local-ai-lab.sh`. The unit is
  **`systemctl --user`** scoped; system scope falsely reports it dead.
- `packages/protocol` must be a **synced copy** in `web/node_modules`. A symlink
  breaks `next build` (Turbopack cannot resolve outside the project root) and the
  package cannot re-export across its own files. `scripts/sync-protocol.mjs` runs
  from web's prebuild.
- A `git push` ships nothing to Windows: version bump + `scripts/release-lal-cli.sh`
  + redeploy. `./update-all.sh` does it all on Linux.
- Whenever a prompt names a tool, check that tool's `shouldDefer`. The failure is
  silent — the only symptom is a model that "uses the shell wrong".

### How to measure anything

```bash
export LAL_API_KEY=$(./start.sh --show-cli-token | tail -1)
npm run bench:html001 -- --runs 10 --out /tmp/run.json    # full benchmark
node scripts/html001.mjs --validate-only <dir>            # page check only, no GPU
```

Deploy the host with `scripts/rebuild-local-ai-lab.sh`. The CLI is served from
`apps/cli/dist`, so a CLI source change needs
`cd apps/cli && node esbuild.config.js` before `lal` picks it up.

---

## The one goal

> Give LAL a normal website request, and it must continue until a complete,
> working, validated website exists on disk.

Restated as the single benchmark this plan is measured by:

### HTML-001

Prompt: *"create a single-file interactive website"* (fixed wording, fixed
follow-ups, defined in Stage 1).

A run **passes** only when every one of these is true:

1. `index.html` exists on disk.
2. The full requested implementation is present — not a stub, not a subset.
3. HTML and JS parse without error.
4. The page loads with no fatal console error.
5. Every requested control functions when exercised.
6. The requested visualization renders.
7. An interrupted write **resumed** rather than restarted.
8. No previously-accepted code was regenerated.
9. The agent validated the result before claiming completion.

Tracked per run, always: completion rate, browser-load rate, functional pass
rate, tool failures, retry count, tokens consumed, regenerated-content waste,
wall-clock spent on discarded work.

**The bar: 9 of 10 consecutive runs pass, on Windows, unattended.**

Nothing in Stage 8 begins before that bar is met. Not HIVE, not training, not
new models, not bigger context, not more agents.

---

## Rules that govern this plan

1. **Measurement precedes repair.** Stage 1 builds the harness. Every later
   stage is judged by its effect on HTML-001, not by whether code was written.
2. **Diagnosis precedes fix.** Any item marked `DIAGNOSE` must produce a written
   root cause with a reproduction before a fix is designed. No speculative fixes.
3. **A stage is not done when the code lands.** It is done when its exit gate
   passes. Gates are mechanical, not judgement calls.
4. **The model proposes; the runtime decides.** "Done" from a model is never
   evidence.
5. **Freeze on capability.** No new feature, model, or agent capability enters
   the product before Stage 8. Bug fixes and deletions are always allowed.
6. **Delete before you add.** Where a stage can be satisfied by removing code,
   removal is the preferred implementation.
7. **Unknown stays visibly unknown.** No status value may degrade into a
   plausible-looking default.

---

## Stage 0 — Know what we have, then cut

**Why first:** the repo is 3,522 tracked files, of which 3,170 are an inherited
CLI fork we did not write. Cleanup decisions made without that map are guesses.

### 0.1 Full repository map → `docs/ARCHITECTURE.md`

Every directory, every significant file, every major section within the large
files. Not prose — a navigable reference. Required contents:

- Top-level layout with size, tracked-file count, and one-line purpose.
- `web/src` (25.7k LOC, 201 files): every route, lib, and component with its
  responsibility and its callers.
- `apps/cli` (~575k LOC): package-level map, and within it an explicit
  classification of every top-level source directory as **LAL-authored**,
  **inherited-and-used**, **inherited-and-dead**, or **unknown**.
- `scripts/` (48 files): each classified as **operational**, **one-off**, or
  **dead**, with evidence (referenced from where?).
- Untracked working roots (`models/` `out/` `llama/` `workspace/` — 37G): what
  generates them, what reads them, what is safe to delete.
- The data-flow spine: CLI turn → gateway → llama-server → tool dispatch →
  filesystem, named file by file.

**Done when:** a reader who has never seen the repo can locate the code
responsible for any observed behavior without grep.

### 0.2 Dead-code and dead-script census

Output: one list of every file proposed for deletion, with the evidence that
nothing references it. No deletions in this step — the list is the deliverable.

### 0.3 Documentation collapse

Write Appendix A of this file (decisions preserved), then delete:

```
docs/plans/                     (all 5)
docs/status/                    (1 — content absorbed into ARCHITECTURE.md)
docs/design/                    (all 15)
docs/history/                   (1)
docs/agent-memory-research.md
docs/cli-amnesia-findings.md
docs/cli-gateway-hive-inventory.md
docs/cli-looping-findings.md
docs/cli-subagent-findings.md
docs/cli-visibility-findings.md
docs/hive-specialist-training.md
docs/lal-cli-foundation-research.md
docs/orchestration-frameworks-research.md
docs/orchestrator-research.md
docs/victory6-architecture-research.md
docs/victory6-data-research.md
docs/victory6-model-research.md
docs/README.md                  (index for docs that no longer exist)
web/docs/hive-evaluation-2026-07-09.md
PORTING.md                      (content → ARCHITECTURE.md)
```

`AGENTS.md`, `web/AGENTS.md`, `web/CLAUDE.md`, `SECURITY.md` are operating
instructions, not plans — they stay.

**Exit gate 0:** `docs/` contains exactly `PLAN.md` and `ARCHITECTURE.md`.
`git grep -l` finds no surviving reference to a deleted path. The dead-code
census exists and is unapplied.

---

## Stage 1 — Build the instrument

**Why here:** every finding in the Windows testing round was reported as a
narrative. None of it is currently measurable. Until HTML-001 runs on demand
and emits numbers, we cannot tell a fix from a coincidence.

### 1.1 HTML-001 harness

A single command that runs the benchmark end to end and emits one JSON record
per run with all nine pass conditions and all eight metrics. Must run
unattended, on Windows and Linux, against a named model and a pinned LAL build.

**Built 2026-07-24** as `scripts/html001.mjs` (`npm run bench:html001`).
Verified against five fixtures: a correct page passes; a page that throws, one
missing a control, one with an undrawn canvas, and one fetching a remote asset
each fail through a different mechanism. Eight conditions are measured; 7 is
`null` until Stage 3 exists.

### 1.2 Local observability — keep the signal, cut the phone-home

**Scope reduced 2026-07-24.** `lal -p --output-format stream-json` already emits
a clean machine-readable trace: `usage` token counts, `num_turns`, wall and API
durations, per-tool `is_error`, `permission_denials`, and a **sha256 per write**
via `artifact_validation`. Conditions 8 and 9 are measurable today. What remains
is the removal half, plus compaction events, file-revision history across turns,
and recovery/resume events (which Stage 3 and Stage 5 generate).

The problem was never diagnostic visibility; it was external reporting. Two
separate jobs, done together because they touch the same files:

- **Remove:** vendor/upstream telemetry, Alibaba RUM defaults, startup registry
  checks, upstream update checks, `qwen-logger/`, inherited analytics exporters.
- **Keep and strengthen, all local, all on disk:** tool calls and failures,
  model invocations, context/token usage, compaction events, file revisions,
  state transitions, resource usage, research evidence, validation results,
  recovery/resume events.

Every HTML-001 run produces a complete local trace. A failed run must be
explainable from its trace alone, without reproducing it.

### 1.3 Baseline

Run HTML-001 ten times against current `main`. Record it. This number is the
control for everything that follows. **Do not fix anything before this exists.**

### 1.4 Free variables, measured not assumed

Two cheap changes that may move the baseline. Each is applied alone and
re-measured, so its effect is attributable:

- **Ollama 0.30.10 → 0.32.3.** Release notes covering the gap include
  *"tools now ignore braces appearing inside JSON strings when identifying tool
  call boundaries"* (0.30.12) and *"enhanced tool calling and multi-turn
  reasoning for Gemma 4"* (0.32.1). Both plausibly touch our known Gemma 4
  argument-drop bug. Requires root; restarts the daemon; briefly interrupts the
  `~/Desktop/inbox` service on `:11434`. If it lands, the gemma4 argument-alias
  workaround is deleted rather than maintained.
- **Model choice.** Establish HTML-001 baselines for each serveable model so
  later stages are not silently comparing across different models.

**Exit gate 1:** `bench html-001 --runs 10` produces a machine-readable report.
A deliberately broken build is correctly reported as failing. The baseline is
recorded in `CHANGELOG.md`.

---

## Stage 2 — One execution kernel, one tool dispatch

**Closes:** "tool routing is broken", "one authoritative execution kernel".

**Why here:** this is the failure the user hit first and hardest, and it is the
substrate every later stage sits on.

### 2.1 `DIAGNOSE` — the shell-fallback bug

Symptom: the model calls typed tools (`agent`, `tool_search`, `web_search`,
`web_fetch`) and LAL sometimes executes them through the raw Windows shell,
producing `'agent' is not recognized as a command`.

**Ruled out 2026-07-24:** an allowlist name mismatch in the gateway. The gateway
filters tools against `LAL_TERMINAL_TOOLS`
(`web/src/app/api/llm/v1/chat/completions/route.ts:10`) and silently drops
non-members at line 94 — but `agent`, `tool_search`, `web_search`, and
`web_fetch` are all present and match `apps/cli/packages/core/src/tools/tool-names.ts`
exactly. The cause is elsewhere.

Remaining hypotheses, to be tested against a captured trace, not reasoned about:

- ~~The model emits tool-shaped **text** that a parser converts to a shell
  command.~~ **RULED OUT 2026-07-25.** No such converter exists: nothing in
  `openaiContentGenerator/` emits `run_shell_command`, and both field traces show
  the model issuing a genuine `run_shell_command` tool call whose `command`
  argument happened to start with a tool name. The conversion runs the other
  way — `embeddedResearchCommand` rewrites shell→tool.
- ~~The model chooses `run_shell_command` on its own because a tool it was told
  about in the system prompt is absent from the actual payload (the prompt and
  the allowlist are separately maintained — verify they agree).~~
  **CONFIRMED 2026-07-25. This was the root cause, and it went unchecked for a
  day because the check was never run.** `web_search`, `web_fetch` and
  `send_message` were all registered `shouldDefer: true`, which hides a tool from
  the model's list until `tool_search` reveals it, while `prompts.ts`,
  `research-controller.ts` and `promptAddendum.ts` instructed the model to use
  them by name. Told to use an invisible tool, the model passed the name to the
  shell: `web_search "monitores usados"`, `subprocess.run(['web_search', q])`.
  Now enforced by `scripts/check_prompt_tool_visibility.mjs` in `npm test` —
  which found the third instance (`send_message`, the mandatory final action of
  every teammate subagent) on its first run.
- ~~A Windows-only path in the dispatch chain that Linux never exercises.~~
  **RULED OUT as the cause of this symptom 2026-07-25:** both reproductions are
  on Linux. Windows-specific shell defects were real and separate (bash
  preference, `ComSpec`, the BOM in `install.ps1`) and are fixed.
- ~~Tools loaded lazily through `tool_search` are dropped by the same line-94
  filter when their schemas arrive, leaving the model to improvise.~~
  **CONFIRMED and fixed in lal.34** (§2.1e): the computer-use driver advertises
  `computer_use__<verb>` and the allowlist named the bare verb.

**Deliverable:** a written root cause plus a failing test that reproduces it.
**Done** — root cause above, `tools/web-tools-visibility.test.ts` plus the
`npm test` check. All four hypotheses are now closed with evidence; two were real
and both were name-agreement failures between a prompt and a registry.

### 2.1a Root cause found — llama.cpp emits a constant `tool_call.id`

**Verified 2026-07-24.** Every tool call llama-server b9835 produces carries the
same id, `ZsSt4SkIFMRz0HtqT7MTlimNvzlKM896`. Proven by calling llama-server
directly with two freshly-named tools and getting the identical id a benchmark
run had produced hours earlier in an unrelated process.

Downstream, the terminal client renames collisions to `…__qwen_dup_2/3/4`, and
once ids are being rewritten, results attach to the wrong call. Both of these
were observed in one HTML-001 run, and neither error belongs to the tool that
reported it:

- `edit` failing with *"permission to use **run_shell_command** was declined"*
- `write_file` failing with *"the **'url'** must be a valid URL"*

That crossing of tool identity is the most plausible mechanism yet for the
Windows report of `'agent' is not recognized as a command`.

### 2.1b The obvious fix backfired — and why that matters

The gateway owns the wire format, so it looked like a contained fix: rewrite
every `tool_call.id` to a unique value on the way through. Implemented, verified
mechanically (65 calls, 65 unique ids, zero `__qwen_dup`), and it made the
system **dramatically worse**:

| | before | with id repair |
|---|---|---|
| wall | ~110s | **509s** |
| tokens | ~130k | **1,553,115** |
| tool failures | 1 | **37** |
| retries | 0 | **30** |

Reverted. The trace explains it: the model repeats itself hard — the same shell
command 8 times, another 6, another 5. With a constant id those repeats
**collided and the client deduped them** (`Duplicate provider tool call id … was
ignored and not executed again`). The upstream bug was accidentally acting as a
loop suppressor. Give every call a unique id and every repeat executes.

Two consequences for the plan:

1. **There is a looping defect underneath, and it has always been there** —
   masked, not absent. Fixing ids without first fixing loop control is strictly
   harmful. Order: loop control → id repair → verify.
2. **Advisory messages do not stop a small model.** The circuit breaker added in
   4.1 did classify these and told the model to stop; it kept going. Enforcement
   has to block execution, not reword the error.

### 2.1c Loop control landed, and the benchmark refused to credit it

**Measured 2026-07-24, six runs, `…-after-enforced-breaker-2026-07-24.json`.**

Step 1 shipped: the circuit breaker withdraws a tool for the session instead of
rewording the error, and an exact-repeat guard now covers the non-mutating
surface. Both are unit-tested. The benchmark says:

| | before (6 runs) | after (6 runs) |
|---|---|---|
| passes | 6/6 | 6/6 |
| tokens, median | 133k | **114k** |
| tokens, mean | 263k | **126k** |
| tokens, worst run | **948k** | 192k |
| turns, worst run | **33** | 12 |
| tool failures | 14 | 13 |
| retries | 7 | 7 |
| runs over 150k | 1 | **2** |

**None of that improvement is attributable to the change.** Neither guard fired
once: zero occurrences of either refusal message across all six runs. The mean
collapsed because the baseline's one 948k cascade did not recur, and that
cascade was seeded by the crossed `tool_call.id` (a `write_file` answered with
`'url' must be a valid URL`), which step 1 does not touch. Six runs is too few
to see it again. Failures and retries are flat, and the "no run above 150k"
target got *worse*, not better — 192k and 158k. **Step 1's exit gate is not met
by measurement; it is met by argument.** The argument is below, and it is strong
enough to proceed on, but it is not a number.

**Why nothing fired — and why this is the useful finding.**
`apps/cli/packages/core/src/core/turn.ts:223` already implements the same guard,
one layer upstream, and independently reached the same design: identity is
`providerCallId + name + args` (`getToolCallDedupIdentity`), and it is reset
after a mutation so the model may re-inspect what it changed
(`resetSemanticToolCallDedupAfterMutation`) — that is precisely the
`mutationEpoch` in the scheduler guard. Repeats are suppressed there before
scheduling, so the scheduler never sees them.

That upstream guard is keyed on **`providerCallId`**. It functions today only
because llama.cpp reuses one id forever. Give every call a unique id and every
identity becomes distinct, so it suppresses *nothing* — the guard does not
degrade, it silently switches off. **That, not the id rewrite itself, is the
mechanism behind §2.1b's 509s / 1.55M tokens.** §2.1b named the constant id as an
accidental loop suppressor; this locates the actual suppressor, in our own code.

So step 1's real product is a repeat guard that is independent of the provider's
id, ready to take over the moment the id is repaired. Its correctness is
established by unit test rather than by benchmark, which is the honest status.

Evidence the guard will have work to do: four `Duplicate provider tool call id`
suppressions occurred across runs 2, 4 and 5 of the after-set. Every one of them
becomes an executed call the moment ids are unique.

### 2.1d What shipped after 2.1c, unmeasured

Three fixes, no benchmark run — measurement was deliberately handed back to the
operator after 2.1c showed six runs could not resolve any of these effects.

1. **The same-turn call deletion** (step 2 above). The most consequential of the
   three: a parallel batch lost every call after the first under a constant
   provider id.
2. **Headless approval posture** (4.3) and **withholding unusable tools** (2.3).
3. **The gateway's silent tool drop** now logs which names it dropped, so a
   disagreement between `LAL_TERMINAL_TOOLS` and the client's advertised list
   names itself instead of leaving the model to improvise — still the leading
   hypothesis for the Windows `'agent' is not recognized as a command` report.

### 2.1e The Windows tool failures, root-caused 2026-07-25

The shell-fallback symptom in 2.1 finally has a mechanism, and it is not routing.

`web_search` threw client-side before sending, on every call, because a UTF-8 BOM
written by `install.ps1` reached an HTTP header (see CHANGELOG 2026-07-25). With
search unavailable the model guessed source URLs one at a time — which is what
"tool calling in general is broken" looked like from the outside.

Separately, and answering **hypothesis 4 of §2.1**: tools loaded lazily through
`tool_search` *were* being dropped by the gateway filter. The computer-use driver
advertises `computer_use__<verb>`; the allowlist named the bare verb. Every
browser/page tool was therefore deleted at the filter while `system.md`
instructed the model to load and use them. That is also the answer to "the agent
cannot navigate the web".

Both are fixed in lal.34. What remains unproven from §2.1 is only the Windows
`'agent' is not recognized as a command` report itself; the gateway now logs every
dropped tool name, so the next occurrence should name its own cause.

### 2.2 One tool registry

**DONE 2026-07-25** (unit-tested; no HTML-001 number yet — see "Start here").

A single declaration per tool — name, schema, handler, availability — consumed
by CLI, gateway, and web. No second list. No prompt text that names a tool the
registry does not export.

### 2.3 Native dispatch only

A typed tool name resolves to its handler or produces an explicit, typed
"tool unavailable" error naming the tool. **A typed tool name never reaches a
shell.** The silent `return []` at route.ts:94 becomes a logged, surfaced drop.

### 2.4 The kernel

**NOT STARTED — deliberately.** The only stage left untouched. See "Start here" item 4:
collapsing four parallel implementations blind, without a current HTML-001 number,
is the most dangerous change available in this repository.

One component owns: workflow state, tool dispatch, model scheduling, resource
leases, event emission, retry policy, cancellation, compaction persistence,
recovery, validation, and completion. Research, subagents, HIVE, coding, and
file operations become **callers** of it, not parallel implementations of it.

Today `web/src/lib/tools.ts` (495 LOC), `agent-tools.ts` (580), and
`toolloop.ts` (672) each hold part of this, and the CLI holds another. That is
the duplication to collapse.

### 2.5 Subagents are context isolation, not concurrency

**DONE 2026-07-25** (unit-tested; no HTML-001 number yet — see "Start here").

This box runs roughly one model at a time. The scheduler must reflect that
whatever the model believes. Do not remove the model's parallel-planning
instinct — bound the scheduler underneath it. Also fixes: research must not open
real Firefox windows; fetch is headless.

**Exit gate 2:** no typed tool name can reach a shell (test-enforced). One
registry is the only source of tool identity (import-boundary check). HTML-001
tool-failure count drops measurably against the Stage 1 baseline.

---

## Stage 3 — Work is durable

**Closes:** "file writing must be transactional and resumable", "exact-string
editing is too fragile".

**Why here:** the most expensive observed failure. A truncated response discards
accepted work and forces regeneration, which burns the context that caused the
truncation. Raising limits only moves the wall — 40,960 max_tokens and 65,536
ctx were already raised and the symptom persisted on lal.30.

### 3.1 Resumable transactional writer

**DONE 2026-07-25** (unit-tested; no HTML-001 number yet — see "Start here").

Begin a draft. Persist completed chunks as they land. Record the last
successfully written position. After an interruption, resume from exactly that
position. The previous valid file is untouched throughout. Only after the
completed draft validates is the original atomically replaced.

**No already-accepted generated content is ever regenerated.** That is the
acceptance criterion, and HTML-001 condition 8 measures it.

### 3.2 The residual truncation path — **diagnosed 2026-07-24**

The 8,000-char caps were removed and the token floors raised, yet Windows lal.30
still showed the symptom. There is indeed a second truncation path, and it has
nothing to do with token limits. The first HTML-001 baseline reproduced it twice
in ten runs **on Linux, on a 100-line page, at ~600 characters** — so it is
neither a Windows problem nor a big-file problem.

**The chain, proven end to end:**

1. `llama-server` stops mid-generation while the model is emitting the
   `write_file` arguments.
2. The host's gateway sees the upstream socket close:
   `⨯ Error: failed to pipe response … UND_ERR_SOCKET: other side closed`
   (`project-lal.service`, 17:57:23 and 18:01:49).
3. The CLI surfaces `[API Error: terminated]` and the turn ends with no file.
4. `out/llama-server.log` shows the generation stopping mid-decode, followed by
   a new `===== launch =====` banner **in the same second** as each failure.

**Ruled out:** no amdgpu ring reset, no segfault, no OOM kill in the kernel log
at either timestamp. The 10-minute idle reaper is far too slow to be involved.

**The defect, in `web/src/lib/lab.ts`:** `ensureServing()` guards a fast path on

```js
srv.model === model && requestedLoras === loadedLoras && srv.ctx >= ctx &&
srv.proc && srv.proc.exitCode === null && (await health())
```

and when *any* clause fails it calls `tryServe`, whose first two statements are
`srv.proc?.kill("SIGKILL")` and `pkill -9 -f "llama-server.*--port 8099"`.

**There is no in-flight guard anywhere on that path.** A restart decision made
for any reason executes an unconditional `kill -9` on a server that may be
streaming someone's half-written file. `health()` compounds it — a bare `fetch`
with no timeout whose `catch` turns *every* error into `false`, so one dropped
probe is enough to authorize the kill.

**Fixed and re-measured 2026-07-24.**

| | before | after |
|---|---|---|
| HTML-001 | 8/10 | **10/10** |
| llama-server relaunches mid-run | 2 | **0** |
| `UND_ERR_SOCKET` in the host log | 2 | **0** |

Read that with care. Ten clean runs against a 20% failure rate happens by chance
about one time in nine, so the pass count alone is suggestive, not conclusive.
The relaunch count is the stronger signal: the mechanism that destroyed those
files did not occur at all.

**Which clause failed is still unproven**, and the result narrows it in an
unexpected direction: the guard's refusal path **never fired** — nothing was
logged, because no restart was ever attempted. A drain-or-refuse guard can only
help once something decides to restart. So the change that mattered is most
likely the `health()` fix: previously one slow probe during heavy decode
*decided* the server was dead; now three consecutive failures are required, so
the decision is never reached. That is consistent with the timing (~24s into the
heaviest generation, when `/health` is slowest to answer) and with the absence
of any crash evidence.

~~Not proven, and worth confirming cheaply before trusting it: instrument the five
clauses and log which one trips.~~ **INSTRUMENTED 2026-07-25.** `ensureServing`
now evaluates each clause separately and logs the first one that trips
(`[lal-serve] restarting llama-server for "<model>": <reason>`), so the next
restart names its own cause instead of being attributed by reasoning. The guard
stays as defence in depth for the callers that *do* restart deliberately.

**The fix, independent of which clause it was:**

1. Reference-count in-flight generations; never kill a server with a live
   stream. Drain, or refuse the restart and surface why.
2. `health()` gets a timeout and needs consecutive failures before "dead".
   One probe must never authorize `kill -9`.
3. Separate "a different model was requested" from "the server looks unwell" —
   they deserve different responses.
4. `pkill -9 -f` matches on a port pattern and will kill any llama-server on
   that port, owned or not. Kill the tracked child, not a pattern.

**Recovery already exists and is unfinished.** LAL stashed both interrupted
writes rather than discarding them:

```
[lal] The interrupted "write_file" call had 579 chars already generated —
      saved to ~/.lal/tmp/<hash>/recovered-tool-calls/…-write_file.json
```

Both files are still on disk. This partly contradicts the original report that
partial code is deleted — it is preserved, but **nothing ever reads it back**.
Stage 3.1 is therefore less "build a resumable writer" than "finish the one that
is half-built": consume the stash, resume from it, and make condition 7
measurable.

### 3.3 Revision-aware editing

**DONE 2026-07-25** (unit-tested; no HTML-001 number yet — see "Start here").

Replace anchor-based literal-text matching with edits addressed by line range,
symbol, DOM node, or content hash. Every mutation verifies that unrelated
content was not removed, and rolls back automatically on a damaging patch.
Observed damage to prevent: deleted unrelated controls, duplicated CSS rules,
re-read loops hunting for a valid anchor.

**Exit gate 3:** a run killed mid-write resumes and completes with byte-identical
prior content. A drifted-whitespace edit succeeds. A patch that removes unrelated
content is rejected and rolled back. HTML-001 regeneration-waste approaches zero.

---

## Stage 4 — The loop knows when to stop

**Closes:** "research must be cancellable and adaptive", "failure circuit
breakers", "session turn limits".

### 4.1 Circuit breakers

After 2–3 identical failures for the same reason: classify and change strategy.
Never blind-retry. Required classifications:

| Failure | Response |
|---|---|
| Search provider broken | Stop, report infrastructure problem, offer to continue without research |
| HTTP 403 | Try an alternate source |
| Truncated write | Resume via the artifact writer (Stage 3) |
| Missing edit anchor | Reread, regenerate a revision-aware patch (Stage 3) |

A repeated failing action must never consume dozens of turns or hundreds of
thousands of tokens.

### 4.2 Evidence-based research completion

**DONE 2026-07-25** (unit-tested; no HTML-001 number yet — see "Start here").

Replace the fixed quota (currently six searches, four opened sources) with an
evidence test: were the questions answered, is there credible independent
evidence, does material uncertainty remain. **"Stop" from the user stops it
immediately** — the observed failure was the controller continuing to force
quota after an explicit stop.

### 4.3 Headless has no approval policy

Found 2026-07-24 while building the harness. `lal -p "write a file"` **cannot
write the file**: `write_file` requires an approval that non-interactive mode
has no mechanism to grant, so the agent reports "I cannot write the file because
`write_file` requires explicit permission which cannot be granted in
non-interactive mode" and stops. Every headless run is read-only unless the
caller happens to know to pass `--approval-mode=auto-edit`.

That default is defensible for a shell one-liner and wrong for an agent that is
supposed to build a website. Decide the policy explicitly: a headless run needs
a stated, discoverable approval posture, and refusing silently by default is not
it. At minimum the refusal message must name the flag that fixes it.

### 4.4 Session continuity

Visible CLI controls for: max session turns, unlimited-turn mode,
continue-latest vs. resume-a-specific-session, remaining turn budget, and an
explicit reason the session stopped (turns / context / cancellation / error).
Resuming preserves exact project state — no new chat, no redeploy.

**Exit gate 4:** a forced-failing provider stops within 3 attempts and reports.
A headless run states its approval posture rather than silently refusing.
"Stop" during research halts within one turn. A session resumed after a turn
limit continues with full state.

---

## Stage 5 — State survives compaction

**DONE 2026-07-25** (unit-tested; no HTML-001 number yet — see "Start here").

**Closes:** "context compaction must not erase working state".

Observed: after compaction the model still knew what it was doing, but the
file-editing subsystem had forgotten the file was already read. Conversation
history and runtime working state are different things and must be stored
differently.

Survives compaction, mandatory: current objective and task, decisions and
constraints, current plan revision, files already inspected, file revision
hashes, active artifact drafts, completed tool actions, validation results, and
failed actions that must not be repeated.

**Exit gate 5:** a forced compaction mid-HTML-001 does not cause a re-read, a
regeneration, or a repeat of a known-failed action.

---

## Stage 6 — The runtime decides completion

**DONE 2026-07-25** (unit-tested; no HTML-001 number yet — see "Start here").

**Closes:** "completion must be decided by acceptance tests, not model
confidence".

For website work, before any completion claim, LAL automatically: parses the
HTML/JS, opens the page, inspects console errors, confirms required DOM elements
exist, exercises important controls, captures visual evidence, repairs defects
found, and repeats validation until clean or a bounded give-up with an honest
report.

Generalized: **every workflow type declares acceptance criteria the runtime can
check.** A model's completion claim is a proposal that enters validation. It is
never the terminal state.

**Exit gate 6:** an intentionally broken generated site is caught, repaired, and
re-validated without user intervention — and if it cannot be repaired, LAL says
so plainly rather than claiming success.

---

## Stage 7 — It is our product

**Closes:** the "ON STRUCTURE WORK" cleanup. Deliberately after the functional
work, because deleting code you depend on is only safe once HTML-001 can prove
you did not break anything.

### 7.1 Apply the Stage 0.2 census

Delete the dead code and dead scripts. HTML-001 must still pass at Stage 6
levels after each deletion batch.

### 7.2 Remove the inherited surface

Cloud providers, enterprise channels, public docs site, desktop app, mobile MCP,
general SDKs, computer-use driver, broad locale machinery, upstream GitHub
automation, the `lab-agent` transitional path, upstream package names, badges,
release routes, and installation paths. Establish one dependency story and one
release path. The full build still references absent `packages/webui` and
`packages/web-shell` workspaces — resolve or remove.

### 7.3 Name ownership

Remove **Qwen** and **Gemini** from code, UI, and product identity — 2,402
`qwen`, 1,194 `google`, 397 `gemini` occurrences and 59 file paths today. The
product may still *run* Qwen models; that is fine and unrelated. Attribution
lives in `NOTICE-LAL.md`, not baked into the product's identity. Left as-is it
reads as a cheap clone.

### 7.4 CLI usability defects

- The chat region collapses to a ~40px strip between header and footer. Lean the
  header/footer, or fold the header into the scrolling chat area. Keep the logo.
- **Text cannot be selected or copied in the CLI.** Separate bug from the layout
  squeeze, and called out as crucial.
- The web UI's look does not match CLI branding — one paint pass, both surfaces.

**Exit gate 7:** a fresh clone builds and runs with documented steps. No
inherited brand name appears in code, UI, or release artifacts. HTML-001 still
passes at the Stage 6 rate. Text is selectable in the CLI.

---

## Stage 8 — Gated capability restoration

**Precondition, absolute: HTML-001 passes 9 of 10 consecutive unattended runs on
Windows.** Until that is recorded in `CHANGELOG.md`, this stage does not exist.

Each item below is restored only through its own gate — and only if it still
matters when we get here. Ordering within the stage is decided then, not now.

| Capability | Gate |
|---|---|
| HIVE workflows | Lifecycle, process ownership, evidence, approvals, recovery, and remote tool dispatch pass end to end |
| Benchmarking | Immutable suite/model/runtime/hardware identity, repeats, raw evidence, comparison without a fake universal score, retention |
| Training | Isolated reproducible environments, dataset lineage, bounded storage, checkpoints, evaluation, and one demonstrated useful promotion |
| Lens | Model availability, idle-stop, and cleanup proven with an installed model |
| Storage quotas | Registry-backed quotas, retention, cleanup tests, disk-pressure behavior across all mutable roots |
| Cross-device parity | One conversation identity and event stream for CLI, web, and phone |
| Authorization boundary | Destructive model/filesystem/Git/training/HIVE/download actions gated; network placement is not authorization |

### Research parked here, not lost (from 2026-07-24)

- **Unsloth for AMD.** Would replace the bespoke HQQ streaming trainer, chunked
  CE, CPU-embedding offload, and drop-at-1024 logic in
  `scripts/finetune_hqq.py`, all of which exist solely because bitsandbytes had
  no RDNA2 kernels. Risk: their support matrix lists RDNA2 as *gfx1030 only,
  Linux only*, and this box is **gfx1032** (RX 6650 XT). We already run training
  under `HSA_OVERRIDE_GFX_VERSION=10.3.0`, so it may work; the realistic failure
  is a silently miscompiled Triton kernel, not a crash. Test: throwaway venv
  (never `.venv` — their installer brings its own ROCm and PyTorch), 50-step
  QLoRA, compare the loss curve against a matched `finetune_hqq.py` run.
- **Heretic (automated abliteration).** Optimizes refusals *and* KL divergence
  from the original — the same two-axis shape as the open-inquiry protocol's
  never-average-these rule. Correct composition: abliterate the base, *then* LoRA
  the specialist on top, so training can re-teach the transform-don't-terminate
  boundary the ablation removes. Reverse order strips the trained behavior.
- **Outstanding now, not deferred:** `models/qwen35-9b-fable-heretic-q4.gguf` is
  already serving traffic via `web/.data/context-profiles.json` without ever
  passing the `open-inquiry` suite. Measuring an already-live model is not
  capability expansion. Do it during Stage 1 alongside the other baselines.

---

## Appendix A — decisions preserved from deleted documents

Carried forward so deletion loses nothing load-bearing.

**Architecture and product**
- Topology: tool execution stays on the client; model inference and
  authenticated egress come from the owner host. The last synchronized profile
  remains usable while disconnected.
- One durable profile per model — context, max output, GPU layers, temperature,
  top-p, top-k, repeat penalty, thinking — consumed by web chat, web code, the
  gateway, and running CLI clients.
- Requested, verified, active, and model-native context are four distinct
  values. A requested setting is never reported as active before the matching
  runtime is alive.
- Changing the saved default does not load it. `Load now` is separate. A running
  CLI follows a changed host default only while still following the previous
  one; an explicit `/model` is a session override.
- Every prompt that can influence LAL's behavior is owned and inspectable, not
  inherited invisibly.

**Verified hardware facts** *(do not re-derive)*
- Host GPU: AMD Navi 23 / **gfx1032**, RX 6650 XT, 8GB. `torch 2.5.1+rocm6.2`.
  Training and serving run under `HSA_OVERRIDE_GFX_VERSION=10.3.0`.
- Qwen 3.5 9B passed real 60,046- and 100,051-token prompts with correct needle
  recall using 256 batch/micro-batch, flash attention, quantized K/V cache, one
  sequence. A different 131K configuration reset the Vulkan device at 13,824
  tokens and is **not** verified.
- `~/Desktop/inbox` shares this GPU through Ollama on `:11434` and can orphan
  VRAM invisibly. Check real VRAM at
  `/sys/class/drm/card*/device/mem_info_vram_used`.
- Deploy via `scripts/rebuild-local-ai-lab.sh`, which restarts
  **project-lal.service**. `localailab.service` is a dead legacy unit name.
- Windows updates require a version bump plus `scripts/release-lal-cli.sh`; a
  `git push` alone ships nothing.

**Training lessons** *(binding if Stage 8 ever reaches training)*
- SFT without think blocks lobotomizes Qwen3 reasoning; token throughput is the
  tell. Format-match training data to the suite's think mode.
- Sub-3B models need short, distilled, complexity-matched traces — never
  verbatim long teacher rationales.
- Over-refusal and harmful compliance are separate axes and are never averaged.
- Novelty and feasibility are separate dimensions.
- Visible reasoning is a discipline mechanism, not introspection. It is never
  evidence of what a model actually computed.
- The blind-test model (snake) is never trained on and never entered into a
  suite. Battery suites Goodhart; keep at least one held-out reality check.
- victory6-8b remains the peak of the victory track. victory7 regressed 5/7
  suites; victory9 failed the ≥-everywhere promotion bar. Do not resume scaling
  the mix.

**Deliberately out of scope** — public launch, marketplace, community
automation, new training campaigns, large dataset commits, desktop and IDE
products, SDK maintenance, enterprise channels, computer-use automation, and any
cosmetic redesign that hides missing system truth.

---

## Appendix B — issue closure map

Every item from the 2026-07-23 Windows testing round and the structure-work
notes, mapped to where it is closed. Nothing is dropped.

| Source finding | Stage |
|---|---|
| 1. Tool routing broken / shell fallback | 2.1, 2.2, 2.3 |
| 2. Research cancellable and adaptive | 4.2 |
| 3. Failure circuit breakers | 4.1 |
| 4. Transactional resumable file writing | 3.1 |
| 5. Exact-string editing too fragile | 3.3 |
| 6. Compaction erases working state | 5 |
| 7. Session turn limits interrupt work | 4.4 |
| 8. Completion by acceptance test | 6 |
| 9. HTML-001 reliability benchmark | 1.1, 1.3 |
| 10. Strip vendor telemetry, keep local | 1.2 |
| 11. One authoritative execution kernel | 2.4 |
| 12. Reliability consolidation is priority | the whole plan |
| Raw 1. Research opens real Firefox windows | 2.5 |
| Raw 2. Subagents = context, not concurrency | 2.5 |
| Raw 3. Writes still truncated at 100K ctx | 3.2 |
| Raw 4. Basic agentic reliability | 6 |
| Raw 5a. Chat region squeezed to 40px | 7.4 |
| Raw 5b. Cannot select/copy text in CLI | 7.4 |
| Raw 5c. Web UI doesn't match CLI branding | 7.4 |
| Structure: understand the whole repo first | 0.1 |
| Structure: strip the qwen-code cadaver | 7.2 |
| Structure: remove Qwen/Gemini names | 7.3 |
| Structure: strip telemetry and cruft | 1.2, 7.1 |
| Structure: one-off plans and notes are a mess | 0.3 |

**Unresolved from the source material:** the polished "ADDITIONAL CRITICAL
FINDINGS" list pasted in-session does not appear verbatim in either saved copy
of `~/Downloads/LAL notes(1).txt`. Both versions were reconciled into the table
above, so no content is lost, but the discrepancy was never explained.
