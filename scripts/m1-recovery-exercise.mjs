#!/usr/bin/env node
/**
 * M1 step 4 / Gate 2 controlled interruption-recovery exercise.
 *
 * PLAN.md "M1 — prove a useful path and locate the bottleneck" step 4 requires
 * "a relevant controlled interruption/recovery in a disposable project", and
 * M1's Done criteria require "recovery works for the exercised case".
 * ACCEPTANCE.md Gate 2's crash-matrix row is:
 *   "Crash before intent, after intent, after effect but before result,
 *    after result" -> "Committed work is reused; pending effects are
 *    reconciled; non-idempotent effects are not blindly repeated."
 * and: "Test the ambiguous crash window with a persisted action counter,
 *    not only a mock dispatch count."
 *
 * WHAT THIS EXERCISES
 * The REAL, compiled workflow runtime:
 *   apps/cli/packages/core/dist/src/agents/runtime/workflow-journal.js
 *   apps/cli/packages/core/dist/src/agents/runtime/workflow-orchestrator.js
 * — imported directly, not ported. `WorkflowJournal`/`deriveAgentKey`/
 * `deriveArgsSeed` come from workflow-journal.js; `WorkflowOrchestrator`
 * (constructed with OUR stub dispatch function) drives a real, tiny,
 * sandboxed workflow script (`agent(prompt, opts)` x3, sequential) through
 * `apps/cli/packages/core/dist/src/agents/runtime/workflow-sandbox.js`. Every
 * journal write, every key derivation, and every "is this key safe to
 * re-dispatch" decision is the REAL orchestrator's `countedDispatch`
 * (workflow-orchestrator.ts), not a re-implementation of it.
 *
 * A real workflow durability fix recently landed there, adding a THIRD
 * journal entry type, `effect_complete`, written after a dispatch's side
 * effect resolves but before its `result` is committed (a fourth,
 * `effect_unknown`, covers the case this script's sibling
 * `m2-fault-recovery.mjs` exercises: a dispatch or journal-write FAILURE,
 * not a process crash). On resume, a key with `effect_complete` and no
 * matching `result` is an ambiguous crash window: the effect (arbitrary
 * write_file/shell activity) is known to have run at least once, so blindly
 * re-dispatching it would silently repeat a non-idempotent action. The
 * orchestrator refuses instead (`WorkflowAmbiguousEffectError`).
 *
 * This script exercises that exact contract end to end: it spawns a REAL
 * child Node process that runs the real orchestrator against a real on-disk
 * journal, pauses it at a chosen fault boundary (see HOW HOLDS WORK below),
 * and SIGKILLs it — a genuine OS-level interruption, not a simulated one. It
 * then spawns a second child process that loads the journal and resumes the
 * SAME real orchestrator against it, and grades the outcome against a
 * durable, on-disk, per-dispatch action counter (not an in-memory call
 * count, and not a self-report from the resumed process) so a duplicated
 * side effect cannot be missed.
 *
 * HOW HOLDS WORK (no product code is modified to get this)
 * `WorkflowOrchestrator`'s constructor takes a plain dispatch function, and
 * `run()` takes a plain `journal` object satisfying `{load(), append(entry)}`
 * — both are legitimate, supported customization seams (the same pattern the
 * product's own `workflow-durability.test.ts` uses, e.g.
 * `vi.spyOn(journal, 'append').mockImplementation(...)`). This script wraps
 * the REAL, imported `WorkflowJournal` instance in a thin local class,
 * `HoldingJournal`, that calls straight through to the real `append()` (so
 * every entry that lands is durably written by the real journal code) but
 * can pause EITHER immediately before or immediately after one specific,
 * occurrence-numbered entry — e.g. "before the 2nd `started` write" or
 * "after the 2nd `effect_complete` write" — before resolving. Pausing there
 * (print a `HOLD` marker line, then sleep) gives the controller a real
 * window to `SIGKILL` the child with the exact on-disk journal state the
 * scenario needs, entirely from the outside — no fork of the orchestrator's
 * own logic.
 *
 * BUILD-FRESHNESS GUARD (importing dist/ trades drift risk for staleness risk)
 * Importing compiled output only proves something about the CODE THAT WAS
 * COMPILED, not about the current `src/`. Before running anything — in the
 * controller AND independently in every spawned child process, matching this
 * script's existing isolation-guard philosophy of checking in every process
 * rather than trusting an earlier check — this script compares the mtime of
 * every non-test `.ts` file in `apps/cli/packages/core/src/agents/runtime/`
 * (the workflow runtime's own module directory) plus its one direct
 * cross-directory dependency (`utils/jsonl-utils.ts`, used for the journal's
 * durable JSONL I/O) against its compiled `dist/` counterpart. If ANY of
 * those compiled files is missing or older than its source, the script
 * REFUSES to run and reports `judgement: 'stale-build'` — distinctly from
 * `'pass'`/`'fail'`/`'blocked'` in both the human-readable lines and the
 * machine-readable summary (exit code 3, never 0 or 1) — because a stale
 * build can only tell you what an OLDER version of the product did, and
 * silently reporting that as either a pass or a product failure would
 * misrepresent which one it is. This check is intentionally bounded (a
 * directory scan, not a full transitive tsc dependency graph); the header
 * comment on `checkBuildFreshness` states that scope explicitly, and a
 * stale transitive dependency the scan doesn't cover (e.g. `config/config.ts`,
 * imported only as a TYPE by the orchestrator, so erased at compile time
 * anyway) is out of scope by design, not an oversight.
 *
 * OUTCOME VOCABULARY (reported per scenario and overall)
 *   recovered         - committed work was reused from cache, or an
 *                        unfinished intent was safely re-dispatched exactly
 *                        once. This is a PASS.
 *   refused-ambiguous - the ambiguous window was detected and the real
 *                        orchestrator refused to re-run the effect (its run()
 *                        promise rejects with `WorkflowAmbiguousEffectError`,
 *                        wrapped as `WorkflowExecutionError` once it crosses
 *                        the sandbox boundary — see `workflow-durability.test.ts`
 *                        for the same `.rejects.toThrow(/ambiguous/i)` idiom
 *                        this script follows). This is a PASS of the safety
 *                        contract, not a failure.
 *   blocked           - the harness itself could not complete the exercise
 *                        (spawn failure, isolation guard tripped, timed out
 *                        waiting for a hold marker, unexpected exit). Not a
 *                        verdict on the product.
 *   failed            - a genuine contract violation: a non-idempotent
 *                        effect ran more than once for one dispatch, an
 *                        ambiguous window was NOT refused, or committed
 *                        work was silently re-executed. Grading always
 *                        cross-checks the durable on-disk action counter AND
 *                        an independently-reloaded journal, never trusting
 *                        only the resumed child's own stdout self-report, so
 *                        a resumed child claiming success cannot turn a real
 *                        duplicate into a reported pass.
 *
 * RESIDUAL LIMITATION (irreducible, not exercised, documented per the task)
 * There is a strictly narrower window than the one this script tests: a
 * crash strictly BETWEEN the effect resolving and the `effect_complete`
 * append being ISSUED (or a crash during that append's own write/fsync). In
 * that window the journal contains only `started`, indistinguishable from
 * "effect never ran", so resume/reconciliation will re-dispatch and can
 * duplicate the effect. Nothing can close this from the journal side: the
 * process is dead, so no code — not even the `effect_unknown` fallback write
 * m2-fault-recovery.mjs exercises, which requires a live process to attempt
 * it — can run to record anything. This is a real, currently-uncovered gap
 * in the production contract (see workflow-orchestrator.ts's comment on
 * `WorkflowAmbiguousEffectError` and workflow-journal.ts's backward-
 * compatibility note), not a defect in this exercise. This script
 * deliberately does NOT attempt to fault-inject or claim to detect that
 * window — doing so would misrepresent an irreducible gap as a tested,
 * passing case.
 *
 * USAGE
 *   node scripts/m1-recovery-exercise.mjs            # run the real exercise
 *   node scripts/m1-recovery-exercise.mjs --keep      # keep temp workspaces
 *   node --test scripts/m1-recovery-exercise.test.mjs # self-tests (no GPU)
 *
 * Exit codes: 0 = all scenarios pass (recovered/refused-ambiguous as
 * expected); 1 = a genuine contract violation was observed; 2 = the harness
 * itself was blocked (no verdict reached); 3 = REFUSED — the compiled dist/
 * runtime is stale relative to its src, so no verdict can be trusted.
 */

