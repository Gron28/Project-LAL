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
 * A real workflow durability fix just landed in
 *   apps/cli/packages/core/src/agents/runtime/workflow-journal.ts
 *   apps/cli/packages/core/src/agents/runtime/workflow-orchestrator.ts
 * adding a THIRD journal entry type, `effect_complete`, written after a
 * dispatch's side effect resolves but before its `result` is committed. On
 * resume, a key with `effect_complete` and no matching `result` is an
 * ambiguous crash window: the effect (arbitrary write_file/shell activity)
 * is known to have run at least once, so blindly re-dispatching it would
 * silently repeat a non-idempotent action. The orchestrator refuses instead
 * (`WorkflowAmbiguousEffectError`).
 *
 * This script exercises that exact contract end to end: it spawns a REAL
 * child Node process that plays out a deterministic sequence of "dispatches"
 * against a real on-disk journal (JSONL, fsync'd per line, same shape as
 * production: `started` / `effect_complete` / `result`), pauses it at a
 * chosen fault boundary, and SIGKILLs it — a genuine OS-level interruption,
 * not a simulated one. It then spawns a second child process that loads the
 * journal and reconciles it, and grades the outcome against a durable,
 * on-disk, per-key action counter (not an in-memory call count) so a
 * duplicated side effect cannot be missed.
 *
 * WHY THE JOURNAL/KEY LOGIC IS RE-IMPLEMENTED HERE RATHER THAN IMPORTED
 * `workflow-journal.ts` (and the wider apps/cli tree) is owned by other
 * concurrent workers and is not on this worker's file authority; its
 * compiled `dist/` output is a moving build artifact of that work, not a
 * stable dependency to import from a script that must keep working
 * unattended. `canonicalizeAgentOpts` / `deriveAgentKey` / `deriveArgsSeed` /
 * `buildReplay` below are byte-for-byte ports of the algorithm documented in
 * that file (same hash construction, same field projection, same replay
 * rules) so the keys and ambiguity classification this script computes are
 * identical to what the real orchestrator would compute for the same
 * inputs. Self-tests pin the documented properties (determinism, prefix
 * chaining, cosmetic-opt invariance, ambiguous-window detection) so drift
 * from the real file would be caught by *reading* it again, even though
 * this script does not import it.
 *
 * ISOLATION GUARANTEE
 * Every filesystem write happens under a directory this script creates
 * itself with `fs.mkdtemp(os.tmpdir() + '/lal-m1-recovery-')`, and every
 * write path is additionally checked by `assertDisposableWorkspace()`
 * before use: it must resolve under the OS temp root, carry this script's
 * own random prefix, and must NOT resolve under the repo root or under
 * `~/.lal`. The check runs in both the controller and every child process
 * (defense in depth — a bug in one layer doesn't remove the other), is
 * unit-tested in m1-recovery-exercise.test.mjs, and the workspace is
 * `fs.rm(..., {recursive:true, force:true})`-cleaned in a `finally` after
 * every scenario unless `--keep` is passed. Nothing under the real repo,
 * `~/.lal`, or any runtime database is ever opened, read, or written.
 *
 * FAULT BOUNDARIES EXERCISED (see SCENARIOS below)
 *   before_intent   - kill before the `started` entry for a dispatch is
 *                      written. Journal has nothing for that key.
 *   after_intent    - kill after `started` is written but before the effect
 *                      runs. Journal has `started` only.
 *   ambiguous       - kill after `effect_complete` is durably written but
 *                      before `result`. This is the newly-fixed window.
 *   after_result    - kill after `result` is committed. Fully durable.
 *   baseline        - no interruption; a full run followed by a resume,
 *                      proving a resume of an already-complete run replays
 *                      every dispatch from cache with zero live effects.
 *
 * OUTCOME VOCABULARY (reported per scenario and overall)
 *   recovered         - committed work was reused from cache, or an
 *                        unfinished intent was safely re-dispatched exactly
 *                        once. This is a PASS.
 *   refused-ambiguous - the ambiguous window was detected and the
 *                        orchestrator-equivalent reconciliation refused to
 *                        re-run the effect. This is a PASS of the safety
 *                        contract, not a failure.
 *   blocked           - the harness itself could not complete the exercise
 *                        (spawn failure, isolation guard tripped, timed out
 *                        waiting for a hold marker, unexpected exit). Not a
 *                        verdict on the product.
 *   failed            - a genuine contract violation: a non-idempotent
 *                        effect ran more than once for one key, an
 *                        ambiguous window was NOT refused, or committed
 *                        work was silently re-executed. Grading always
 *                        cross-checks the durable on-disk action counter
 *                        independently of what a resumed child self-reports,
 *                        so a resumed child claiming success cannot turn a
 *                        real duplicate into a reported pass.
 *
 * RESIDUAL LIMITATION (irreducible, not exercised, documented per the task)
 * There is a strictly narrower window than the one this script tests: a
 * crash strictly BETWEEN the effect resolving and the `effect_complete`
 * append being ISSUED (or a crash during that append's own write/fsync).
 * In that window the journal contains only `started`, indistinguishable
 * from "effect never ran", so resume/reconciliation will re-dispatch and
 * can duplicate the effect. This is a real, currently-uncovered gap in the
 * production contract (see workflow-orchestrator.ts's comment on
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
 * itself was blocked (no verdict reached).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const WORKSPACE_PREFIX = 'lal-m1-recovery-';
const HOLD_TIMEOUT_MS = 8000;
const HOLD_SLEEP_MS = 8000;

// ---------------------------------------------------------------------------
// Journal contract: byte-for-byte port of workflow-journal.ts's algorithm.
// See the file header above for why this is a port rather than an import.
// ---------------------------------------------------------------------------

export const JOURNAL_KEY_VERSION = 'v2';

/** Mirrors workflow-journal.ts `canonicalizeAgentOpts`. */
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

/** Mirrors workflow-journal.ts `deriveAgentKey`. */
export function deriveAgentKey(prefixHash, prompt, opts) {
  const hash = createHash('sha256');
  hash.update(prefixHash);
  hash.update('\0');
  hash.update(prompt);
  hash.update('\0');
  hash.update(canonicalizeAgentOpts(opts));
  return `${JOURNAL_KEY_VERSION}:${hash.digest('hex')}`;
}

/** Mirrors workflow-journal.ts `deriveArgsSeed`. */
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

/** Mirrors workflow-journal.ts `buildReplay`. */
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
 * mirroring jsonl-utils.ts's `writeLineSync`/`writeLine`, so a `kill -9`
 * cannot leave a torn write on disk — the durability property this whole
 * exercise depends on to make "committed" a meaningful, on-disk fact rather
 * than an in-memory one.
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

// ---------------------------------------------------------------------------
// Isolation guard
// ---------------------------------------------------------------------------

/**
 * Refuses to operate anywhere except a directory this script created itself
 * under the OS temp root, carrying this script's own random prefix. Throws
 * on any other path. Called before any read/write in both the controller
 * and every child process.
 */
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
// The disposable "workflow" under exercise: a deterministic sequence of
// fake dispatches, each with a non-idempotent "effect" that increments a
// durable, on-disk, per-key counter (the "persisted action counter"
// ACCEPTANCE.md asks for, not a mock/in-memory dispatch count).
// ---------------------------------------------------------------------------

const ARGS_SEED = { exercise: 'm1-recovery', version: 1 };

const DISPATCHES = [
  {
    prompt: 'exercise-dispatch-alpha: pretend to write file A',
    opts: { model: 'stub-model-v1', isolation: 'none', agentType: 'exercise', label: 'alpha' },
  },
  {
    prompt: 'exercise-dispatch-beta: pretend to write file B',
    opts: { model: 'stub-model-v1', isolation: 'none', agentType: 'exercise', label: 'beta' },
  },
  {
    prompt: 'exercise-dispatch-gamma: pretend to write file C',
    opts: { model: 'stub-model-v1', isolation: 'none', agentType: 'exercise', label: 'gamma' },
  },
];

/**
 * The fake, non-idempotent "side effect". Durable (fsync'd) read-modify-
 * write of a per-key counter in `effects.json`. Never called by the resume
 * path for a key that is cached or ambiguous — that is exactly the
 * property under test.
 */
export async function runEffect(effectsFile, key) {
  let counts = {};
  try {
    counts = JSON.parse(await readFile(effectsFile, 'utf8'));
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  counts[key] = (counts[key] ?? 0) + 1;
  await fs.promises.writeFile(effectsFile, JSON.stringify(counts), { flush: true });
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
 * Plays out DISPATCHES in order against `journal`, pausing (printing a
 * `HOLD ...` marker line and sleeping) at the (stage, index) pair matching
 * `holdStage`/`holdIndex`, if any. Used both by the real child-process run
 * (where the controller SIGKILLs during the pause) and importable directly
 * by nothing else — the real interruption always goes through a spawned
 * process so the "kill" is a genuine OS-level event.
 */
export async function playDispatches({ journal, effectsFile, holdStage, holdIndex, onHold }) {
  let prefixHash = deriveArgsSeed(ARGS_SEED);
  for (let i = 0; i < DISPATCHES.length; i++) {
    const { prompt, opts } = DISPATCHES[i];
    const key = deriveAgentKey(prefixHash, prompt, opts);
    prefixHash = key;
    const agentId = String(i + 1);

    await hold('pre_started', i, key);
    await journal.append({ type: 'started', key, agentId });

    await hold('post_started', i, key);
    await runEffect(effectsFile, key);

    await hold('post_effect', i, key);
    await journal.append({ type: 'effect_complete', key, agentId });

    await hold('post_effect_complete', i, key);
    await journal.append({ type: 'result', key, agentId, result: { ok: true, prompt } });

    await hold('post_result', i, key);
  }

  async function hold(stage, index, key) {
    if (stage === holdStage && index === holdIndex) {
      await onHold?.(stage, index, key);
    }
  }
}

/**
 * Reconciles a resumed run against `replay`: for each dispatch in order,
 * refuses on an ambiguous key (and stops, mirroring the real orchestrator
 * throwing `WorkflowAmbiguousEffectError` and aborting the whole run),
 * reuses a cached result without touching the effect, or treats a miss
 * (nothing journaled, or `started` with no `effect_complete`) as an
 * ordinary unfinished intent and re-dispatches it live exactly once.
 *
 * This is the function the self-tests exercise directly with synthetic
 * `replay` objects and a stub effect (no subprocess, no model, no GPU).
 */
export async function resumeAndReconcile(replay, { journal, effectsFile }) {
  let prefixHash = deriveArgsSeed(ARGS_SEED);
  const perIndex = [];
  for (let i = 0; i < DISPATCHES.length; i++) {
    const { prompt, opts } = DISPATCHES[i];
    const key = deriveAgentKey(prefixHash, prompt, opts);
    prefixHash = key;
    const agentId = String(i + 1);

    if (replay.ambiguousEffects.has(key)) {
      perIndex.push({ index: i, key, outcome: 'refused-ambiguous' });
      return { perIndex, aborted: true, abortedAtIndex: i };
    }

    const cached = replay.results.get(key);
    if (cached !== undefined) {
      perIndex.push({ index: i, key, outcome: 'recovered-cached' });
      continue;
    }

    // Ordinary miss: nothing journaled, or `started` with no
    // `effect_complete` — the effect is known NOT to have completed, so
    // re-dispatching is safe.
    await journal.append({ type: 'started', key, agentId });
    await runEffect(effectsFile, key);
    await journal.append({ type: 'effect_complete', key, agentId });
    await journal.append({ type: 'result', key, agentId, result: { ok: true, prompt, resumed: true } });
    perIndex.push({ index: i, key, outcome: 'redispatched' });
  }
  return { perIndex, aborted: false, abortedAtIndex: null };
}

// ---------------------------------------------------------------------------
// Child-process entry points
// ---------------------------------------------------------------------------

async function childRun(workspaceDir, holdStage, holdIndex) {
  assertDisposableWorkspace(workspaceDir);
  const journal = new WorkflowJournalFile(path.join(workspaceDir, 'workflows', 'exercise-run', 'journal.jsonl'));
  const effectsFile = path.join(workspaceDir, 'effects.json');
  await playDispatches({
    journal,
    effectsFile,
    holdStage,
    holdIndex,
    onHold: async (stage, index, key) => {
      // Printed then a long sleep: the controller SIGKILLs us during this
      // window. If nobody kills us (shouldn't happen in real use, but keeps
      // this script from hanging forever if invoked oddly by hand) we
      // resume and finish, which just makes the exercise look like the
      // baseline scenario.
      console.log(`HOLD stage=${stage} index=${index} key=${key} pid=${process.pid}`);
      await new Promise((r) => setTimeout(r, HOLD_SLEEP_MS));
    },
  });
  console.log('CHILD_RUN_COMPLETE');
}

async function childResume(workspaceDir) {
  assertDisposableWorkspace(workspaceDir);
  const journal = new WorkflowJournalFile(path.join(workspaceDir, 'workflows', 'exercise-run', 'journal.jsonl'));
  const effectsFile = path.join(workspaceDir, 'effects.json');
  const replay = await journal.load();
  const outcome = await resumeAndReconcile(replay, { journal, effectsFile });
  console.log(`RESUME_RESULT ${JSON.stringify(outcome)}`);
}

// ---------------------------------------------------------------------------
// Controller: spawns real child processes, performs a real SIGKILL at the
// chosen fault boundary, spawns the resume, and grades the result against
// the durable effect counters.
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
          Object.assign(
            new Error(`child exited code=${code} signal=${signal}\n--- stderr ---\n${errOut}`),
            { blocked: true },
          ),
        );
    });
  });
}

