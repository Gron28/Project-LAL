#!/usr/bin/env node
/**
 * M2 / Gate 2 fault-recovery exercise — the FAULT half of the recovery
 * matrix. Sibling of `scripts/m1-recovery-exercise.mjs`, which exercises the
 * CRASH-WINDOW half (real SIGKILL at each journal boundary, via the real
 * orchestrator). This script exercises the row directly below it in
 * ACCEPTANCE.md's Gate 2 table:
 *
 *   "Restart, changed inputs, backend failure, full disk" ->
 *   "Recovery or explicit blocker/failure; journal failure prevents false
 *    completion; no stale approval/result reuse."
 *
 * None of these four scenarios require an OS-level crash: they are ordinary,
 * in-process failure conditions (a full disk, a dropped backend connection,
 * a resume with different arguments, an attempt to reuse a committed result
 * for a different dispatch). So, unlike m1, this script does NOT spawn
 * subprocesses or send signals — every scenario runs in-process against the
 * REAL, imported `WorkflowOrchestrator` + `WorkflowJournal`
 * (`apps/cli/packages/core/dist/src/agents/runtime/`), with faults injected
 * at the exact call boundary the fault targets (the journal's `append`, or
 * the dispatch function itself — both legitimate, supported customization
 * seams: `WorkflowOrchestrator`'s constructor takes a plain dispatch
 * function, and `run()` takes a plain `{load(), append(entry)}` journal
 * object).
 *
 * WHAT IS IMPORTED (nothing here is a re-implementation of the algorithm)
 * `deriveAgentKey` / `deriveArgsSeed` / `WorkflowJournal` come straight from
 * the compiled `workflow-journal.js`. The dispatch/persist ordering and the
 * journal-poison latch under test — the exact logic inside
 * `WorkflowOrchestrator.run`'s `countedDispatch` (workflow-orchestrator.ts)
 * — is exercised by actually calling the REAL, imported
 * `WorkflowOrchestrator`, constructed with a small dispatch stub and driving
 * a tiny real sandboxed workflow script (`agent(prompt, opts)` calls) through
 * the real `workflow-sandbox.js`. This sibling file's predecessor ported
 * that ordering logic by hand; that port is gone. See m1's file header for
 * why this needed a workaround for a real, discovered module-loading
 * fragility in the compiled build (see `loadRuntimeModules` below) — the
 * same workaround is applied here independently.
 *
 * ISOLATION GUARANTEE
 * Every filesystem write happens under a directory this script creates
 * itself with `fs.mkdtemp(os.tmpdir() + '/lal-m2-fault-recovery-')`, and
 * every write path is additionally checked by `assertDisposableWorkspace()`
 * before use (own prefix, independent of m1's copy): it must resolve under
 * the OS temp root, carry this script's own random prefix, and must NOT
 * resolve under the repo root or `~/.lal`. Unit-tested in
 * m2-fault-recovery.test.mjs. The workspace is `fs.rm(...,
 * {recursive:true, force:true})`-cleaned in a `finally` after every scenario
 * unless `--keep` is passed. Nothing under the real repo, `~/.lal`, or any
 * runtime database is ever opened, read, or written.
 *
 * HOW "FULL DISK" IS SIMULATED WITHOUT TOUCHING REAL DISK SPACE
 * `FaultInjectedJournal` wraps the REAL, imported `WorkflowJournal`. Its
 * `append()` checks a caller-supplied predicate BEFORE doing anything else;
 * when the predicate fires, it throws a manufactured `ENOSPC` error (same
 * `code`/`syscall` shape Node's fs layer would produce) and returns WITHOUT
 * ever calling the real journal's `append`. No real write is attempted, so
 * no real disk space is touched, consumed, or even probed — the fault is
 * injected purely at the call boundary, exactly as the hard constraint
 * requires. The machine's real free space is never read or written.
 *
 * BUILD-FRESHNESS GUARD
 * Same design as m1-recovery-exercise.mjs (independent copy): before running
 * anything, every non-test `.ts` file in
 * `apps/cli/packages/core/src/agents/runtime/` plus `utils/jsonl-utils.ts`
 * is compared against its compiled `dist/` counterpart. Any dist file older
 * than or missing relative to its source causes an outright REFUSAL
 * (`judgement: 'stale-build'`, exit code 3), distinct in both the
 * human-readable and machine-readable output from `'pass'`/`'fail'`/
 * `'blocked'`. This matters MORE here than in m1: this script's whole
 * purpose is to observe whether the two Gate 2 gaps below are open or
 * closed, and a stale build would silently report the OLD (pre-fix)
 * behavior under a banner that looks like a live product verdict — exactly
 * the class of error ACCEPTANCE.md cares most about.
 *
 * OUTCOME VOCABULARY (reported per scenario and overall)
 *   recovered - the system safely proceeded or retried and reached a
 *               correct, durable state (cache reused when inputs truly
 *               matched, or a clean redispatch after a clean failure). PASS.
 *   refused   - the system detected a dangerous or unprovable condition (an
 *               ambiguous effect, a would-be stale-result substitution) and
 *               explicitly declined to proceed, rather than guessing. PASS
 *               of the safety contract, not a failure.
 *   blocked   - the harness itself could not set up or complete the
 *               scenario (a bug in this script, not a verdict on the
 *               product).
 *   failed    - a genuine, durably-evidenced contract violation: a
 *               non-idempotent effect ran more than once for one dispatch,
 *               a committed result was reused for a different dispatch, or
 *               a journal failure still yielded a reported completion.
 *               Grading always reads the on-disk effect counter and an
 *               independently-reloaded on-disk journal directly — never a
 *               self-report from the dispatch stub — so a "recovered" claim
 *               cannot paper over a real duplicate.
 *
 * GATE 2 GAPS UNDER TEST (scenarios `journal_write_failure_after_effect` and
 * `backend_failure_dirty_after_effect`) — TWO POSSIBLE REGIMES, OBSERVED NOT
 * ASSUMED
 *
 * Before a fix, `effect_complete` was written strictly AFTER `this.dispatch`
 * resolves, so ANY failure between the effect actually running and that
 * append landing on disk — whether in the disk write itself (gap #1,
 * scenario `journal_write_failure_after_effect`) or in the dispatch call
 * reporting its own outcome (gap #2, scenario
 * `backend_failure_dirty_after_effect`) — left the on-disk journal for that
 * key `started`-only: structurally IDENTICAL to "the effect never ran" per
 * `buildReplay`, so a later resume safely-looking redispatches it,
 * duplicating the already-completed non-idempotent effect. Neither scenario
 * needs an OS-level crash: an everyday disk-full condition on one
 * `fs.appendFile` call, or an everyday dropped connection, is sufficient.
 *
 * The task brief that commissioned this rewrite states a fix landed
 * (`effect_unknown`, a fourth journal entry type, best-effort-written
 * whenever the orchestrator cannot prove an effect never ran). This script
 * does NOT assume that fix is present, compiled, and observable RIGHT NOW —
 * it detects and reports which of two regimes it actually sees on the
 * candidate build:
 *   'gap-open'   (pre-fix): `effect_unknown` is never written; the affected
 *                 key resumes as an ordinary miss and the effect duplicates.
 *                 Scenario category: 'failed' — a real, reproduced Gate 2
 *                 gap, EXPECTED and correct to report as a failure on a
 *                 build that doesn't have the fix.
 *   'gap-closed' (post-fix): `effect_unknown` is durably written; resume
 *                 refuses the key (ambiguous) and the effect never
 *                 duplicates. Scenario category: 'refused' — a PASS.
 * See "GATE 2 GAPS FOUND" in each scenario's own comment for the exact
 * mechanism. The build-freshness guard above is what keeps this
 * observation honest: without it, a stale dist/ could silently report
 * 'gap-open' under a banner that looks like a fresh verdict on the fix.
 *
 * WHAT THIS SCRIPT DID NOT AND COULD NOT EXERCISE
 * `workflow-stall.ts`'s stall watchdog (referenced from
 * workflow-orchestrator.ts around its dispatch-timeout handling) is the
 * production mechanism for a truly silent (no error, no data) hung/dropped
 * connection — it aborts and retries a dispatch that produces no progress
 * for `stallMs`. This script's dispatch stubs are plain functions, not real
 * subagents wired to that watchdog, so this script cannot exercise or vouch
 * for that mechanism; it only proves, via a bounded per-dispatch timeout on
 * its own stub calls, that a synthetic "hangs forever" stub does not hang
 * this exercise itself. Treat the stall watchdog as unverified by this
 * script, not as verified-passing.
 *
 * USAGE
 *   node scripts/m2-fault-recovery.mjs            # run the exercise
 *   node scripts/m2-fault-recovery.mjs --keep      # keep temp workspaces
 *   node --test scripts/m2-fault-recovery.test.mjs # self-tests (no GPU)
 *
 * Exit codes: 0 = every scenario is recovered/refused (no violation found,
 * i.e. all observed Gate 2 gaps are closed); 1 = at least one scenario is a
 * genuine contract violation (this is the CORRECT, expected exit code on a
 * build where either gap is still open — see "GATE 2 GAPS UNDER TEST"
 * above); 2 = the harness itself was blocked on some scenario (no verdict
 * reached for it); 3 = REFUSED — the compiled dist/ runtime is stale
 * relative to its src, so no verdict can be trusted.
 */