import fs from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const WORKSPACE_PREFIX = 'lal-m1-recovery-';
const HOLD_TIMEOUT_MS = 8000;
const HOLD_SLEEP_MS = 8000;

const CORE_SRC = path.join(REPO_ROOT, 'apps/cli/packages/core/src');
const CORE_DIST = path.join(REPO_ROOT, 'apps/cli/packages/core/dist/src');
const RUNTIME_SRC_DIR = path.join(CORE_SRC, 'agents/runtime');
const RUNTIME_DIST_DIR = path.join(CORE_DIST, 'agents/runtime');
const JOURNAL_DIST_PATH = path.join(RUNTIME_DIST_DIR, 'workflow-journal.js');
const ORCHESTRATOR_DIST_PATH = path.join(RUNTIME_DIST_DIR, 'workflow-orchestrator.js');
/** Direct cross-directory dependency of workflow-journal.ts, for durable I/O. */
const EXTRA_WATCHED_SRC_FILES = [path.join(CORE_SRC, 'utils/jsonl-utils.ts')];

// ---------------------------------------------------------------------------
// BUILD-FRESHNESS GUARD
// ---------------------------------------------------------------------------

/**
 * Enumerate the source files this script's imports are answerable for:
 * every non-test `.ts` file directly in `runtimeSrcDir` (the workflow
 * runtime's own module directory — where workflow-journal.ts and
 * workflow-orchestrator.ts and their sibling runtime dependencies live),
 * plus `extraFiles` (explicit, named cross-directory dependencies). This is
 * a deliberately bounded scope: a directory scan plus a short explicit
 * list, not a full transitive tsc dependency graph (which would need a real
 * build-graph reader, not a temp-safe standalone script). See the file
 * header's "BUILD-FRESHNESS GUARD" section for what that leaves out.
 */