function runChildAndKillAtHold(args, holdStage, holdIndex) {
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
          new Error(`timed out waiting for HOLD stage=${holdStage} index=${holdIndex}`),
          { blocked: true },
        ),
      );
    }, HOLD_TIMEOUT_MS);

    rl.on('line', (line) => {
      if (settled) return;
      if (line.startsWith('HOLD ') && line.includes(`stage=${holdStage}`) && line.includes(`index=${holdIndex}`)) {
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

async function runScenario(def, { keep }) {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), WORKSPACE_PREFIX));
  try {
    assertDisposableWorkspace(workspaceDir);
    const effectsFile = path.join(workspaceDir, 'effects.json');
    let killEvidence = null;

    if (def.holdStage) {
      const { holdLine, exitCode, exitSignal } = await runChildAndKillAtHold(
        ['--child-run', '--workspace', workspaceDir, '--hold-stage', def.holdStage, '--hold-index', String(def.holdIndex)],
        def.holdStage,
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
      const { stdout } = await runChildToCompletion(['--child-run', '--workspace', workspaceDir, '--hold-stage', 'none', '--hold-index', '-1']);
      if (!stdout.includes('CHILD_RUN_COMPLETE')) {
        return { name: def.name, category: 'blocked', pass: false, reason: `baseline run did not report completion: ${stdout}` };
      }
    }

    const { stdout: resumeStdout } = await runChildToCompletion(['--child-resume', '--workspace', workspaceDir]);
    const resumeLine = resumeStdout.split('\n').find((l) => l.startsWith('RESUME_RESULT '));
    if (!resumeLine) {
      return { name: def.name, category: 'blocked', pass: false, reason: `no RESUME_RESULT line in resume output: ${resumeStdout}` };
    }
    const resumeJson = JSON.parse(resumeLine.slice('RESUME_RESULT '.length));
    const counts = await readEffectCounts(effectsFile);

    const verdict = def.check({ resumeJson, counts });
    return { name: def.name, killEvidence, resumeJson, counts, ...verdict };
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

/** Finds `perIndex[index].key` and looks it up in `counts`; 0 if absent. */
function countAt(resumeJson, counts, index) {
  const entry = resumeJson.perIndex[index];
  if (!entry) return undefined;
  return counts[entry.key] ?? 0;
}

const SCENARIOS = [
  {
    name: 'before_intent',
    holdStage: 'pre_started',
    holdIndex: 1,
    description: "kill before dispatch #2's `started` entry is written; nothing journaled for it yet.",
    check: ({ resumeJson, counts }) => {
      const problems = [];
      if (resumeJson.aborted) problems.push('resume aborted but no key should be ambiguous');
      if (resumeJson.perIndex[0]?.outcome !== 'recovered-cached') problems.push('index0 should be recovered from cache');
      if (resumeJson.perIndex[1]?.outcome !== 'redispatched') problems.push('index1 (crashed before intent) should be redispatched');
      if (countAt(resumeJson, counts, 0) !== 1) problems.push(`index0 effect count should stay 1, got ${countAt(resumeJson, counts, 0)}`);
      if (countAt(resumeJson, counts, 1) !== 1) problems.push(`index1 effect should run exactly once on resume, got ${countAt(resumeJson, counts, 1)}`);
      return problems.length ? { category: 'failed', pass: false, reason: problems.join('; ') } : { category: 'recovered', pass: true };
    },
  },
  {
    name: 'after_intent',
    holdStage: 'post_started',
    holdIndex: 1,
    description: "kill after dispatch #2's `started` entry is written but before its effect runs.",
    check: ({ resumeJson, counts }) => {
      const problems = [];
      if (resumeJson.aborted) problems.push('resume aborted but no key should be ambiguous');
      if (resumeJson.perIndex[0]?.outcome !== 'recovered-cached') problems.push('index0 should be recovered from cache');
      if (resumeJson.perIndex[1]?.outcome !== 'redispatched') problems.push('index1 (started only, effect never ran) should be redispatched');
      if (countAt(resumeJson, counts, 0) !== 1) problems.push(`index0 effect count should stay 1, got ${countAt(resumeJson, counts, 0)}`);
      if (countAt(resumeJson, counts, 1) !== 1) problems.push(`index1 effect should run exactly once total, got ${countAt(resumeJson, counts, 1)}`);
      return problems.length ? { category: 'failed', pass: false, reason: problems.join('; ') } : { category: 'recovered', pass: true };
    },
  },
  {
    name: 'ambiguous_after_effect_before_result',
    holdStage: 'post_effect_complete',
    holdIndex: 1,
    description: "kill after dispatch #2's effect completed AND `effect_complete` is durably written, but before `result`. The fixed ambiguous window.",
    check: ({ resumeJson, counts }) => {
      const problems = [];
      if (!resumeJson.aborted || resumeJson.abortedAtIndex !== 1) problems.push('resume should abort at index1 on the ambiguous key');
      if (resumeJson.perIndex[1]?.outcome !== 'refused-ambiguous') problems.push('index1 should be refused-ambiguous');
      if (resumeJson.perIndex.length !== 2) problems.push('index2 should never be reached once index1 is refused');
      if (countAt(resumeJson, counts, 1) !== 1) problems.push(`index1 effect must NOT re-run: expected count 1, got ${countAt(resumeJson, counts, 1)}`);
      return problems.length ? { category: 'failed', pass: false, reason: problems.join('; ') } : { category: 'refused-ambiguous', pass: true };
    },
  },
  {
    name: 'after_result',
    holdStage: 'post_result',
    holdIndex: 1,
    description: "kill after dispatch #2's `result` is committed; both index0 and index1 are fully durable, index2 is untouched.",
    check: ({ resumeJson, counts }) => {
      const problems = [];
      if (resumeJson.aborted) problems.push('resume aborted but no key should be ambiguous');
      if (resumeJson.perIndex[0]?.outcome !== 'recovered-cached') problems.push('index0 should be recovered from cache');
      if (resumeJson.perIndex[1]?.outcome !== 'recovered-cached') problems.push('index1 should be recovered from cache (fully committed pre-crash)');
      if (resumeJson.perIndex[2]?.outcome !== 'redispatched') problems.push('index2 (never started) should be redispatched');
      if (countAt(resumeJson, counts, 0) !== 1) problems.push(`index0 effect count should stay 1, got ${countAt(resumeJson, counts, 0)}`);
      if (countAt(resumeJson, counts, 1) !== 1) problems.push(`index1 effect must NOT re-run: expected count 1, got ${countAt(resumeJson, counts, 1)}`);
      if (countAt(resumeJson, counts, 2) !== 1) problems.push(`index2 effect should run exactly once, got ${countAt(resumeJson, counts, 2)}`);
      return problems.length ? { category: 'failed', pass: false, reason: problems.join('; ') } : { category: 'recovered', pass: true };
    },
  },
  {
    name: 'baseline_no_interruption',
    holdStage: null,
    holdIndex: null,
    description: 'no crash: a full run to completion, then a resume, proving an already-complete run replays entirely from cache with zero live effects.',
    check: ({ resumeJson, counts }) => {
      const problems = [];
      if (resumeJson.aborted) problems.push('resume aborted but nothing should be ambiguous');
      for (let i = 0; i < 3; i++) {
        if (resumeJson.perIndex[i]?.outcome !== 'recovered-cached') problems.push(`index${i} should be recovered from cache`);
        if (countAt(resumeJson, counts, i) !== 1) problems.push(`index${i} effect count should stay 1, got ${countAt(resumeJson, counts, i)}`);
      }
      return problems.length ? { category: 'failed', pass: false, reason: problems.join('; ') } : { category: 'recovered', pass: true };
    },
  },
];

async function mainExercise({ keep }) {
  const results = [];
  for (const def of SCENARIOS) {
    const result = await runScenario(def, { keep });
    results.push({ ...result, description: def.description });
  }

  const anyFailed = results.some((r) => r.category === 'failed');
  const anyBlocked = results.some((r) => r.category === 'blocked');
  const overall = anyFailed ? 'fail' : anyBlocked ? 'blocked' : 'pass';

  const summary = {
    schemaVersion: 1,
    exercise: 'm1-recovery-exercise',
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
      resumeJson: r.resumeJson,
      counts: r.counts,
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
    childRun(args.workspace, args['hold-stage'], Number(args['hold-index'])).catch((err) => {
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