import fs from 'node:fs';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const WORKSPACE_PREFIX = 'lal-m2-fault-recovery-';
const DISPATCH_TIMEOUT_MS = 2000;

const CORE_SRC = path.join(REPO_ROOT, 'apps/cli/packages/core/src');
const CORE_DIST = path.join(REPO_ROOT, 'apps/cli/packages/core/dist/src');
const RUNTIME_SRC_DIR = path.join(CORE_SRC, 'agents/runtime');
const RUNTIME_DIST_DIR = path.join(CORE_DIST, 'agents/runtime');
const JOURNAL_DIST_PATH = path.join(RUNTIME_DIST_DIR, 'workflow-journal.js');
const ORCHESTRATOR_DIST_PATH = path.join(RUNTIME_DIST_DIR, 'workflow-orchestrator.js');
const EXTRA_WATCHED_SRC_FILES = [path.join(CORE_SRC, 'utils/jsonl-utils.ts')];

// ---------------------------------------------------------------------------
// BUILD-FRESHNESS GUARD (independent copy of m1-recovery-exercise.mjs's;
// see that file's header for the design rationale and declared scope).
// ---------------------------------------------------------------------------

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
    const distPath = path.join(CORE_DIST, path.relative(CORE_SRC, extra).replace(/\.ts$/, '.js'));
    files.push({ srcPath: extra, distPath });
  }
  return { files, dirError: null };
}

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
      staleFiles.push({ srcPath, distPath, reason: 'source-file-missing', detail: err instanceof Error ? err.message : String(err) });
      continue;
    }
    let distStat;
    try {
      distStat = fs.statSync(distPath);
    } catch {
      staleFiles.push({ srcPath, distPath, reason: 'missing-compiled-artifact', srcMtimeMs: srcStat.mtimeMs });
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

export async function loadRuntimeModules() {
  const freshness = checkBuildFreshness();
  if (!freshness.fresh) {
    throw new StaleBuildError(freshness);
  }
  const journalMod = await import(pathToFileURL(JOURNAL_DIST_PATH).href);
  // See m1-recovery-exercise.mjs's loadRuntimeModules for the full writeup:
  // importing workflow-orchestrator.js as a bare ESM entry currently trips a
  // real circular-import TDZ (config.js -> worktreeCleanup.js ->
  // gitWorktreeService.js) unless config.js is warmed first. Independently
  // verified here too (not an apps/cli edit -- only this script's own import
  // order).
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
    exercise: 'm2-fault-recovery-exercise',
    judgement: 'stale-build',
    overall: 'stale-build',
    buildFreshness: freshness,
    message:
      'REFUSING TO RUN: the compiled apps/cli/packages/core/dist runtime is ' +
      `older than its src for ${freshness.staleFiles.length} watched file(s). ` +
      'This is a BUILD STALENESS problem (dist/ has not been rebuilt since ' +
      'src changed) -- NOT a product contract violation and NOT a pass. In ' +
      'particular, this build cannot be trusted to say whether the Gate 2 ' +
      'gaps below are open or closed. Rebuild apps/cli/packages/core and ' +
      're-run before trusting any result from this exercise.',
  };
  console.log(`M2_FAULT_RECOVERY_RESULT ${JSON.stringify(summary)}`);
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
// Isolation guard — independent copy, own workspace prefix.
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
// Durable, on-disk, per-dispatch action counter (keyed by prompt text,
// scoped to one scenario's own effects file -- the "persisted action
// counter" ACCEPTANCE.md asks for, not a mock/in-memory dispatch count).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fault injection wrappers / dispatch stub factories
// ---------------------------------------------------------------------------

/**
 * Wraps the REAL `WorkflowJournal`. `shouldFail(entry, callIndex)` decides,
 * BEFORE any real I/O, whether this append manufactures an ENOSPC error
 * instead of writing. When it fires, the real journal's `append` is never
 * called -- no real write is attempted, so no real disk space is touched.
 */
export function makeFaultInjectedJournal(realJournal, shouldFail) {
  let callIndex = 0;
  return {
    load: () => realJournal.load(),
    async append(entry) {
      const idx = callIndex++;
      if (shouldFail(entry, idx)) {
        const err = new Error('ENOSPC: no space left on device, write (simulated -- no real fs call was made)');
        err.code = 'ENOSPC';
        err.syscall = 'write';
        throw err;
      }
      return realJournal.append(entry);
    },
  };
}

/** Always succeeds: runs the durable effect (keyed by prompt) and returns. */
export function makeCleanDispatch(effectsFile) {
  return async (prompt) => ({ ok: true, count: await runEffect(effectsFile, prompt) });
}

/** Fails BEFORE any observable effect -- a clean backend/connection drop. */
export function makeCleanBackendFailure() {
  return async () => {
    const err = new Error('ECONNRESET: connection dropped before dispatch');
    err.code = 'ECONNRESET';
    throw err;
  };
}

/** Runs the effect FIRST, THEN fails -- a dirty backend/connection drop. */
export function makeDirtyBackendFailure(effectsFile) {
  return async (prompt) => {
    await runEffect(effectsFile, prompt);
    const err = new Error('ECONNRESET: connection dropped after the effect ran, before the result could be reported');
    err.code = 'ECONNRESET';
    throw err;
  };
}

/** Bounds a dispatch stub call so a synthetic "hangs forever" stub cannot hang this harness. */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label ?? 'operation'} did not settle within ${ms}ms (silent stall)`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function boundedDispatch(fn) {
  return (prompt, opts) => withTimeout(fn(prompt, opts), DISPATCH_TIMEOUT_MS, `dispatch(${prompt})`);
}

// ---------------------------------------------------------------------------
// Sandboxed script builders
// ---------------------------------------------------------------------------

/** N sequential `agent()` calls; a rejection propagates and aborts the run. */
export function buildSequentialScript(dispatches) {
  const lines = dispatches.map(
    (d, i) => `const r${i} = await agent(${JSON.stringify(d.prompt)}, ${JSON.stringify(d.opts)});`,
  );
  lines.push(`return [${dispatches.map((_, i) => `r${i}`).join(', ')}];`);
  return lines.join('\n');
}

/**
 * N sequential `agent()` calls, each independently try/caught
 * (errors-as-data) so the SCRIPT keeps going past an individual dispatch
 * failure -- used to prove the journal-poison latch blocks a LATER,
 * independent dispatch too, not just the one that failed.
 */
export function buildTryCatchScript(dispatches) {
  const lines = ['const outcomes = [];'];
  for (const d of dispatches) {
    lines.push(
      `try { outcomes.push(await agent(${JSON.stringify(d.prompt)}, ${JSON.stringify(d.opts)})); } ` +
        `catch (e) { outcomes.push({ __error: true, message: String((e && e.message) || e) }); }`,
    );
  }
  lines.push('return outcomes;');
  return lines.join('\n');
}

async function runOrchestrator(modules, { dispatch, journal, args, resumeReplay, script }) {
  const orchestrator = new modules.WorkflowOrchestrator(boundedDispatch(dispatch));
  try {
    const outcome = await orchestrator.run({ script, args, journal, resumeReplay });
    return { resolved: true, result: outcome.result };
  } catch (err) {
    return {
      resolved: false,
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

async function keyFor(modules, argsSeed, dispatches, index) {
  let prefixHash = modules.deriveArgsSeed(argsSeed);
  let key;
  for (let i = 0; i <= index; i++) {
    key = modules.deriveAgentKey(prefixHash, dispatches[i].prompt, dispatches[i].opts);
    prefixHash = key;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const OPTS = { model: 'stub-model-v1', agentType: 'exercise' };
const DISPATCHES_ABC = [
  { prompt: 'fault-dispatch-alpha: write file A', opts: OPTS },
  { prompt: 'fault-dispatch-beta: write file B', opts: OPTS },
  { prompt: 'fault-dispatch-gamma: write file C', opts: OPTS },
];

async function scenario_journalWriteFailureBeforeEffect(root, modules) {
  const workDir = path.join(root, 'journal-write-before-effect');
  await mkdir(workDir, { recursive: true });
  const effectsFile = path.join(workDir, 'effects.json');
  const journalPath = path.join(workDir, 'journal.jsonl');
  const realJournal = new modules.WorkflowJournal(journalPath);
  // Fail on the FIRST append call: dispatch A's `started` entry. Both A and
  // B are wrapped in try/catch by the SCRIPT (errors-as-data) so B is still
  // attempted -- it must be blocked by the journal-poison latch WITHOUT
  // even attempting its own journal write or effect.
  const journal = makeFaultInjectedJournal(realJournal, (_entry, idx) => idx === 0);
  const dispatches = DISPATCHES_ABC.slice(0, 2);
  const argsSeed = { exercise: 'm2-fault-recovery', case: 'journal-before-effect' };
  const run = await runOrchestrator(modules, {
    dispatch: makeCleanDispatch(effectsFile),
    journal,
    args: argsSeed,
    script: buildTryCatchScript(dispatches),
  });
  const counts = await readEffectCounts(effectsFile);
  const onDisk = await realJournal.load();

  const problems = [];
  // Even though the script itself caught both per-dispatch errors and
  // returned normally, the journal-poison latch means the run must STILL
  // reject overall (ACCEPTANCE.md: "journal failure prevents false
  // completion") -- this is the key assertion this scenario exists for.
  if (run.resolved) problems.push('the run must reject overall once the journal has failed, even though the script itself caught every per-dispatch error');
  if (run.resolved === false && !/journal.*ENOSPC/i.test(run.errorMessage ?? '')) {
    problems.push(`rejection should mention the journal ENOSPC failure, got: ${run.errorMessage}`);
  }
  if (Object.keys(counts).length !== 0) problems.push(`no effect should have run at all; effects.json = ${JSON.stringify(counts)}`);
  if (onDisk.results.size !== 0) problems.push('journal on disk must not contain any result (no false completion)');

  return {
    name: 'journal_write_failure_before_effect',
    description:
      "ENOSPC on the very first journal append (dispatch A's `started`). The " +
      'effect must never run, dispatch B must be blocked by the run-wide ' +
      'journal-poison latch, and the overall run must reject even though the ' +
      "script's own try/catch handled both dispatches individually.",
    category: problems.length ? 'failed' : 'refused',
    pass: problems.length === 0,
    reason: problems.length ? problems.join('; ') : undefined,
    evidence: { run, counts },
  };
}

async function scenario_journalWriteFailureAfterEffect(root, modules) {
  const workDir = path.join(root, 'journal-write-after-effect');
  await mkdir(workDir, { recursive: true });
  const effectsFile = path.join(workDir, 'effects.json');
  const journalPath = path.join(workDir, 'journal.jsonl');
  const realJournal = new modules.WorkflowJournal(journalPath);
  // Fail on the SECOND append call: dispatch A's `effect_complete` entry,
  // i.e. AFTER this.dispatch (the effect) has already resolved. This is a
  // TRANSIENT fault -- only this one call fails; a following append (the
  // best-effort `effect_unknown` fallback, if the candidate build has it)
  // is NOT blocked.
  const faultyJournal = makeFaultInjectedJournal(realJournal, (_entry, idx) => idx === 1);
  const dispatches = DISPATCHES_ABC.slice(0, 1);
  const argsSeed = { exercise: 'm2-fault-recovery', case: 'journal-after-effect' };
  const first = await runOrchestrator(modules, {
    dispatch: makeCleanDispatch(effectsFile),
    journal: faultyJournal,
    args: argsSeed,
    script: buildSequentialScript(dispatches),
  });
  const key0 = await keyFor(modules, argsSeed, dispatches, 0);
  const countsAfterFirst = await readEffectCounts(effectsFile);
  const replayAfterFirst = await realJournal.load();

  const setupProblems = [];
  if (first.resolved) setupProblems.push('the first attempt must reject (the effect_complete append failed)');
  if ((countsAfterFirst[dispatches[0].prompt] ?? 0) !== 1) {
    setupProblems.push(`the effect must have run once already (this.dispatch resolved before the journal write failed), got ${countsAfterFirst[dispatches[0].prompt]}`);
  }
  if (replayAfterFirst.results.has(key0)) setupProblems.push('no result should be committed after the write failure');

  const regime = replayAfterFirst.ambiguousEffects.has(key0) ? 'gap-closed' : 'gap-open';

  // Resume: a fresh, WORKING journal handle over the SAME on-disk file, and
  // a WORKING dispatch (disk has space again).
  const healedJournal = new modules.WorkflowJournal(journalPath);
  const replay = await healedJournal.load();
  const resume = await runOrchestrator(modules, {
    dispatch: makeCleanDispatch(effectsFile),
    journal: healedJournal,
    args: argsSeed,
    resumeReplay: replay,
    script: buildSequentialScript(dispatches),
  });
  const countsAfterResume = await readEffectCounts(effectsFile);
  const finalCount = countsAfterResume[dispatches[0].prompt] ?? 0;

  if (setupProblems.length) {
    return {
      name: 'journal_write_failure_after_effect',
      description:
        "ENOSPC on dispatch A's `effect_complete` append, AFTER its effect " +
        'already ran successfully (transient: only this one write fails).',
      category: 'blocked',
      pass: false,
      reason: `harness failed to set up the intended fault condition: ${setupProblems.join('; ')}`,
      evidence: { first, resume, countsAfterFirst, countsAfterResume },
    };
  }

  const violation = finalCount === 2;
  const description =
    "ENOSPC on dispatch A's `effect_complete` append, AFTER its effect already " +
    'ran successfully. No crash anywhere. GATE 2 GAP #1 ' +
    '(workflow-orchestrator.ts, effect_complete write failure): observed regime ' +
    `= ${regime}. ` +
    (regime === 'gap-closed'
      ? 'The best-effort `effect_unknown` fallback write landed, resume correctly refused, and the effect did not duplicate.'
      : 'No fallback write landed; the on-disk journal is started-only (identical to "never ran"), so resume redispatched and duplicated the effect.');

  return {
    name: 'journal_write_failure_after_effect',
    description,
    category: violation ? 'failed' : regime === 'gap-closed' ? 'refused' : 'blocked',
    pass: !violation && regime === 'gap-closed',
    reason: violation
      ? `duplicate non-idempotent effect confirmed via durable counter: key ${key0} ran ${finalCount} times (expected 1)`
      : regime === 'gap-open'
        ? 'regime is gap-open but the effect did not duplicate on this resume -- re-run to confirm, this combination is unexpected'
        : undefined,
    evidence: { regime, first, resume, countsAfterFirst, countsAfterResume, ambiguousReason: replayAfterFirst.ambiguousEffectReasons?.get(key0) },
  };
}

async function scenario_backendFailureCleanBeforeEffect(root, modules) {
  const workDir = path.join(root, 'backend-clean');
  await mkdir(workDir, { recursive: true });
  const effectsFile = path.join(workDir, 'effects.json');
  const journalPath = path.join(workDir, 'journal.jsonl');
  const journal = new modules.WorkflowJournal(journalPath);
  const dispatches = DISPATCHES_ABC.slice(0, 1);
  const argsSeed = { exercise: 'm2-fault-recovery', case: 'backend-clean' };

  const first = await runOrchestrator(modules, {
    dispatch: makeCleanBackendFailure(),
    journal,
    args: argsSeed,
    script: buildSequentialScript(dispatches),
  });
  const key0 = await keyFor(modules, argsSeed, dispatches, 0);
  const countsAfterFirst = await readEffectCounts(effectsFile);
  const replayAfterFirst = await journal.load();

  const problems = [];
  if (first.resolved) problems.push('the first attempt must reject (clean backend failure)');
  if ((countsAfterFirst[dispatches[0].prompt] ?? 0) !== 0) problems.push(`no effect should have run yet, got ${countsAfterFirst[dispatches[0].prompt]}`);
  if (replayAfterFirst.results.has(key0)) problems.push('no result should be committed for a failed dispatch');

  const regime = replayAfterFirst.ambiguousEffects.has(key0) ? 'conservative-refusal' : 'permissive-miss';

  const replay = await journal.load();
  const resume = await runOrchestrator(modules, {
    dispatch: makeCleanDispatch(effectsFile),
    journal,
    args: argsSeed,
    resumeReplay: replay,
    script: buildSequentialScript(dispatches),
  });
  const countsAfterResume = await readEffectCounts(effectsFile);
  const finalCount = countsAfterResume[dispatches[0].prompt] ?? 0;

  if (finalCount > 1) problems.push(`the effect never genuinely ran before resume, so ANY count above 1 is a real duplicate; got ${finalCount}`);
  if (regime === 'conservative-refusal' && (resume.resolved || finalCount !== 0)) {
    problems.push('conservative regime observed on the first attempt but resume did not refuse (or ran the effect) -- inconsistent');
  }
  if (regime === 'permissive-miss' && (!resume.resolved || finalCount !== 1)) {
    problems.push(`permissive regime observed on the first attempt but resume did not cleanly redispatch exactly once, got resolved=${resume.resolved} count=${finalCount}`);
  }

  return {
    name: 'backend_failure_clean_before_effect',
    description:
      'Backend/connection failure BEFORE any effect ran (a clean rejection -- ' +
      'the dispatch never touched the workspace). Observed regime = ' +
      `${regime}. Both are safe (no duplicate is possible either way): ` +
      "'conservative-refusal' means the orchestrator cannot locally tell a " +
      "clean failure from a dirty one and fails closed anyway (a legitimate, " +
      "if stricter-than-strictly-necessary, tightening from the fix); " +
      "'permissive-miss' is the pre-fix behavior (ordinary miss, safe here " +
      'only because nothing ever ran to duplicate).',
    category: problems.length ? 'failed' : regime === 'conservative-refusal' ? 'refused' : 'recovered',
    pass: problems.length === 0,
    reason: problems.length ? problems.join('; ') : undefined,
    evidence: { regime, first, resume, countsAfterFirst, countsAfterResume },
  };
}

async function scenario_backendFailureDirtyAfterEffect(root, modules) {
  const workDir = path.join(root, 'backend-dirty');
  await mkdir(workDir, { recursive: true });
  const effectsFile = path.join(workDir, 'effects.json');
  const journalPath = path.join(workDir, 'journal.jsonl');
  const journal = new modules.WorkflowJournal(journalPath);
  const dispatches = DISPATCHES_ABC.slice(0, 1);
  const argsSeed = { exercise: 'm2-fault-recovery', case: 'backend-dirty' };

  const first = await runOrchestrator(modules, {
    dispatch: makeDirtyBackendFailure(effectsFile),
    journal,
    args: argsSeed,
    script: buildSequentialScript(dispatches),
  });
  const key0 = await keyFor(modules, argsSeed, dispatches, 0);
  const countsAfterFirst = await readEffectCounts(effectsFile);
  const replayAfterFirst = await journal.load();

  const setupProblems = [];
  if (first.resolved) setupProblems.push('the first attempt must reject (dirty backend failure)');
  if ((countsAfterFirst[dispatches[0].prompt] ?? 0) !== 1) {
    setupProblems.push(`the effect already ran once inside the failed dispatch, got ${countsAfterFirst[dispatches[0].prompt]}`);
  }
  if (replayAfterFirst.results.has(key0)) setupProblems.push('no result should be committed for a failed dispatch');

  const regime = replayAfterFirst.ambiguousEffects.has(key0) ? 'gap-closed' : 'gap-open';

  const replay = await journal.load();
  const resume = await runOrchestrator(modules, {
    dispatch: makeCleanDispatch(effectsFile),
    journal,
    args: argsSeed,
    resumeReplay: replay,
    script: buildSequentialScript(dispatches),
  });
  const countsAfterResume = await readEffectCounts(effectsFile);
  const finalCount = countsAfterResume[dispatches[0].prompt] ?? 0;

  if (setupProblems.length) {
    return {
      name: 'backend_failure_dirty_after_effect',
      description:
        'Backend/connection failure AFTER the effect already ran but before ' +
        'the dispatch promise resolved.',
      category: 'blocked',
      pass: false,
      reason: `harness failed to set up the intended fault condition: ${setupProblems.join('; ')}`,
      evidence: { first, resume, countsAfterFirst, countsAfterResume },
    };
  }

  const violation = finalCount === 2;
  const description =
    'Backend/connection failure AFTER the effect already ran but before the ' +
    'dispatch promise resolved (models the 2026-09-21 dropped-connection ' +
    `incident). GATE 2 GAP #2 (workflow-orchestrator.ts, dispatch rejection ` +
    `after a live effect): observed regime = ${regime}. ` +
    (regime === 'gap-closed'
      ? 'The best-effort `effect_unknown` fallback write landed, resume correctly refused, and the effect did not duplicate.'
      : 'No fallback write landed; no journal entry exists between `started` and `effect_complete`, so this collapsed to "never ran" and resume duplicated the effect.');

  return {
    name: 'backend_failure_dirty_after_effect',
    description,
    category: violation ? 'failed' : regime === 'gap-closed' ? 'refused' : 'blocked',
    pass: !violation && regime === 'gap-closed',
    reason: violation
      ? `duplicate non-idempotent effect confirmed via durable counter: key ${key0} ran ${finalCount} times (expected 1)`
      : regime === 'gap-open'
        ? 'regime is gap-open but the effect did not duplicate on this resume -- re-run to confirm, this combination is unexpected'
        : undefined,
    evidence: { regime, first, resume, countsAfterFirst, countsAfterResume, ambiguousReason: replayAfterFirst.ambiguousEffectReasons?.get(key0) },
  };
}

