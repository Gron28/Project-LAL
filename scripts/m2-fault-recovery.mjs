#!/usr/bin/env node
/**
 * M2 / Gate 2 fault-recovery exercise — the FAULT half of the recovery
 * matrix. Sibling of `scripts/m1-recovery-exercise.mjs`, which exercises the
 * CRASH-WINDOW half (real SIGKILL at each journal boundary). This script
 * exercises the row directly below it in ACCEPTANCE.md's Gate 2 table:
 *
 *   "Restart, changed inputs, backend failure, full disk" ->
 *   "Recovery or explicit blocker/failure; journal failure prevents false
 *    completion; no stale approval/result reuse."
 *
 * None of these four scenarios require an OS-level crash: they are ordinary,
 * in-process failure conditions (a full disk, a dropped backend connection,
 * a resume with different arguments, an attempt to reuse a committed result
 * for a different dispatch). So, unlike m1, this script does NOT spawn
 * subprocesses or send signals — every scenario runs in-process against a
 * real on-disk journal and a real on-disk durable effect counter, with
 * faults injected at the exact call boundary the fault targets (the
 * journal's `append`, or the dispatch function itself).
 *
 * WHY THE ORCHESTRATOR LOGIC IS RE-IMPLEMENTED HERE RATHER THAN IMPORTED
 * Same rationale as m1-recovery-exercise.mjs: `apps/cli` (including
 * `workflow-journal.ts` / `workflow-orchestrator.ts`) is owned by other
 * concurrent workers and is not on this worker's file authority; its
 * compiled `dist/` output is a moving build artifact, not a stable import
 * target for a script that must keep working unattended. `canonicalizeAgentOpts`
 * / `deriveAgentKey` / `deriveArgsSeed` / `buildReplay` below are byte-for-byte
 * ports of workflow-journal.ts's algorithm (verified against the file read at
 * authoring time — see the citations above each function). `runChain` below
 * is a faithful port of the dispatch/persist ordering and journal-poison
 * latch inside `WorkflowOrchestrator.run`'s `countedDispatch`
 * (workflow-orchestrator.ts:1407-1617), cited per-line where it matters. Any
 * drift between this port and the real file would be caught by *reading*
 * that file again — which is exactly how the two genuine gaps below (see
 * "GATE 2 GAPS FOUND") were found: by tracing what actually happens on disk
 * when `this.dispatch(...)` or `journal.append(...)` fails partway through
 * `countedDispatch`'s four-step sequence.
 *
 * ISOLATION GUARANTEE
 * Every filesystem write happens under a directory this script creates
 * itself with `fs.mkdtemp(os.tmpdir() + '/lal-m2-fault-recovery-')`, and
 * every write path is additionally checked by `assertDisposableWorkspace()`
 * before use (ported from m1's guard, own prefix): it must resolve under the
 * OS temp root, carry this script's own random prefix, and must NOT resolve
 * under the repo root or `~/.lal`. Unit-tested in m2-fault-recovery.test.mjs.
 * The workspace is `fs.rm(..., {recursive:true, force:true})`-cleaned in a
 * `finally` after every scenario unless `--keep` is passed. Nothing under
 * the real repo, `~/.lal`, or any runtime database is ever opened, read, or
 * written.
 *
 * HOW "FULL DISK" IS SIMULATED WITHOUT TOUCHING REAL DISK SPACE
 * `FaultInjectedJournal` wraps a real journal file. Its `append()` checks a
 * caller-supplied predicate BEFORE doing anything else; when the predicate
 * fires, it throws a manufactured `ENOSPC` error (same `code`/`syscall`
 * shape Node's fs layer would produce) and returns WITHOUT ever calling
 * `fs.appendFile`. No real write is attempted, so no real disk space is
 * touched, consumed, or even probed — the fault is injected purely at the
 * call boundary, exactly as the hard constraint requires. The machine's real
 * free space is never read or written by this script.
 *
 * OUTCOME VOCABULARY (reported per scenario and overall)
 *   recovered - the system safely proceeded or retried and reached a
 *               correct, durable state (cache reused when inputs truly
 *               matched, or a clean redispatch after a clean failure). PASS.
 *   refused   - the system detected a dangerous condition (an ambiguous
 *               effect, a would-be stale-result substitution) and explicitly
 *               declined to proceed, rather than guessing. PASS of the
 *               safety contract, not a failure.
 *   blocked   - the harness itself could not set up or complete the
 *               scenario (a bug in this script, not a verdict on the
 *               product).
 *   failed    - a genuine, durably-evidenced contract violation: a
 *               non-idempotent effect ran more than once for one key, a
 *               committed result was reused for a different dispatch, or a
 *               journal failure still yielded a reported completion.
 *               Grading always reads the on-disk effect counter and the
 *               on-disk journal file directly — never a self-report from
 *               the dispatch stub — so a "recovered" claim cannot paper over
 *               a real duplicate.
 *
 * GATE 2 GAPS FOUND (see scenario `journal_write_failure_after_effect` and
 * `backend_failure_dirty_after_effect` below for the reproductions)
 *
 *   1. workflow-orchestrator.ts:1552-1561 (`const result = await
 *      this.dispatch(prompt, opts); ... await persist({type:'effect_complete'...})`):
 *      if the `effect_complete` append throws AFTER `this.dispatch` has
 *      already resolved (a plain ENOSPC on that one write — no crash, no
 *      signal, the process stays alive and even correctly fails the run),
 *      the on-disk journal for that key ends up containing `started` only.
 *      That is structurally IDENTICAL to "the effect never ran" per
 *      `buildReplay` (workflow-journal.ts:191-208), which only populates
 *      `ambiguousEffects` from an `effect_complete` entry that actually
 *      landed on disk. A future resume of that run therefore treats the key
 *      as an ordinary miss and safely-looking redispatches it — duplicating
 *      the already-completed non-idempotent effect. This reproduces without
 *      any OS-level crash: an everyday disk-full condition on one `fs.appendFile`
 *      call is sufficient. It is a strictly easier trigger than m1's
 *      documented residual limitation (which needs a crash mid-append), and
 *      it defeats the very journal design `effect_complete` exists to fix.
 *      Scenario `journal_write_failure_after_effect` reproduces this with a
 *      durable on-disk effect counter going 1 -> 2 for the same key with no
 *      crash involved.
 *
 *   2. workflow-orchestrator.ts:1552 (`const result = await
 *      this.dispatch(prompt, opts);`) taken alone, independent of the
 *      journal: there is no journal entry written between `started` and
 *      `effect_complete`, so if `this.dispatch` itself rejects AFTER an
 *      internal side effect already landed (e.g. a dropped backend
 *      connection after a `write_file`/`shell` tool call already executed
 *      inside `subagent.execute`, but before the model's turn — and hence
 *      the dispatch promise — resolves), the journal again ends up with
 *      `started` only, indistinguishable from "never ran." This matches the
 *      2026-09-21 incident referenced in the task brief: a dropped
 *      connection destroyed the record of live work with no journal trace
 *      to show it happened, so the next attempt paid for it again. Scenario
 *      `backend_failure_dirty_after_effect` reproduces this with the same
 *      1 -> 2 duplicate-effect signature, again with zero process crashes —
 *      just an ordinary rejected promise.
 *
 * Both gaps share one root cause: `effect_complete` is written strictly
 * AFTER `this.dispatch` resolves (by design — it records "the effect ran",
 * which can only be known in hindsight), so any failure between the effect
 * actually running and that append landing on disk — whether the failure is
 * in the disk write itself or in the dispatch call reporting its own
 * outcome — collapses to the "never ran" case. Both are real, reproducible,
 * currently-uncovered gaps in the Gate 2 contract, not artifacts of this
 * harness's simplification (the port matches the cited production lines
 * exactly).
 *
 * WHAT THIS SCRIPT DID NOT AND COULD NOT EXERCISE
 * `workflow-stall.ts`'s stall watchdog (referenced from
 * workflow-orchestrator.ts:410-437) is the production mechanism for a truly
 * silent (no error, no data) hung/dropped connection — it aborts and retries
 * a dispatch that produces no progress for `stallMs`. This script's dispatch
 * stubs are plain functions, not real subagents wired to that watchdog, so
 * this script cannot exercise or vouch for that mechanism; it only proves,
 * via `withTimeout`, that THIS harness's own synthetic "hangs forever" stub
 * does not hang the exercise itself. Treat the stall watchdog as unverified
 * by this script, not as verified-passing.
 *
 * USAGE
 *   node scripts/m2-fault-recovery.mjs            # run the exercise
 *   node scripts/m2-fault-recovery.mjs --keep      # keep temp workspaces
 *   node --test scripts/m2-fault-recovery.test.mjs # self-tests (no GPU)
 *
 * Exit codes: 0 = every scenario is recovered/refused (no violation found);
 * 1 = at least one scenario is a genuine contract violation (EXPECTED for
 * this candidate build — see "GATE 2 GAPS FOUND" above); 2 = the harness
 * itself was blocked on some scenario (no verdict reached for it).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const WORKSPACE_PREFIX = 'lal-m2-fault-recovery-';
const DISPATCH_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Journal contract: byte-for-byte port of workflow-journal.ts's algorithm
// (same port m1-recovery-exercise.mjs uses; re-ported independently here so
// this script has no runtime dependency on that sibling file or on apps/cli).
// ---------------------------------------------------------------------------

export const JOURNAL_KEY_VERSION = 'v2';

/** Mirrors workflow-journal.ts `canonicalizeAgentOpts` (lines 112-140). */
export function canonicalizeAgentOpts(opts) {
  const projected = {};
  for (const k of ['schema', 'model', 'isolation', 'agentType']) {
    const v = opts?.[k];
    if (v === undefined || typeof v === 'function') continue;
    projected[k] = v;
  }
  const sortDeep = (val) => {
    if (typeof val === 'function') return undefined;
    if (Array.isArray(val)) return val.map(sortDeep);
    if (val && typeof val === 'object') {
      const out = {};
      for (const key of Object.keys(val).sort()) {
        if (key === '__proto__') continue;
        out[key] = sortDeep(val[key]);
      }
      return out;
    }
    return val;
  };
  try {
    return JSON.stringify(sortDeep(projected));
  } catch {
    return '{}';
  }
}