export function watchedSourceFiles(runtimeSrcDir, runtimeDistDir, extraFiles) {
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(runtimeSrcDir);
  } catch (err) {
    return { files: [], dirError: err instanceof Error ? err.message : String(err) };
  }
  for (const name of entries.sort()) {
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
    files.push({
      srcPath: path.join(runtimeSrcDir, name),
      distPath: path.join(runtimeDistDir, name.replace(/\.ts$/, '.js')),
    });
  }
  for (const extra of extraFiles) {
    const distPath = path.join(
      CORE_DIST,
      path.relative(CORE_SRC, extra).replace(/\.ts$/, '.js'),
    );
    files.push({ srcPath: extra, distPath });
  }
  return { files, dirError: null };
}

/**
 * Compare each watched source file's mtime against its compiled dist
 * counterpart. Returns `{fresh, staleFiles, ...}` — never throws for an
 * ordinary staleness finding (only for a script-authoring bug, surfaced as
 * a `dirError`/`source-file-missing` entry so it is visibly distinct from
 * "the build needs a rebuild").
 */
export function checkBuildFreshness(
  runtimeSrcDir = RUNTIME_SRC_DIR,
  runtimeDistDir = RUNTIME_DIST_DIR,
  extraFiles = EXTRA_WATCHED_SRC_FILES,
) {
  const { files, dirError } = watchedSourceFiles(runtimeSrcDir, runtimeDistDir, extraFiles);
  if (dirError) {
    return {
      fresh: false,
      checkedAt: new Date().toISOString(),
      scope: { runtimeSrcDir, runtimeDistDir, extraFiles },
      filesChecked: 0,
      staleFiles: [],
      dirError,
    };
  }
  const staleFiles = [];
  for (const { srcPath, distPath } of files) {
    let srcStat;
    try {
      srcStat = fs.statSync(srcPath);
    } catch (err) {
      staleFiles.push({
        srcPath,
        distPath,
        reason: 'source-file-missing',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    let distStat;
    try {
      distStat = fs.statSync(distPath);
    } catch {
      staleFiles.push({
        srcPath,
        distPath,
        reason: 'missing-compiled-artifact',
        srcMtimeMs: srcStat.mtimeMs,
      });
      continue;
    }
    if (srcStat.mtimeMs > distStat.mtimeMs) {
      staleFiles.push({
        srcPath,
        distPath,
        reason: 'source-newer-than-build',
        srcMtimeMs: srcStat.mtimeMs,
        distMtimeMs: distStat.mtimeMs,
        staleBySeconds: Math.round((srcStat.mtimeMs - distStat.mtimeMs) / 1000),
      });
    }
  }
  return {
    fresh: staleFiles.length === 0,
    checkedAt: new Date().toISOString(),
    scope: { runtimeSrcDir, runtimeDistDir, extraFiles },
    filesChecked: files.length,
    staleFiles,
  };
}

export class StaleBuildError extends Error {
  constructor(freshness) {
    super(
      `refusing to run: compiled apps/cli/packages/core/dist runtime is ` +
        `stale relative to its src (${freshness.staleFiles.length} file(s))`,
    );
    this.name = 'StaleBuildError';
    this.freshness = freshness;
  }
}

/**
 * Check freshness, then dynamically import the REAL compiled modules (so a
 * stale-build refusal never even loads the stale code). Called
 * independently by the controller and by every spawned child process.
 */
export async function loadRuntimeModules() {
  const freshness = checkBuildFreshness();
  if (!freshness.fresh) {
    throw new StaleBuildError(freshness);
  }
  const journalMod = await import(pathToFileURL(JOURNAL_DIST_PATH).href);
  // FINDING: importing workflow-orchestrator.js as a bare/standalone ESM
  // entry point (exactly what any honest external consumer of the compiled
  // module — this script included — must do) currently throws
  // `ReferenceError: Cannot access 'AGENT_WORKTREE_SLUG_PATTERN' before
  // initialization`. Root cause: a real circular import between
  // config/config.js -> services/worktreeCleanup.js ->
  // services/gitWorktreeService.js, reached via
  // workflow-orchestrator.js -> tools/agent/agent.js's chain. The cycle
  // exists in the source graph regardless of freshness; whether it
  // MANIFESTS depends entirely on which module is first to trigger it.
  // config.js reached FIRST resolves gitWorktreeService.js cleanly with no
  // re-entrant TDZ; empirically verified (not modifying any apps/cli file —
  // this only changes THIS script's own import order, warming an already-
  // real transitive dependency of workflow-orchestrator.js before touching
  // it directly). Report this prominently: it is real evidence of fragile
  // module coupling in the product, found only by actually importing the
  // real code instead of porting it.
  await import(pathToFileURL(path.join(CORE_DIST, 'config/config.js')).href);
  const orchestratorMod = await import(pathToFileURL(ORCHESTRATOR_DIST_PATH).href);
  return {
    freshness,
    WorkflowJournal: journalMod.WorkflowJournal,
    deriveAgentKey: journalMod.deriveAgentKey,
    deriveArgsSeed: journalMod.deriveArgsSeed,
    WorkflowOrchestrator: orchestratorMod.WorkflowOrchestrator,
    WorkflowAmbiguousEffectError: orchestratorMod.WorkflowAmbiguousEffectError,
  };
}

function printStaleBuildRefusal(freshness) {
  const summary = {
    schemaVersion: 2,
    exercise: 'm1-recovery-exercise',
    judgement: 'stale-build',
    overall: 'stale-build',
    buildFreshness: freshness,
    message:
      'REFUSING TO RUN: the compiled apps/cli/packages/core/dist runtime is ' +
      `older than its src for ${freshness.staleFiles.length} watched file(s). ` +
      'This is a BUILD STALENESS problem (dist/ has not been rebuilt since ' +
      'src changed) -- NOT a product contract violation and NOT a pass. ' +
      'Rebuild apps/cli/packages/core and re-run before trusting any result ' +
      'from this exercise.',
  };
  console.log(`M1_RECOVERY_EXERCISE_RESULT ${JSON.stringify(summary)}`);
  console.log('[STALE_BUILD] refusing to run -- compiled dist/ is older than its src:');
  for (const f of freshness.staleFiles) {
    if (f.reason === 'source-newer-than-build') {
      console.log(
        `  - ${path.relative(REPO_ROOT, f.srcPath)} is ${f.staleBySeconds}s newer than ` +
          `${path.relative(REPO_ROOT, f.distPath)}`,
      );
    } else if (f.reason === 'missing-compiled-artifact') {
      console.log(
        `  - ${path.relative(REPO_ROOT, f.distPath)} does not exist (no compiled artifact ` +
          `for ${path.relative(REPO_ROOT, f.srcPath)})`,
      );
    } else {
      console.log(`  - ${path.relative(REPO_ROOT, f.srcPath)}: ${f.reason} ${f.detail ?? ''}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Isolation guard (unchanged design: every write path must resolve under a
// disposable, self-prefixed mkdtemp directory; checked in every process).
// ---------------------------------------------------------------------------

export function assertDisposableWorkspace(dir) {
  const real = path.resolve(dir);
  const tmpRoot = path.resolve(os.tmpdir());
  const base = path.basename(real);
  if (real !== tmpRoot && !real.startsWith(tmpRoot + path.sep)) {
    throw new Error(`refusing to operate outside the OS temp directory: ${real}`);
  }
  if (!base.startsWith(WORKSPACE_PREFIX)) {
    throw new Error(
      `refusing to operate on a workspace without this exercise's own ` +
        `prefix (${WORKSPACE_PREFIX}...): ${real}`,
    );
  }
  if (real === REPO_ROOT || real.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`refusing to operate inside the repository: ${real}`);
  }
  const lalHome = path.join(os.homedir(), '.lal');
  if (real === lalHome || real.startsWith(lalHome + path.sep)) {
    throw new Error(`refusing to operate inside ~/.lal: ${real}`);
  }
  return real;
}

// ---------------------------------------------------------------------------
// The disposable workflow under exercise: three sequential `agent()` calls
// run through the REAL sandbox + REAL orchestrator, each dispatch backed by
// a durable, on-disk, per-dispatch effect counter (the "persisted action
// counter" ACCEPTANCE.md asks for, not a mock/in-memory dispatch count).
// ---------------------------------------------------------------------------

export const DISPATCHES = [
  {
    id: 'alpha',
    prompt: 'exercise-dispatch-alpha: pretend to write file A',
    opts: { model: 'stub-model-v1', agentType: 'exercise', label: 'alpha' },
  },
  {
    id: 'beta',
    prompt: 'exercise-dispatch-beta: pretend to write file B',
    opts: { model: 'stub-model-v1', agentType: 'exercise', label: 'beta' },
  },
  {
    id: 'gamma',
    prompt: 'exercise-dispatch-gamma: pretend to write file C',
    opts: { model: 'stub-model-v1', agentType: 'exercise', label: 'gamma' },
  },
];
export const ARGS_SEED = { exercise: 'm1-recovery', version: 1 };

const PROMPT_TO_ID = new Map(DISPATCHES.map((d) => [d.prompt, d.id]));

/** Builds the real sandboxed workflow script: N sequential `agent()` calls. */
export function buildSequentialScript(dispatches) {
  const lines = dispatches.map(
    (d, i) => `const r${i} = await agent(${JSON.stringify(d.prompt)}, ${JSON.stringify(d.opts)});`,
  );
  lines.push(`return [${dispatches.map((_, i) => `r${i}`).join(', ')}];`);
  return lines.join('\n');
}

/** The fake, non-idempotent "side effect": a durable, fsync'd counter bump. */
export async function runEffect(effectsFile, id) {
  let counts = {};
  try {
    counts = JSON.parse(await readFile(effectsFile, 'utf8'));
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  counts[id] = (counts[id] ?? 0) + 1;
  await fs.promises.writeFile(effectsFile, JSON.stringify(counts), { flush: true });
  return counts[id];
}

export async function readEffectCounts(effectsFile) {
  try {
    return JSON.parse(await readFile(effectsFile, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
}

/** Dispatch stub handed to the REAL `WorkflowOrchestrator`'s constructor. */
export function makeDispatch(effectsFile) {
  return async (prompt) => {
    const id = PROMPT_TO_ID.get(prompt) ?? prompt;
    await runEffect(effectsFile, id);
    return { ok: true, prompt };
  };
}

/**
 * Wraps a REAL `WorkflowJournal` instance. Every entry passes straight
 * through to the real `append()` (durably written by the real code); when
 * an entry's (type, 0-indexed occurrence) matches `holdType`/`holdIndex`,
 * `onHold(phase, type, index, key)` is awaited either immediately BEFORE
 * (`holdPhase === 'pre'`) or immediately AFTER (`holdPhase === 'post'`) that
 * real write. This is the only seam used to pause the real orchestrator
 * mid-run; no product code is modified.
 */
export function makeHoldingJournal(realJournal, holdPhase, holdType, holdIndex, onHold) {
  const counts = { started: 0, effect_complete: 0, result: 0, effect_unknown: 0 };
  return {
    load: () => realJournal.load(),
    async append(entry) {
      const occurrence = counts[entry.type] ?? 0;
      const matches = holdPhase !== 'none' && entry.type === holdType && occurrence === holdIndex;
      if (matches && holdPhase === 'pre') {
        await onHold('pre', entry.type, occurrence, entry.key);
      }
      await realJournal.append(entry);
      counts[entry.type] = occurrence + 1;
      if (matches && holdPhase === 'post') {
        await onHold('post', entry.type, occurrence, entry.key);
      }
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Child-process entry points
// ---------------------------------------------------------------------------

async function childRun(workspaceDir, holdPhase, holdType, holdIndex) {
  assertDisposableWorkspace(workspaceDir);
  let modules;
  try {
    modules = await loadRuntimeModules();
  } catch (err) {
    if (err instanceof StaleBuildError) {
      console.log(`CHILD_STALE_BUILD ${JSON.stringify(err.freshness)}`);
      process.exitCode = 3;
      return;
    }
    throw err;
  }
  const journalPath = path.join(workspaceDir, 'workflows', 'exercise-run', 'journal.jsonl');
  const effectsFile = path.join(workspaceDir, 'effects.json');
  const realJournal = new modules.WorkflowJournal(journalPath);
  const journal =
    holdPhase === 'none'
      ? realJournal
      : makeHoldingJournal(realJournal, holdPhase, holdType, holdIndex, async (phase, type, index, key) => {
          // Printed then a long sleep: the controller SIGKILLs us during this
          // window. If nobody kills us (shouldn't happen in real use, but
          // keeps this script from hanging forever if invoked oddly by hand)
          // we resume and finish, which just makes the exercise look like
          // the baseline scenario.
          console.log(`HOLD phase=${phase} type=${type} index=${index} key=${key} pid=${process.pid}`);
          await sleep(HOLD_SLEEP_MS);
        });
  const dispatch = makeDispatch(effectsFile);
  const orchestrator = new modules.WorkflowOrchestrator(dispatch);
  try {
    const outcome = await orchestrator.run({
      script: buildSequentialScript(DISPATCHES),
      args: ARGS_SEED,
      journal,
    });
    console.log(`CHILD_RUN_COMPLETE ${JSON.stringify({ result: outcome.result })}`);
  } catch (err) {
    console.log(
      `CHILD_RUN_ERROR ${JSON.stringify({ message: err instanceof Error ? err.message : String(err) })}`,
    );
  }
}

async function childResume(workspaceDir) {
  assertDisposableWorkspace(workspaceDir);
  let modules;
  try {
    modules = await loadRuntimeModules();
  } catch (err) {
    if (err instanceof StaleBuildError) {
      console.log(`CHILD_STALE_BUILD ${JSON.stringify(err.freshness)}`);
      process.exitCode = 3;
      return;
    }
    throw err;
  }
  const journalPath = path.join(workspaceDir, 'workflows', 'exercise-run', 'journal.jsonl');
  const effectsFile = path.join(workspaceDir, 'effects.json');
  const journal = new modules.WorkflowJournal(journalPath);
  const resumeReplay = await journal.load();
  const dispatch = makeDispatch(effectsFile);
  const orchestrator = new modules.WorkflowOrchestrator(dispatch);
  try {
    const outcome = await orchestrator.run({
      script: buildSequentialScript(DISPATCHES),
      args: ARGS_SEED,
      journal,
      resumeReplay,
    });
    console.log(`RESUME_RESULT ${JSON.stringify({ resolved: true, result: outcome.result })}`);
  } catch (err) {
    console.log(
      `RESUME_RESULT ${JSON.stringify({
        resolved: false,
        errorName: err instanceof Error ? err.name : undefined,
        errorMessage: err instanceof Error ? err.message : String(err),
      })}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Controller: spawns real child processes, performs a real SIGKILL at the
// chosen fault boundary, spawns the resume, and grades the result against
// the durable effect counters and an independently-reloaded real journal.
// ---------------------------------------------------------------------------

function runChildToCompletion(args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [__filename, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(Object.assign(new Error(`spawn failed: ${err.message}`), { blocked: true }));
      return;
    }
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (errOut += d.toString()));
    child.once('error', (err) => reject(Object.assign(err, { blocked: true })));
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ stdout: out, stderr: errOut });
      else
        reject(
          Object.assign(new Error(`child exited code=${code} signal=${signal}\n--- stderr ---\n${errOut}`), {
            blocked: true,
          }),
        );
    });
  });
}

function runChildAndKillAtHold(args, holdPhase, holdType, holdIndex) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [__filename, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(Object.assign(new Error(`spawn failed: ${err.message}`), { blocked: true }));
      return;
    }
    const rl = readline.createInterface({ input: child.stdout });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      reject(
        Object.assign(
          new Error(`timed out waiting for HOLD phase=${holdPhase} type=${holdType} index=${holdIndex}`),
          { blocked: true },
        ),
      );
    }, HOLD_TIMEOUT_MS);

    rl.on('line', (line) => {
      if (settled) return;
      if (
        line.startsWith('HOLD ') &&
        line.includes(`phase=${holdPhase}`) &&
        line.includes(`type=${holdType}`) &&
        line.includes(`index=${holdIndex}`)
      ) {
        settled = true;
        clearTimeout(timer);
        child.once('exit', (code, signal) => {
          resolve({ holdLine: line, exitCode: code, exitSignal: signal });
        });
        child.kill('SIGKILL');
      }
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(err, { blocked: true }));
    });
  });
}

async function runScenario(def, { keep, modules }) {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), WORKSPACE_PREFIX));
  try {
    assertDisposableWorkspace(workspaceDir);
    const effectsFile = path.join(workspaceDir, 'effects.json');
    const journalPath = path.join(workspaceDir, 'workflows', 'exercise-run', 'journal.jsonl');
    let killEvidence = null;

    if (def.holdPhase !== 'none') {
      const { holdLine, exitCode, exitSignal } = await runChildAndKillAtHold(
        [
          '--child-run',
          '--workspace',
          workspaceDir,
          '--hold-phase',
          def.holdPhase,
          '--hold-type',
          def.holdType,
          '--hold-index',
          String(def.holdIndex),
        ],
        def.holdPhase,
        def.holdType,
        def.holdIndex,
      );
      if (exitSignal !== 'SIGKILL') {
        return {
          name: def.name,
          category: 'blocked',
          pass: false,
          reason: `expected the child to die from SIGKILL, observed exitCode=${exitCode} exitSignal=${exitSignal}`,
        };
      }
      killEvidence = { holdLine, exitCode, exitSignal };
    } else {
      const { stdout } = await runChildToCompletion([
        '--child-run',
        '--workspace',
        workspaceDir,
        '--hold-phase',
        'none',
        '--hold-type',
        'none',
        '--hold-index',
        '-1',
      ]);
      if (!stdout.includes('CHILD_RUN_COMPLETE')) {
        return { name: def.name, category: 'blocked', pass: false, reason: `baseline run did not report completion: ${stdout}` };
      }
    }

    const preResumeReplay = await new modules.WorkflowJournal(journalPath).load();
    const countsBeforeResume = await readEffectCounts(effectsFile);

    const { stdout: resumeStdout } = await runChildToCompletion(['--child-resume', '--workspace', workspaceDir]);
    const resumeLine = resumeStdout.split('\n').find((l) => l.startsWith('RESUME_RESULT '));
    if (!resumeLine) {
      return { name: def.name, category: 'blocked', pass: false, reason: `no RESUME_RESULT line in resume output: ${resumeStdout}` };
    }
    const resumeSelfReport = JSON.parse(resumeLine.slice('RESUME_RESULT '.length));
    const countsAfterResume = await readEffectCounts(effectsFile);
    const finalReplay = await new modules.WorkflowJournal(journalPath).load();

    const verdict = def.check({
      resumeSelfReport,
      preResumeReplay,
      countsBeforeResume,
      countsAfterResume,
      finalReplay,
      keys: modules.keys,
    });
    return { name: def.name, killEvidence, resumeSelfReport, countsBeforeResume, countsAfterResume, ...verdict };
  } catch (err) {
    return {
      name: def.name,
      category: err && err.blocked ? 'blocked' : 'failed',
      pass: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!keep) {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

const SCENARIOS = [
  {
    name: 'before_intent',
    holdPhase: 'pre',
    holdType: 'started',
    holdIndex: 1,
    description: "kill before dispatch #2's `started` entry is written; nothing journaled for it yet.",
    check: ({ resumeSelfReport, preResumeReplay, countsBeforeResume, countsAfterResume, finalReplay, keys }) => {
      const problems = [];
      if (preResumeReplay.started.has(keys[1])) problems.push('pre-resume journal should have nothing at all for dispatch #2 (not even started)');
      if (countsBeforeResume.alpha !== 1) problems.push(`pre-resume alpha count should be 1, got ${countsBeforeResume.alpha}`);
      if (countsBeforeResume.beta) problems.push(`pre-resume beta should not have run yet, got ${countsBeforeResume.beta}`);
      if (!resumeSelfReport.resolved) problems.push(`resume should resolve (no ambiguous key), got rejection: ${resumeSelfReport.errorMessage}`);
      if (countsAfterResume.alpha !== 1) problems.push(`post-resume alpha count should stay 1 (cache hit), got ${countsAfterResume.alpha}`);
      if (countsAfterResume.beta !== 1) problems.push(`post-resume beta effect should run exactly once on resume, got ${countsAfterResume.beta}`);
      if (!finalReplay.results.has(keys[0]) || !finalReplay.results.has(keys[1])) problems.push('journal should hold committed results for both dispatch #1 and #2 after resume');
      return problems.length ? { category: 'failed', pass: false, reason: problems.join('; ') } : { category: 'recovered', pass: true };
    },
  },
  {
    name: 'after_intent',
    holdPhase: 'post',
    holdType: 'started',
    holdIndex: 1,
    description: "kill after dispatch #2's `started` entry is written but before its effect runs.",
    check: ({ resumeSelfReport, preResumeReplay, countsBeforeResume, countsAfterResume, finalReplay, keys }) => {
      const problems = [];
      const respawns = preResumeReplay.started.get(keys[1]);
      if (!respawns || respawns.length !== 1) problems.push('pre-resume journal should have exactly one `started` entry for dispatch #2 and nothing more');
      if (countsBeforeResume.alpha !== 1) problems.push(`pre-resume alpha count should be 1, got ${countsBeforeResume.alpha}`);
      if (countsBeforeResume.beta) problems.push(`pre-resume beta effect must NOT have run (started only), got ${countsBeforeResume.beta}`);
      if (!resumeSelfReport.resolved) problems.push(`resume should resolve (started-only is an ordinary miss), got rejection: ${resumeSelfReport.errorMessage}`);
      if (countsAfterResume.alpha !== 1) problems.push(`post-resume alpha count should stay 1, got ${countsAfterResume.alpha}`);
      if (countsAfterResume.beta !== 1) problems.push(`post-resume beta effect should run exactly once total, got ${countsAfterResume.beta}`);
      if (!finalReplay.results.has(keys[1])) problems.push('journal should hold a committed result for dispatch #2 after resume');
      return problems.length ? { category: 'failed', pass: false, reason: problems.join('; ') } : { category: 'recovered', pass: true };
    },
  },
  {
    name: 'ambiguous_after_effect_before_result',
    holdPhase: 'post',
    holdType: 'effect_complete',
    holdIndex: 1,
    description: "kill after dispatch #2's effect completed AND `effect_complete` is durably written, but before `result`. The fixed ambiguous window.",
    check: ({ resumeSelfReport, countsBeforeResume, countsAfterResume, finalReplay, keys }) => {
      const problems = [];
      if (countsBeforeResume.beta !== 1) problems.push(`pre-resume beta effect should have run exactly once (that's what makes this ambiguous), got ${countsBeforeResume.beta}`);
      if (countsBeforeResume.gamma) problems.push('dispatch #3 must never have been reached pre-crash');
      if (resumeSelfReport.resolved) problems.push('resume should REJECT (ambiguous key refused), but it resolved');
      if (resumeSelfReport.resolved === false && !/ambiguous|reconcil/i.test(resumeSelfReport.errorMessage ?? '')) {
        problems.push(`resume rejection should mention the ambiguity, got: ${resumeSelfReport.errorMessage}`);
      }
      if (countsAfterResume.alpha !== 1) problems.push(`alpha effect must stay at 1, got ${countsAfterResume.alpha}`);
      if (countsAfterResume.beta !== 1) problems.push(`dispatch #2's effect must NOT re-run: expected count 1, got ${countsAfterResume.beta}`);
      if (countsAfterResume.gamma) problems.push('dispatch #3 must never run: the ambiguous key aborts the whole resume before reaching it');
      if (!finalReplay.ambiguousEffects.has(keys[1])) problems.push('the real journal must still classify dispatch #2 as ambiguous after the failed resume attempt');
      if (finalReplay.results.has(keys[1])) problems.push('dispatch #2 must not have gained a result from the refused resume attempt');
      return problems.length ? { category: 'failed', pass: false, reason: problems.join('; ') } : { category: 'refused-ambiguous', pass: true };
    },
  },
  {
    name: 'after_result',
    holdPhase: 'post',
    holdType: 'result',
    holdIndex: 1,
    description: "kill after dispatch #2's `result` is committed; both dispatch #1 and #2 are fully durable, dispatch #3 is untouched.",
    check: ({ resumeSelfReport, countsBeforeResume, countsAfterResume, finalReplay, keys }) => {
      const problems = [];
      if (countsBeforeResume.alpha !== 1 || countsBeforeResume.beta !== 1) problems.push('pre-resume alpha and beta should both be fully committed (count 1 each)');
      if (countsBeforeResume.gamma) problems.push('dispatch #3 must never have been reached pre-crash');
      if (!resumeSelfReport.resolved) problems.push(`resume should resolve fully, got rejection: ${resumeSelfReport.errorMessage}`);
      if (countsAfterResume.alpha !== 1) problems.push(`alpha must stay at 1 (cache hit), got ${countsAfterResume.alpha}`);
      if (countsAfterResume.beta !== 1) problems.push(`beta must stay at 1 (cache hit, fully durable pre-crash), got ${countsAfterResume.beta}`);
      if (countsAfterResume.gamma !== 1) problems.push(`gamma should run exactly once on resume, got ${countsAfterResume.gamma}`);
      if (!finalReplay.results.has(keys[0]) || !finalReplay.results.has(keys[1]) || !finalReplay.results.has(keys[2])) {
        problems.push('journal should hold committed results for all three dispatches after resume');
      }
      return problems.length ? { category: 'failed', pass: false, reason: problems.join('; ') } : { category: 'recovered', pass: true };
    },
  },
  {
    name: 'baseline_no_interruption',
    holdPhase: 'none',
    holdType: 'none',
    holdIndex: -1,
    description: 'no crash: a full run to completion, then a resume, proving an already-complete run replays entirely from cache with zero live effects.',
    check: ({ resumeSelfReport, countsBeforeResume, countsAfterResume }) => {
      const problems = [];
      for (const id of ['alpha', 'beta', 'gamma']) {
        if (countsBeforeResume[id] !== 1) problems.push(`pre-resume ${id} should be 1 (full baseline run), got ${countsBeforeResume[id]}`);
      }
      if (!resumeSelfReport.resolved) problems.push(`resume should resolve entirely from cache, got rejection: ${resumeSelfReport.errorMessage}`);
      for (const id of ['alpha', 'beta', 'gamma']) {
        if (countsAfterResume[id] !== 1) problems.push(`post-resume ${id} should stay 1, got ${countsAfterResume[id]}`);
      }
      return problems.length ? { category: 'failed', pass: false, reason: problems.join('; ') } : { category: 'recovered', pass: true };
    },
  },
];

async function mainExercise({ keep }) {
  let modules;
  try {
    modules = await loadRuntimeModules();
  } catch (err) {
    if (err instanceof StaleBuildError) {
      printStaleBuildRefusal(err.freshness);
      process.exitCode = 3;
      return;
    }
    throw err;
  }

  // Compute the expected key chain once, using the REAL imported
  // deriveAgentKey/deriveArgsSeed (not a re-implementation).
  let prefixHash = modules.deriveArgsSeed(ARGS_SEED);
  const keys = [];
  for (const d of DISPATCHES) {
    const key = modules.deriveAgentKey(prefixHash, d.prompt, d.opts);
    keys.push(key);
    prefixHash = key;
  }
  modules.keys = keys;

  const results = [];
  for (const def of SCENARIOS) {
    const result = await runScenario(def, { keep, modules });
    results.push({ ...result, description: def.description });
  }

  const anyFailed = results.some((r) => r.category === 'failed');
  const anyBlocked = results.some((r) => r.category === 'blocked');
  const overall = anyFailed ? 'fail' : anyBlocked ? 'blocked' : 'pass';

  const summary = {
    schemaVersion: 2,
    exercise: 'm1-recovery-exercise',
    judgement: overall,
    imports: {
      journal: path.relative(REPO_ROOT, JOURNAL_DIST_PATH),
      orchestrator: path.relative(REPO_ROOT, ORCHESTRATOR_DIST_PATH),
    },
    buildFreshness: modules.freshness,
    isolation: {
      tmpRoot: os.tmpdir(),
      workspacePrefix: WORKSPACE_PREFIX,
      guaranteedByAssertDisposableWorkspace: true,
      cleanedUp: !keep,
    },
    residualLimitation:
      'A crash strictly between the effect resolving and the effect_complete ' +
      'append being issued (or during that append itself) is not exercised ' +
      'and is not detectable from the journal alone; see the file header.',
    scenarios: results.map((r) => ({
      name: r.name,
      description: r.description,
      category: r.category,
      pass: r.pass,
      reason: r.reason,
      killEvidence: r.killEvidence,
      resumeSelfReport: r.resumeSelfReport,
      countsBeforeResume: r.countsBeforeResume,
      countsAfterResume: r.countsAfterResume,
    })),
    overall,
  };

  console.log(`M1_RECOVERY_EXERCISE_RESULT ${JSON.stringify(summary)}`);

  for (const r of results) {
    const flag = r.category === 'failed' ? 'FAIL' : r.category === 'blocked' ? 'BLOCKED' : 'PASS';
    console.log(`[${flag}] ${r.name} -> ${r.category}${r.reason ? `: ${r.reason}` : ''}`);
  }

  if (overall === 'fail') process.exitCode = 1;
  else if (overall === 'blocked') process.exitCode = 2;
  else process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMain) {
  const args = parseArgv(process.argv.slice(2));
  if (args['child-run']) {
    childRun(args.workspace, args['hold-phase'], args['hold-type'], Number(args['hold-index'])).catch((err) => {
      console.error(err instanceof Error ? err.stack : String(err));
      process.exit(1);
    });
  } else if (args['child-resume']) {
    childResume(args.workspace).catch((err) => {
      console.error(err instanceof Error ? err.stack : String(err));
      process.exit(1);
    });
  } else {
    mainExercise({ keep: !!args.keep }).catch((err) => {
      console.error(err instanceof Error ? err.stack : String(err));
      process.exit(2);
    });
  }
}