async function scenario_restartWithChangedInputs(root, modules) {
  const workDir = path.join(root, 'changed-inputs');
  await mkdir(workDir, { recursive: true });
  const effectsFile = path.join(workDir, 'effects.json');
  const journalPath = path.join(workDir, 'journal.jsonl');
  const journal = new modules.WorkflowJournal(journalPath);
  const argsA = { exercise: 'm2-fault-recovery', run: 'A' };
  const argsB = { exercise: 'm2-fault-recovery', run: 'B' };

  const runA = await runOrchestrator(modules, {
    dispatch: makeCleanDispatch(effectsFile),
    journal,
    args: argsA,
    script: buildSequentialScript(DISPATCHES_ABC),
  });
  const countsAfterA = await readEffectCounts(effectsFile);
  const keysA = await Promise.all(DISPATCHES_ABC.map((_, i) => keyFor(modules, argsA, DISPATCHES_ABC, i)));

  const problems = [];
  if (!runA.resolved) problems.push(`run A (fresh) should resolve, got: ${runA.errorMessage}`);
  for (const p of DISPATCHES_ABC) {
    if ((countsAfterA[p.prompt] ?? 0) !== 1) problems.push(`run A dispatch ${p.prompt} should have count 1`);
  }

  // Control: resume with the SAME args must reuse the cache entirely.
  const replaySame = await journal.load();
  const resumeSame = await runOrchestrator(modules, {
    dispatch: makeCleanDispatch(effectsFile),
    journal,
    args: argsA,
    resumeReplay: replaySame,
    script: buildSequentialScript(DISPATCHES_ABC),
  });
  const countsAfterSame = await readEffectCounts(effectsFile);
  if (!resumeSame.resolved) problems.push(`resume with identical args should resolve, got: ${resumeSame.errorMessage}`);
  if (JSON.stringify(countsAfterSame) !== JSON.stringify(countsAfterA)) {
    problems.push('resume with identical args must not run any effect again');
  }

  // The actual scenario: resume with CHANGED args against run A's journal.
  const replayForChanged = await journal.load();
  const resumeChanged = await runOrchestrator(modules, {
    dispatch: makeCleanDispatch(effectsFile),
    journal,
    args: argsB,
    resumeReplay: replayForChanged,
    script: buildSequentialScript(DISPATCHES_ABC),
  });
  const countsAfterChanged = await readEffectCounts(effectsFile);
  const keysB = await Promise.all(DISPATCHES_ABC.map((_, i) => keyFor(modules, argsB, DISPATCHES_ABC, i)));

  if (!resumeChanged.resolved) problems.push(`resume with CHANGED args must still resolve (every dispatch misses and redispatches live), got: ${resumeChanged.errorMessage}`);
  for (let i = 0; i < keysB.length; i++) {
    if (keysA[i] === keysB[i]) problems.push(`changed-args key at index ${i} collided with run A's key -- key derivation did not distinguish changed inputs`);
  }
  // Same prompt text is reused across argsA/argsB, so each dispatch's
  // durable counter (keyed by prompt) must legitimately reach exactly 2:
  // once under A's keys, once under B's -- not 1 (would mean B never ran)
  // and not >2 (would mean a duplicate). The KEY non-collision check above
  // is what actually proves the two runs are distinct; this cross-checks
  // it against the durable ground truth.
  for (const p of DISPATCHES_ABC) {
    if ((countsAfterChanged[p.prompt] ?? 0) !== 2) {
      problems.push(`dispatch ${JSON.stringify(p.prompt)} should have run its effect exactly once under A and once under B (count 2), got ${countsAfterChanged[p.prompt]}`);
    }
  }

  return {
    name: 'restart_with_changed_inputs',
    description:
      "A resumed run whose top-level `args` differ from the original must " +
      'not reuse ANY cached result from the original run -- every dispatch ' +
      'must derive a different key and redispatch live. Includes a same-args ' +
      'control to prove the cache mechanism actually discriminates rather ' +
      'than always missing.',
    category: problems.length ? 'failed' : 'recovered',
    pass: problems.length === 0,
    reason: problems.length ? problems.join('; ') : undefined,
    evidence: { runA, resumeSame, resumeChanged, countsAfterA, countsAfterChanged },
  };
}