/** Mirrors workflow-journal.ts `deriveAgentKey` (lines 147-159). */
export function deriveAgentKey(prefixHash, prompt, opts) {
  const hash = createHash('sha256');
  hash.update(prefixHash);
  hash.update('\0');
  hash.update(prompt);
  hash.update('\0');
  hash.update(canonicalizeAgentOpts(opts));
  return `${JOURNAL_KEY_VERSION}:${hash.digest('hex')}`;
}

/**
 * Mirrors workflow-journal.ts `deriveArgsSeed` (lines 168-180). This is the
 * function scenario `restart_with_changed_inputs` below exercises directly:
 * it is what is supposed to make a resume with different `args` produce a
 * disjoint key space.
 */
export function deriveArgsSeed(args) {
  const hash = createHash('sha256');
  let serialized;
  try {
    serialized = JSON.stringify(args ?? null) ?? 'null';
  } catch {
    serialized = 'non-serializable-args';
  }
  hash.update(serialized);
  return `${JOURNAL_KEY_VERSION}:${hash.digest('hex')}`;
}

/** Mirrors workflow-journal.ts `buildReplay` (lines 191-208). */
export function buildReplay(entries) {
  const results = new Map();
  const started = new Map();
  const ambiguousEffects = new Set();
  for (const e of entries) {
    if (e.type === 'result') {
      results.set(e.key, e);
      ambiguousEffects.delete(e.key);
    } else if (e.type === 'started') {
      const list = started.get(e.key);
      if (list) list.push(e);
      else started.set(e.key, [e]);
    } else if (e.type === 'effect_complete') {
      ambiguousEffects.add(e.key);
    }
  }
  return { results, started, ambiguousEffects };
}