async function scenario_staleResultReuseRefused(root, modules) {
  const workDir = path.join(root, 'stale-reuse');
  await mkdir(workDir, { recursive: true });
  const argsSeed = { exercise: 'm2-fault-recovery', case: 'stale-reuse' };

  // Check A: a DIFFERENT dispatch Y at the same chain position must NOT be
  // served X's committed result.
  const effectsFileA = path.join(workDir, 'effects-a.json');
  const journalPathA = path.join(workDir, 'journal-a.jsonl');
  const journalA = new modules.WorkflowJournal(journalPathA);
  const dispatchX = [{ prompt: 'task-x: do the real work', opts: OPTS }];
  const runX = await runOrchestrator(modules, {
    dispatch: makeCleanDispatch(effectsFileA),
    journal: journalA,
    args: argsSeed,
    script: buildSequentialScript(dispatchX),
  });
  const keyX = await keyFor(modules, argsSeed, dispatchX, 0);

  const problems = [];
  if (!runX.resolved) problems.push(`setup: dispatch X should complete normally, got: ${runX.errorMessage}`);

  const replay = await journalA.load();
  const dispatchY = [{ prompt: 'task-y: a completely different task', opts: OPTS }];
  const runY = await runOrchestrator(modules, {
    dispatch: makeCleanDispatch(effectsFileA),
    journal: journalA,
    args: argsSeed,
    resumeReplay: replay,
    script: buildSequentialScript(dispatchY),
  });
  const keyY = await keyFor(modules, argsSeed, dispatchY, 0);
  if (keyY === keyX) problems.push('dispatch Y must derive a different key than dispatch X (different prompt)');
  if (!runY.resolved) problems.push(`dispatch Y must redispatch fresh (not be served X's stale result), got: ${runY.errorMessage}`);
  const countsA = await readEffectCounts(effectsFileA);
  if ((countsA[dispatchX[0].prompt] ?? 0) !== 1) problems.push('X must remain untouched at count 1');
  if ((countsA[dispatchY[0].prompt] ?? 0) !== 1) problems.push('Y must run its own effect exactly once');

  // Check B: the SAME prompt text at a DIFFERENT position in a DIFFERENT
  // chain must derive a different key (prefix-chain binding, not just
  // surface text equality).
  const effectsFileB = path.join(workDir, 'effects-b.json');
  const journalPathB = path.join(workDir, 'journal-b.jsonl');
  const journalB = new modules.WorkflowJournal(journalPathB);
  const sharedPrompt = { prompt: 'shared-text: identical wording', opts: OPTS };
  const chainSolo = [sharedPrompt];
  const chainPreceded = [{ prompt: 'task-z: an unrelated predecessor', opts: OPTS }, sharedPrompt];

  const soloRun = await runOrchestrator(modules, {
    dispatch: makeCleanDispatch(effectsFileB),
    journal: journalB,
    args: argsSeed,
    script: buildSequentialScript(chainSolo),
  });
  const soloKey = await keyFor(modules, argsSeed, chainSolo, 0);
  const replayB = await journalB.load();
  const precededRun = await runOrchestrator(modules, {
    dispatch: makeCleanDispatch(effectsFileB),
    journal: journalB,
    args: argsSeed,
    resumeReplay: replayB,
    script: buildSequentialScript(chainPreceded),
  });
  const precededKeyForSharedPrompt = await keyFor(modules, argsSeed, chainPreceded, 1);

  if (!soloRun.resolved) problems.push(`setup: solo run should complete normally, got: ${soloRun.errorMessage}`);
  if (precededKeyForSharedPrompt === soloKey) {
    problems.push('identical prompt text at a different chain position must derive a different key (position binding failed)');
  }
  if (!precededRun.resolved) problems.push(`the shared-text dispatch at the new position must redispatch fresh, got: ${precededRun.errorMessage}`);
  const countsB = await readEffectCounts(effectsFileB);
  if ((countsB[sharedPrompt.prompt] ?? 0) !== 2) {
    problems.push(`shared prompt text should run its effect once per distinct position/chain (expected 2 total: solo + preceded), got ${countsB[sharedPrompt.prompt]}`);
  }

  return {
    name: 'stale_result_reuse_refused',
    description:
      'A committed result must not authorize or satisfy a DIFFERENT ' +
      'dispatch: neither a different prompt at the same position, nor an ' +
      'identical prompt at a different chain position, may be served a ' +
      'stale committed result.',
    category: problems.length ? 'failed' : 'refused',
    pass: problems.length === 0,
    reason: problems.length ? problems.join('; ') : undefined,
    evidence: { runX, runY, soloRun, precededRun },
  };
}

const SCENARIOS = [
  scenario_journalWriteFailureBeforeEffect,
  scenario_journalWriteFailureAfterEffect,
  scenario_backendFailureCleanBeforeEffect,
  scenario_backendFailureDirtyAfterEffect,
  scenario_restartWithChangedInputs,
  scenario_staleResultReuseRefused,
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

  const results = [];
  for (const scenarioFn of SCENARIOS) {
    const dir = await mkdtemp(path.join(os.tmpdir(), WORKSPACE_PREFIX));
    try {
      assertDisposableWorkspace(dir);
      const result = await scenarioFn(dir, modules);
      results.push(result);
    } catch (err) {
      results.push({
        name: scenarioFn.name,
        category: 'blocked',
        pass: false,
        reason: err instanceof Error ? err.stack : String(err),
      });
    } finally {
      if (!keep) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  const anyFailed = results.some((r) => r.category === 'failed');
  const anyBlocked = results.some((r) => r.category === 'blocked');
  const overall = anyFailed ? 'fail' : anyBlocked ? 'blocked' : 'pass';

  const summary = {
    schemaVersion: 2,
    exercise: 'm2-fault-recovery-exercise',
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
    unexercised: "workflow-stall.ts's stall watchdog is not exercised (see file header 'WHAT THIS SCRIPT DID NOT AND COULD NOT EXERCISE').",
    scenarios: results.map((r) => ({
      name: r.name,
      description: r.description,
      category: r.category,
      pass: r.pass,
      reason: r.reason,
      regime: r.evidence?.regime,
    })),
    overall,
  };

  console.log(`M2_FAULT_RECOVERY_RESULT ${JSON.stringify(summary)}`);
  for (const r of results) {
    const flag = r.category === 'failed' ? 'FAIL' : r.category === 'blocked' ? 'BLOCKED' : 'PASS';
    console.log(`[${flag}] ${r.name} (${r.category})${r.reason ? `: ${r.reason}` : ''}`);
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
  for (const a of argv) {
    if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMain) {
  const args = parseArgv(process.argv.slice(2));
  mainExercise({ keep: !!args.keep }).catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(2);
  });
}