/**
 * Append-only JSONL journal file. `append` fsyncs per line (`flush: true`),
 * mirroring jsonl-utils.ts's `writeLine`, so every entry that DOES land is a
 * durable, on-disk fact rather than an in-memory one — the property grading
 * below depends on for the "clean" scenarios' cache-hit checks.
 */
export class WorkflowJournalFile {
  constructor(filePath) {
    this.path = filePath;
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return buildReplay([]);
      throw err;
    }
    const entries = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return buildReplay(entries);
  }

  async append(entry) {
    const dir = path.dirname(this.path);
    await mkdir(dir, { recursive: true });
    const line = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
    await fs.promises.appendFile(this.path, line, { flush: true });
  }
}

/**
 * Wraps a real `WorkflowJournalFile` and injects a manufactured ENOSPC
 * failure at `append()` calls chosen by `shouldFail(entry, callIndex)`.
 * When the predicate fires, NO real filesystem call is made — the function
 * returns (throws) before touching `fs` at all, so this can never actually
 * fill a disk or write a byte more than the legitimate entries that pass
 * through it. This is the "full disk" fault-injection point required by the
 * task: the error is manufactured at the write boundary, not by consuming
 * real space.
 */
export class FaultInjectedJournal {
  constructor(realPath, shouldFail) {
    this.inner = new WorkflowJournalFile(realPath);
    this.path = realPath;
    this.shouldFail = shouldFail;
    this.callIndex = 0;
  }

  load() {
    return this.inner.load();
  }

  async append(entry) {
    const idx = this.callIndex++;
    if (this.shouldFail(entry, idx)) {
      const err = new Error(
        'ENOSPC: no space left on device, write (simulated — no real fs call was made)',
      );
      err.code = 'ENOSPC';
      err.syscall = 'write';
      throw err;
    }
    return this.inner.append(entry);
  }
}

// ---------------------------------------------------------------------------
// Isolation guard — ported from m1-recovery-exercise.mjs's
// assertDisposableWorkspace, own workspace prefix.
// ---------------------------------------------------------------------------

export function assertDisposableWorkspace(dir) {
  const real = path.resolve(dir);
  const tmpRoot = path.resolve(os.tmpdir());
  const base = path.basename(real);
  if (real !== tmpRoot && !real.startsWith(tmpRoot + path.sep)) {
    throw new Error(
      `refusing to operate outside the OS temp directory: ${real}`,
    );
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
// Durable, on-disk, per-key action counter — the "persisted action counter"
// ACCEPTANCE.md asks for, not a mock/in-memory dispatch count. Same shape as
// m1-recovery-exercise.mjs's runEffect, re-ported independently.
// ---------------------------------------------------------------------------

export async function runEffect(effectsFile, key) {
  let counts = {};
  try {
    counts = JSON.parse(await readFile(effectsFile, 'utf8'));
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  counts[key] = (counts[key] ?? 0) + 1;
  await fs.promises.writeFile(effectsFile, JSON.stringify(counts), {
    flush: true,
  });
  return counts[key];
}

export async function readEffectCounts(effectsFile) {
  try {
    return JSON.parse(await readFile(effectsFile, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * Bounds a promise to `ms`. Used only around the dispatch-stub call so this
 * harness itself can never hang forever waiting on a synthetic "dropped
 * connection that never even rejects" stub — see the file header's note on
 * what this does and does not verify about the real stall watchdog.
 */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        `${label ?? 'operation'} did not settle within ${ms}ms (silent stall)`,
      );
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Dispatch-stub factories. Each returns `(key) => Promise<result>`. None of
// these touch a model, a network socket, or the GPU — they are plain
// functions standing in for `this.dispatch(prompt, opts)`
// (workflow-orchestrator.ts:1552), whose real implementation is
// `createProductionDispatch` (line 396).
// ---------------------------------------------------------------------------

/** Always succeeds: runs the durable effect and returns its count. */
export function makeCleanDispatch(effectsFile) {
  return async (key) => ({ ok: true, count: await runEffect(effectsFile, key) });
}

/**
 * Fails BEFORE doing anything observable — models a backend/connection
 * failure that happens before any tool call or generation started. No
 * durable effect runs.
 */
export function makeCleanBackendFailure() {
  return async () => {
    const err = new Error('ECONNRESET: connection dropped before dispatch');
    err.code = 'ECONNRESET';
    throw err;
  };
}

/**
 * Runs the durable effect FIRST (models a tool call / generation that
 * actually completed against the workspace), THEN fails — models a backend
 * connection dropping AFTER live work happened but before the dispatch
 * promise could resolve and report that work back to the orchestrator. This
 * is the shape of the 2026-09-21 incident cited in the task brief.
 */
export function makeDirtyBackendFailure(effectsFile) {
  return async (key) => {
    await runEffect(effectsFile, key);
    const err = new Error(
      'ECONNRESET: connection dropped after the effect ran, before the result could be reported',
    );
    err.code = 'ECONNRESET';
    throw err;
  };
}

// ---------------------------------------------------------------------------
// runChain: a faithful, minimal port of the dispatch/persist ordering and
// journal-poison latch inside WorkflowOrchestrator.run's `countedDispatch`
// (workflow-orchestrator.ts:1407-1617). Handles BOTH a fresh run (no
// `replay`) and a resume (`replay` given) — production unifies these into
// one closure, so this port does too, rather than splitting them the way
// m1-recovery-exercise.mjs's playDispatches/resumeAndReconcile split the
// crash-window case (that split fit a real-child-process crash boundary;
// nothing here needs one).
//
// Simplification, stated explicitly: production's failure propagates as a
// rejected promise out of ONE `agent()` call; whether the WORKFLOW SCRIPT
// aborts entirely or catches it and keeps calling `agent()` for later steps
// is the script's own choice, not the orchestrator's. This harness continues
// its own dispatch loop after a non-journal failure (to observe whether
// later, unrelated dispatches are correctly unaffected — they must be, since
// nothing in `countedDispatch` short-circuits future keys on an ordinary
// dispatch failure) but respects the journal's OWN latch faithfully: once a
// journal write fails, `journalError` is remembered for the rest of THIS
// run and every later dispatch is refused immediately without invoking its
// effect or attempting any further journal write — this exactly mirrors
// `if (journalError) throw journalError;` inside `countedDispatch`'s
// `limiter.run` (workflow-orchestrator.ts:1527), which is a run-wide latch,
// not a per-key one. An ambiguous-effect refusal (workflow-orchestrator.ts:
// 1430-1435) DOES abort the whole resume in production (the resume throws
// `WorkflowAmbiguousEffectError` synchronously from the dispatch, before any
// later key is even looked up) — this harness matches that by returning
// immediately on the first ambiguous key, unlike the continue-on-failure
// behavior for ordinary backend/journal failures.
// ---------------------------------------------------------------------------

export async function runChain({ dispatches, journal, dispatchFn, replay, argsSeed }) {
  let prefixHash = deriveArgsSeed(argsSeed);
  let journalError;
  let aborted = false;
  let abortedAtIndex = null;
  let abortReason = null;
  const perIndex = [];

  for (let i = 0; i < dispatches.length; i++) {
    const { prompt, opts } = dispatches[i];
    // Key computed synchronously up front regardless of what happens next —
    // matches workflow-orchestrator.ts:1419-1420 (`journalKey = deriveAgentKey(...); prefixHash = journalKey;`
    // runs before any await, so the chain always advances even on failure).
    const key = deriveAgentKey(prefixHash, prompt, opts);
    prefixHash = key;
    const agentId = String(i + 1);

    if (replay) {
      // Ambiguous check runs BEFORE the cache-hit lookup and aborts the
      // whole resume immediately — workflow-orchestrator.ts:1430-1435.
      if (replay.ambiguousEffects.has(key)) {
        perIndex.push({ index: i, key, outcome: 'refused-ambiguous' });
        return {
          perIndex,
          aborted: true,
          abortedAtIndex: i,
          abortReason: 'ambiguous-effect',
        };
      }
      const cached = replay.results.get(key);
      if (cached !== undefined) {
        perIndex.push({ index: i, key, outcome: 'recovered-cached', result: cached.result });
        continue;
      }
    }

    if (journalError) {
      // Run-wide latch — workflow-orchestrator.ts:1527 (`if (journalError) throw journalError;`).
      perIndex.push({ index: i, key, outcome: 'blocked-journal-poisoned' });
      if (!aborted) {
        aborted = true;
        abortedAtIndex = i;
        abortReason = 'journal-poisoned';
      }
      continue;
    }

    try {
      await journal.append({ type: 'started', key, agentId });
    } catch (err) {
      journalError = err;
      perIndex.push({ index: i, key, outcome: 'blocked-journal-write-failed', phase: 'started' });
      if (!aborted) {
        aborted = true;
        abortedAtIndex = i;
        abortReason = 'journal-write-failed:started';
      }
      continue;
    }

    let result;
    try {
      result = await withTimeout(dispatchFn(key, i), DISPATCH_TIMEOUT_MS, `dispatch(${key})`);
    } catch (err) {
      perIndex.push({
        index: i,
        key,
        outcome: 'blocked-backend-failed',
        phase: 'dispatch',
        error: err instanceof Error ? err.message : String(err),
      });
      if (!aborted) {
        aborted = true;
        abortedAtIndex = i;
        abortReason = 'backend-failed';
      }
      continue;
    }

    try {
      await journal.append({ type: 'effect_complete', key, agentId });
    } catch (err) {
      journalError = err;
      perIndex.push({ index: i, key, outcome: 'blocked-journal-write-failed', phase: 'effect_complete' });
      if (!aborted) {
        aborted = true;
        abortedAtIndex = i;
        abortReason = 'journal-write-failed:effect_complete';
      }
      continue;
    }

    try {
      await journal.append({ type: 'result', key, agentId, result });
    } catch (err) {
      journalError = err;
      perIndex.push({ index: i, key, outcome: 'blocked-journal-write-failed', phase: 'result' });
      if (!aborted) {
        aborted = true;
        abortedAtIndex = i;
        abortReason = 'journal-write-failed:result';
      }
      continue;
    }

    perIndex.push({ index: i, key, outcome: 'redispatched', result });
  }

  return { perIndex, aborted, abortedAtIndex, abortReason };
}

/** Finds `perIndex[index].key` and looks it up in `counts`; 0 if absent. */
function countFor(key, counts) {
  return counts[key] ?? 0;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const DISPATCHES_ABC = [
  { prompt: 'fault-dispatch-alpha: write file A', opts: { model: 'stub-model-v1', isolation: 'none', agentType: 'exercise' } },
  { prompt: 'fault-dispatch-beta: write file B', opts: { model: 'stub-model-v1', isolation: 'none', agentType: 'exercise' } },
  { prompt: 'fault-dispatch-gamma: write file C', opts: { model: 'stub-model-v1', isolation: 'none', agentType: 'exercise' } },
];

async function scenario_journalWriteFailureBeforeEffect(dir) {
  const workDir = path.join(dir, 'journal-write-before-effect');
  await mkdir(workDir, { recursive: true });
  assertDisposableWorkspace(dir);
  const effectsFile = path.join(workDir, 'effects.json');
  // Fail on the FIRST append call: dispatch A's `started` entry. The effect
  // must never run, and dispatch B (the next in line) must be blocked by the
  // journal-poison latch WITHOUT the harness even attempting its journal
  // write or its effect.
  const journal = new FaultInjectedJournal(
    path.join(workDir, 'journal.jsonl'),
    (_entry, idx) => idx === 0,
  );
  const outcome = await runChain({
    dispatches: DISPATCHES_ABC.slice(0, 2),
    journal,
    dispatchFn: makeCleanDispatch(effectsFile),
    argsSeed: { exercise: 'm2-fault-recovery', case: 'journal-before-effect' },
  });
  const counts = await readEffectCounts(effectsFile);

  const problems = [];
  if (!outcome.aborted || outcome.abortReason !== 'journal-write-failed:started') {
    problems.push(`expected abortReason journal-write-failed:started, got ${outcome.abortReason}`);
  }
  if (outcome.perIndex[0]?.outcome !== 'blocked-journal-write-failed') {
    problems.push(`index0 should be blocked-journal-write-failed, got ${outcome.perIndex[0]?.outcome}`);
  }
  if (outcome.perIndex[1]?.outcome !== 'blocked-journal-poisoned') {
    problems.push(`index1 should be blocked-journal-poisoned (latch), got ${outcome.perIndex[1]?.outcome}`);
  }
  if (Object.keys(counts).length !== 0) {
    problems.push(`no effect should have run at all; effects.json = ${JSON.stringify(counts)}`);
  }
  const onDisk = await journal.load();
  if (onDisk.results.size !== 0) {
    problems.push('journal on disk must not contain any result (no false completion)');
  }

  return {
    name: 'journal_write_failure_before_effect',
    description:
      "ENOSPC on the very first journal append (dispatch A's `started`). The " +
      'effect must never run, and the poison latch must block dispatch B ' +
      'too, without B even attempting its own write or effect.',
    category: problems.length ? 'failed' : 'refused',
    pass: problems.length === 0,
    reason: problems.length ? problems.join('; ') : undefined,
    evidence: { outcome, counts },
  };
}

async function scenario_journalWriteFailureAfterEffect(dir) {
  const workDir = path.join(dir, 'journal-write-after-effect');
  await mkdir(workDir, { recursive: true });
  assertDisposableWorkspace(dir);
  const effectsFile = path.join(workDir, 'effects.json');
  const journalPath = path.join(workDir, 'journal.jsonl');
  // Fail on the SECOND append call for dispatch A: its `effect_complete`
  // entry, i.e. AFTER this.dispatch (the effect) has already resolved.
  const faultyJournal = new FaultInjectedJournal(journalPath, (_entry, idx) => idx === 1);
  const firstAttempt = await runChain({
    dispatches: DISPATCHES_ABC.slice(0, 1),
    journal: faultyJournal,
    dispatchFn: makeCleanDispatch(effectsFile),
    argsSeed: { exercise: 'm2-fault-recovery', case: 'journal-after-effect' },
  });
  const countsAfterFirstAttempt = await readEffectCounts(effectsFile);
  const key0 = firstAttempt.perIndex[0]?.key;

  const problems = [];
  if (firstAttempt.perIndex[0]?.outcome !== 'blocked-journal-write-failed') {
    problems.push(`first attempt index0 should be blocked-journal-write-failed, got ${firstAttempt.perIndex[0]?.outcome}`);
  }
  if (countFor(key0, countsAfterFirstAttempt) !== 1) {
    problems.push(
      `the effect DID run once already (this.dispatch resolved before the ` +
        `journal write failed) — expected count 1, got ${countFor(key0, countsAfterFirstAttempt)}`,
    );
  }
  // Confirm the on-disk journal really is started-only for this key — this
  // IS the seam: it is indistinguishable from "effect never ran".
  const onDiskAfterFirst = await faultyJournal.load();
  if (onDiskAfterFirst.ambiguousEffects.has(key0)) {
    problems.push('unexpectedly ambiguous on disk — the finding depends on this key NOT being ambiguous');
  }
  if (onDiskAfterFirst.results.has(key0)) {
    problems.push('journal must not contain a result for this key (no false completion) after the write failure');
  }

  // Now simulate a resume: a fresh, WORKING journal handle over the SAME
  // on-disk file, and a WORKING dispatch this time (the disk has space
  // again). Reconcile against the replay loaded from disk.
  const healedJournal = new WorkflowJournalFile(journalPath);
  const replay = await healedJournal.load();
  const resumeAttempt = await runChain({
    dispatches: DISPATCHES_ABC.slice(0, 1),
    journal: healedJournal,
    dispatchFn: makeCleanDispatch(effectsFile),
    replay,
    argsSeed: { exercise: 'm2-fault-recovery', case: 'journal-after-effect' },
  });
  const countsAfterResume = await readEffectCounts(effectsFile);

  if (resumeAttempt.perIndex[0]?.outcome !== 'redispatched') {
    problems.push(`resume should treat the key as an ordinary miss and redispatch, got ${resumeAttempt.perIndex[0]?.outcome}`);
  }

  // Setup problems mean the harness failed to reproduce the scenario it set
  // out to build (a bug in THIS script, not a verdict on the product) —
  // that is 'blocked', distinct from the gap finding itself.
  if (problems.length) {
    return {
      name: 'journal_write_failure_after_effect',
      description:
        "ENOSPC on dispatch A's `effect_complete` append, AFTER its effect " +
        'already ran successfully — intended to reproduce Gate 2 gap #1.',
      category: 'blocked',
      pass: false,
      reason: `harness failed to set up the intended fault condition: ${problems.join('; ')}`,
      evidence: { firstAttempt, resumeAttempt, countsAfterFirstAttempt, countsAfterResume },
    };
  }

  const finalCount = countFor(key0, countsAfterResume);
  const violation = finalCount === 2;

  return {
    name: 'journal_write_failure_after_effect',
    description:
      "ENOSPC on dispatch A's `effect_complete` append, AFTER its effect " +
      'already ran successfully. No crash anywhere. GATE 2 GAP: the on-disk ' +
      'journal for this key ends up started-only — identical to "never ran" ' +
      '— so a later resume redispatches it, duplicating the already-' +
      'completed non-idempotent effect. See file header "GATE 2 GAPS FOUND" #1 ' +
      '(workflow-orchestrator.ts:1552-1561).',
    // `violation` (the effect running twice) is the EXPECTED, correctly-
    // predicted outcome given the cited production code — so this scenario
    // intentionally reports category 'failed' (a real, reproduced Gate 2
    // gap) rather than a false 'pass'. If a future fix makes `violation`
    // false, this scenario should be revisited (it would mean the gap was
    // closed, or the harness stopped exercising it — check which).
    category: violation ? 'failed' : 'blocked',
    pass: false,
    reason: violation
      ? `duplicate non-idempotent effect confirmed via durable counter: key ${key0} ran ${finalCount} times (expected 1)`
      : `expected the effect to run twice (count 2) to confirm the predicted gap, but it ran ${finalCount} time(s) — the harness did not reproduce the condition it intended to`,
    evidence: { firstAttempt, resumeAttempt, countsAfterFirstAttempt, countsAfterResume },
  };
}

async function scenario_backendFailureCleanBeforeEffect(dir) {
  const workDir = path.join(dir, 'backend-clean');
  await mkdir(workDir, { recursive: true });
  assertDisposableWorkspace(dir);
  const effectsFile = path.join(workDir, 'effects.json');
  const journalPath = path.join(workDir, 'journal.jsonl');
  const journal = new WorkflowJournalFile(journalPath);

  const firstAttempt = await runChain({
    dispatches: DISPATCHES_ABC.slice(0, 1),
    journal,
    dispatchFn: makeCleanBackendFailure(),
    argsSeed: { exercise: 'm2-fault-recovery', case: 'backend-clean' },
  });
  const key0 = firstAttempt.perIndex[0]?.key;
  const countsAfterFirst = await readEffectCounts(effectsFile);

  const problems = [];
  if (firstAttempt.perIndex[0]?.outcome !== 'blocked-backend-failed') {
    problems.push(`expected blocked-backend-failed, got ${firstAttempt.perIndex[0]?.outcome}`);
  }
  if (countFor(key0, countsAfterFirst) !== 0) {
    problems.push(`no effect should have run yet, got count ${countFor(key0, countsAfterFirst)}`);
  }

  const replay = await journal.load();
  const resumeAttempt = await runChain({
    dispatches: DISPATCHES_ABC.slice(0, 1),
    journal,
    dispatchFn: makeCleanDispatch(effectsFile),
    replay,
    argsSeed: { exercise: 'm2-fault-recovery', case: 'backend-clean' },
  });
  const countsAfterResume = await readEffectCounts(effectsFile);
  if (resumeAttempt.perIndex[0]?.outcome !== 'redispatched') {
    problems.push(`resume should redispatch, got ${resumeAttempt.perIndex[0]?.outcome}`);
  }
  if (countFor(key0, countsAfterResume) !== 1) {
    problems.push(`effect should run exactly once total, got ${countFor(key0, countsAfterResume)}`);
  }

  return {
    name: 'backend_failure_clean_before_effect',
    description:
      'Backend/connection failure BEFORE any effect ran (a clean rejection ' +
      '— the dispatch never touched the workspace). Required: no false ' +
      'completion, no silent stall, and a safe exactly-once retry on resume.',
    category: problems.length ? 'failed' : 'recovered',
    pass: problems.length === 0,
    reason: problems.length ? problems.join('; ') : undefined,
    evidence: { firstAttempt, resumeAttempt, countsAfterFirst, countsAfterResume },
  };
}

async function scenario_backendFailureDirtyAfterEffect(dir) {
  const workDir = path.join(dir, 'backend-dirty');
  await mkdir(workDir, { recursive: true });
  assertDisposableWorkspace(dir);
  const effectsFile = path.join(workDir, 'effects.json');
  const journalPath = path.join(workDir, 'journal.jsonl');
  const journal = new WorkflowJournalFile(journalPath);

  const firstAttempt = await runChain({
    dispatches: DISPATCHES_ABC.slice(0, 1),
    journal,
    dispatchFn: makeDirtyBackendFailure(effectsFile),
    argsSeed: { exercise: 'm2-fault-recovery', case: 'backend-dirty' },
  });
  const key0 = firstAttempt.perIndex[0]?.key;
  const countsAfterFirst = await readEffectCounts(effectsFile);

  const problems = [];
  if (firstAttempt.perIndex[0]?.outcome !== 'blocked-backend-failed') {
    problems.push(`expected blocked-backend-failed, got ${firstAttempt.perIndex[0]?.outcome}`);
  }
  if (countFor(key0, countsAfterFirst) !== 1) {
    problems.push(
      `the effect already ran once inside the failed dispatch — expected ` +
        `count 1 before any resume, got ${countFor(key0, countsAfterFirst)}`,
    );
  }
  const onDiskAfterFirst = await journal.load();
  if (onDiskAfterFirst.results.has(key0)) {
    problems.push('no result should be committed for a failed dispatch (no false completion)');
  }
  if (onDiskAfterFirst.ambiguousEffects.has(key0)) {
    problems.push('this key is not expected to be ambiguous — there is no journal mechanism that would make it so, which IS the finding');
  }

  const replay = await journal.load();
  const resumeAttempt = await runChain({
    dispatches: DISPATCHES_ABC.slice(0, 1),
    journal,
    dispatchFn: makeCleanDispatch(effectsFile),
    replay,
    argsSeed: { exercise: 'm2-fault-recovery', case: 'backend-dirty' },
  });
  const countsAfterResume = await readEffectCounts(effectsFile);
  if (problems.length) {
    return {
      name: 'backend_failure_dirty_after_effect',
      description:
        'Backend/connection failure AFTER the effect already ran but before ' +
        'the dispatch promise resolved — intended to reproduce Gate 2 gap #2.',
      category: 'blocked',
      pass: false,
      reason: `harness failed to set up the intended fault condition: ${problems.join('; ')}`,
      evidence: { firstAttempt, resumeAttempt, countsAfterFirst, countsAfterResume },
    };
  }

  const finalCount = countFor(key0, countsAfterResume);
  const violation = finalCount === 2;

  return {
    name: 'backend_failure_dirty_after_effect',
    description:
      'Backend/connection failure AFTER the effect already ran but before ' +
      'the dispatch promise resolved (models the 2026-09-21 dropped-' +
      'connection incident). GATE 2 GAP: no journal entry exists between ' +
      '`started` and `effect_complete`, so this collapses to the same ' +
      '"never ran" signature and a resume duplicates the effect. See file ' +
      'header "GATE 2 GAPS FOUND" #2 (workflow-orchestrator.ts:1552).',
    // Same rationale as journal_write_failure_after_effect above: `violation`
    // is the EXPECTED, correctly-predicted outcome given the cited
    // production code, so this intentionally reports 'failed' rather than a
    // false 'pass'.
    category: violation ? 'failed' : 'blocked',
    pass: false,
    reason: violation
      ? `duplicate non-idempotent effect confirmed via durable counter: key ${key0} ran ${finalCount} times (expected 1)`
      : `expected the effect to run twice (count 2) to confirm the predicted gap, but it ran ${finalCount} time(s) — the harness did not reproduce the condition it intended to`,
    evidence: { firstAttempt, resumeAttempt, countsAfterFirst, countsAfterResume },
  };
}

async function scenario_restartWithChangedInputs(dir) {
  const workDir = path.join(dir, 'changed-inputs');
  await mkdir(workDir, { recursive: true });
  assertDisposableWorkspace(dir);
  const effectsFile = path.join(workDir, 'effects.json');
  const journalPath = path.join(workDir, 'journal.jsonl');
  const journal = new WorkflowJournalFile(journalPath);
  const argsA = { exercise: 'm2-fault-recovery', run: 'A' };
  const argsB = { exercise: 'm2-fault-recovery', run: 'B' };

  const runA = await runChain({
    dispatches: DISPATCHES_ABC,
    journal,
    dispatchFn: makeCleanDispatch(effectsFile),
    argsSeed: argsA,
  });
  const countsAfterA = await readEffectCounts(effectsFile);

  const problems = [];
  if (runA.perIndex.some((e) => e.outcome !== 'redispatched')) {
    problems.push('run A (fresh) should redispatch every dispatch');
  }
  for (const e of runA.perIndex) {
    if (countFor(e.key, countsAfterA) !== 1) problems.push(`run A key ${e.key} should have count 1`);
  }

  // Control: resume with the SAME args must reuse the cache entirely (zero
  // new effects) — this gives the "changed inputs" assertion below its
  // meaning; without this control, "everything always redispatches" would
  // trivially look like "changed inputs are never wrongly reused".
  const replaySame = await journal.load();
  const resumeSame = await runChain({
    dispatches: DISPATCHES_ABC,
    journal,
    dispatchFn: makeCleanDispatch(effectsFile),
    replay: replaySame,
    argsSeed: argsA,
  });
  const countsAfterSame = await readEffectCounts(effectsFile);
  if (resumeSame.perIndex.some((e) => e.outcome !== 'recovered-cached')) {
    problems.push('resume with IDENTICAL args should be served entirely from cache');
  }
  if (JSON.stringify(countsAfterSame) !== JSON.stringify(countsAfterA)) {
    problems.push('resume with identical args must not run any effect again');
  }

  // The actual scenario: resume with CHANGED args against run A's journal.
  const replayForChanged = await journal.load();
  const resumeChanged = await runChain({
    dispatches: DISPATCHES_ABC,
    journal,
    dispatchFn: makeCleanDispatch(effectsFile),
    replay: replayForChanged,
    argsSeed: argsB,
  });
  const countsAfterChanged = await readEffectCounts(effectsFile);

  if (resumeChanged.perIndex.some((e) => e.outcome !== 'redispatched')) {
    problems.push(
      'resume with CHANGED args must miss the cache for every dispatch and ' +
        `redispatch live, got outcomes: ${resumeChanged.perIndex.map((e) => e.outcome).join(',')}`,
    );
  }
  // The new keys (derived under argsB) must differ from run A's keys.
  const keysA = new Set(runA.perIndex.map((e) => e.key));
  for (const e of resumeChanged.perIndex) {
    if (keysA.has(e.key)) problems.push(`changed-args key ${e.key} collided with a run-A key — key derivation did not distinguish changed inputs`);
    if (countFor(e.key, countsAfterChanged) !== 1) problems.push(`changed-args key ${e.key} should run exactly once`);
  }
  // Run A's original keys must remain untouched (still count 1, not reused
  // AND not duplicated).
  for (const key of keysA) {
    if (countFor(key, countsAfterChanged) !== 1) problems.push(`run A key ${key} must remain at count 1 after the changed-args resume`);
  }

  return {
    name: 'restart_with_changed_inputs',
    description:
      'A resumed run whose top-level `args` differ from the original must ' +
      'not reuse ANY cached result from the original run — every dispatch ' +
      'must miss and redispatch live. Includes a same-args control to prove ' +
      'the cache mechanism actually discriminates rather than always missing.',
    category: problems.length ? 'failed' : 'recovered',
    pass: problems.length === 0,
    reason: problems.length ? problems.join('; ') : undefined,
    evidence: { runA, resumeSame, resumeChanged, countsAfterA, countsAfterChanged },
  };
}

async function scenario_staleResultReuseRefused(dir) {
  const workDir = path.join(dir, 'stale-reuse');
  await mkdir(workDir, { recursive: true });
  assertDisposableWorkspace(dir);
  const effectsFile = path.join(workDir, 'effects.json');
  const journalPath = path.join(workDir, 'journal.jsonl');
  const journal = new WorkflowJournalFile(journalPath);
  const argsSeed = { exercise: 'm2-fault-recovery', case: 'stale-reuse' };

  // Commit dispatch X ("task-x") to completion.
  const dispatchX = [{ prompt: 'task-x: do the real work', opts: { model: 'stub-model-v1', isolation: 'none', agentType: 'exercise' } }];
  const runX = await runChain({
    dispatches: dispatchX,
    journal,
    dispatchFn: makeCleanDispatch(effectsFile),
    argsSeed,
  });
  const keyX = runX.perIndex[0]?.key;

  const problems = [];
  if (runX.perIndex[0]?.outcome !== 'redispatched') problems.push('setup: dispatch X should complete normally');

  // Check A: a DIFFERENT dispatch Y at the same chain position (same args
  // seed, same opts, different prompt) must NOT be served X's committed
  // result.
  const replay = await journal.load();
  const dispatchY = [{ prompt: 'task-y: a completely different task', opts: dispatchX[0].opts }];
  const runY = await runChain({
    dispatches: dispatchY,
    journal,
    dispatchFn: makeCleanDispatch(effectsFile),
    replay,
    argsSeed,
  });
  const keyY = runY.perIndex[0]?.key;
  if (keyY === keyX) problems.push('dispatch Y must derive a different key than dispatch X (different prompt)');
  if (runY.perIndex[0]?.outcome !== 'redispatched') {
    problems.push(`dispatch Y must be redispatched fresh (not served X's stale result), got ${runY.perIndex[0]?.outcome}`);
  }
  const countsAfterY = await readEffectCounts(effectsFile);
  if (countFor(keyX, countsAfterY) !== 1) problems.push('X must remain untouched at count 1');
  if (countFor(keyY, countsAfterY) !== 1) problems.push('Y must run its own effect exactly once');

  // Check B: the SAME prompt text reused at a DIFFERENT position in a
  // DIFFERENT chain must derive a different key (prefix-chain binding, not
  // just surface text equality) — a completed result from position 0 of one
  // chain must not authorize an identical-looking dispatch at position 1 of
  // another chain.
  const sharedPrompt = { prompt: 'shared-text: identical wording', opts: dispatchX[0].opts };
  const chainSolo = [sharedPrompt];
  const chainPreceded = [
    { prompt: 'task-z: an unrelated predecessor', opts: dispatchX[0].opts },
    sharedPrompt,
  ];
  const journal2 = new WorkflowJournalFile(path.join(workDir, 'journal-b.jsonl'));
  const soloRun = await runChain({
    dispatches: chainSolo,
    journal: journal2,
    dispatchFn: makeCleanDispatch(effectsFile),
    argsSeed,
  });
  const soloKey = soloRun.perIndex[0]?.key;
  const replay2 = await journal2.load();
  const precededRun = await runChain({
    dispatches: chainPreceded,
    journal: journal2,
    dispatchFn: makeCleanDispatch(effectsFile),
    replay: replay2,
    argsSeed,
  });
  const precededKeyForSharedPrompt = precededRun.perIndex[1]?.key;
  if (precededKeyForSharedPrompt === soloKey) {
    problems.push('identical prompt text at a different chain position must derive a different key (position binding failed)');
  }
  if (precededRun.perIndex[1]?.outcome !== 'redispatched') {
    problems.push(`the shared-text dispatch at the new position must redispatch fresh, not reuse the solo run's stale result, got ${precededRun.perIndex[1]?.outcome}`);
  }

  return {
    name: 'stale_result_reuse_refused',
    description:
      "A committed result must not authorize or satisfy a DIFFERENT " +
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
  const results = [];
  for (const scenarioFn of SCENARIOS) {
    const dir = await mkdtemp(path.join(os.tmpdir(), WORKSPACE_PREFIX));
    try {
      assertDisposableWorkspace(dir);
      const result = await scenarioFn(dir);
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
    schemaVersion: 1,
    exercise: 'm2-fault-recovery-exercise',
    isolation: {
      tmpRoot: os.tmpdir(),
      workspacePrefix: WORKSPACE_PREFIX,
      guaranteedByAssertDisposableWorkspace: true,
      cleanedUp: !keep,
    },
    unexercised:
      "workflow-stall.ts's stall watchdog is not exercised (see file header " +
      '"WHAT THIS SCRIPT DID NOT AND COULD NOT EXERCISE").',
    scenarios: results.map((r) => ({
      name: r.name,
      description: r.description,
      category: r.category,
      pass: r.pass,
      reason: r.reason,
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
