/**
 * Self-tests for scripts/m2-fault-recovery.mjs.
 *
 * Runs entirely in-process, with NO subprocess spawning, NO model, and NO
 * GPU, and touches no real disk space beyond a few small files under a
 * disposable mkdtemp workspace: `makeFaultInjectedJournal` manufactures its
 * ENOSPC error at the call boundary and never calls into the real journal
 * when it fires, and the backend-failure stubs are plain async functions.
 * These tests pin the fault-injection primitives, the script builders, and
 * the build-freshness guard against SYNTHETIC state (a fake in-memory
 * journal, synthetic temp source/dist trees) so they do not depend on
 * `apps/cli/packages/core/dist` being fresh.
 *
 * One additional, ADAPTIVE integration test calls the real
 * `checkBuildFreshness()` (default, real repo paths) and, only if it
 * reports fresh, runs one real scenario end to end against the actual
 * compiled orchestrator; if the build is currently stale, that test SKIPS
 * with an explicit reason instead of failing.
 *
 * Run with: node --test scripts/m2-fault-recovery.test.mjs
 *
 * The full exercise (all six fault scenarios, against the real compiled
 * runtime, with the honest exit code for any reproduced Gate 2 gap) is
 * `node scripts/m2-fault-recovery.mjs` itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  assertDisposableWorkspace,
  runEffect,
  readEffectCounts,
  makeFaultInjectedJournal,
  makeCleanDispatch,
  makeCleanBackendFailure,
  makeDirtyBackendFailure,
  withTimeout,
  buildSequentialScript,
  buildTryCatchScript,
  checkBuildFreshness,
  loadRuntimeModules,
  StaleBuildError,
} from './m2-fault-recovery.mjs';

const WORKSPACE_PREFIX = 'lal-m2-fault-recovery-';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), WORKSPACE_PREFIX));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const OPTS = { model: 'stub-model-v1', agentType: 'exercise' };

// ---------------------------------------------------------------------------
// Isolation guard
// ---------------------------------------------------------------------------

test('assertDisposableWorkspace: accepts a real mkdtemp path under the OS temp root with our prefix', async () => {
  await withTempDir(async (dir) => {
    assert.doesNotThrow(() => assertDisposableWorkspace(dir));
  });
});

test('assertDisposableWorkspace: refuses a path inside the repository', () => {
  assert.throws(() => assertDisposableWorkspace(process.cwd()));
});

test("assertDisposableWorkspace: refuses a path under ~/.lal", () => {
  assert.throws(() => assertDisposableWorkspace(path.join(os.homedir(), '.lal')));
});

test("assertDisposableWorkspace: refuses a tmp-root path lacking this exercise's own prefix", () => {
  assert.throws(() => assertDisposableWorkspace(path.join(os.tmpdir(), 'some-other-tool-dir')));
});

test('assertDisposableWorkspace: refuses a path outside the OS temp root entirely', () => {
  assert.throws(() => assertDisposableWorkspace('/var/lib/some-service'));
});

// ---------------------------------------------------------------------------
// runEffect: the durable, on-disk, per-dispatch action counter
// ---------------------------------------------------------------------------

test('runEffect: increments a durable per-id counter; independent ids do not interfere', async () => {
  await withTempDir(async (dir) => {
    const effectsFile = path.join(dir, 'effects.json');
    assert.equal(await runEffect(effectsFile, 'k1'), 1);
    assert.equal(await runEffect(effectsFile, 'k1'), 2);
    assert.equal(await runEffect(effectsFile, 'k2'), 1);
    assert.deepEqual(await readEffectCounts(effectsFile), { k1: 2, k2: 1 });
  });
});

test('readEffectCounts: returns {} when the file does not exist yet', async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await readEffectCounts(path.join(dir, 'never-written.json')), {});
  });
});

// ---------------------------------------------------------------------------
// makeFaultInjectedJournal: manufactures ENOSPC at the call boundary,
// against a FAKE in-memory journal so real disk is never touched and no
// build is required.
// ---------------------------------------------------------------------------

function makeFakeJournal() {
  const entries = [];
  let appendCalls = 0;
  return {
    entries,
    get appendCalls() {
      return appendCalls;
    },
    load: async () => ({ entries: entries.slice() }),
    append: async (entry) => {
      appendCalls++;
      entries.push(entry);
    },
  };
}

test('makeFaultInjectedJournal: predicate firing throws ENOSPC and never calls the real append', async () => {
  const fake = makeFakeJournal();
  const journal = makeFaultInjectedJournal(fake, (_entry, idx) => idx === 0);
  await assert.rejects(
    () => journal.append({ type: 'started', key: 'k1', agentId: '1' }),
    (err) => {
      assert.equal(err.code, 'ENOSPC');
      assert.match(err.message, /ENOSPC/);
      return true;
    },
  );
  assert.equal(fake.appendCalls, 0, 'the real append must never be called when the predicate fires');
});

test('makeFaultInjectedJournal: calls before the predicate fires pass through to the real append', async () => {
  const fake = makeFakeJournal();
  const journal = makeFaultInjectedJournal(fake, (_entry, idx) => idx === 1);
  await journal.append({ type: 'started', key: 'k1', agentId: '1' });
  assert.equal(fake.appendCalls, 1);
  await assert.rejects(() => journal.append({ type: 'effect_complete', key: 'k1', agentId: '1' }));
  assert.equal(fake.appendCalls, 1, 'the failing call itself must not reach the real append either');
  await journal.append({ type: 'result', key: 'k1', agentId: '1', result: 1 });
  assert.equal(fake.appendCalls, 2, 'a later, non-failing call index must still pass through');
});

test('makeFaultInjectedJournal: load() delegates to the wrapped journal', async () => {
  const fake = makeFakeJournal();
  await fake.append({ type: 'started', key: 'k1', agentId: '1' });
  const journal = makeFaultInjectedJournal(fake, () => false);
  const replay = await journal.load();
  assert.equal(replay.entries.length, 1);
});

// ---------------------------------------------------------------------------
// Dispatch stub factories
// ---------------------------------------------------------------------------

test('makeCleanDispatch: runs the durable effect and never throws', async () => {
  await withTempDir(async (dir) => {
    const effectsFile = path.join(dir, 'effects.json');
    const dispatch = makeCleanDispatch(effectsFile);
    const r1 = await dispatch('prompt-a');
    const r2 = await dispatch('prompt-a');
    assert.equal(r1.count, 1);
    assert.equal(r2.count, 2);
  });
});

test('makeCleanBackendFailure: always rejects with ECONNRESET and never runs any effect', async () => {
  const dispatch = makeCleanBackendFailure();
  await assert.rejects(() => dispatch('prompt-a'), (err) => {
    assert.equal(err.code, 'ECONNRESET');
    return true;
  });
});

test('makeDirtyBackendFailure: runs the effect THEN rejects with ECONNRESET', async () => {
  await withTempDir(async (dir) => {
    const effectsFile = path.join(dir, 'effects.json');
    const dispatch = makeDirtyBackendFailure(effectsFile);
    await assert.rejects(() => dispatch('prompt-a'), (err) => {
      assert.equal(err.code, 'ECONNRESET');
      return true;
    });
    const counts = await readEffectCounts(effectsFile);
    assert.equal(counts['prompt-a'], 1, 'the effect must have run once, durably, before the rejection');
  });
});

test('withTimeout: rejects a silently-hanging promise instead of hanging the harness', async () => {
  const neverSettles = new Promise(() => {});
  await assert.rejects(() => withTimeout(neverSettles, 20, 'test-op'), (err) => {
    assert.equal(err.code, 'ETIMEDOUT');
    return true;
  });
});

test('withTimeout: a promise that settles first wins', async () => {
  const result = await withTimeout(Promise.resolve('ok'), 500, 'test-op');
  assert.equal(result, 'ok');
});

// ---------------------------------------------------------------------------
// Sandboxed script builders
// ---------------------------------------------------------------------------

const DISPATCHES = [
  { prompt: 'p-a', opts: OPTS },
  { prompt: 'p-b', opts: OPTS },
];

test('buildSequentialScript: emits N agent() calls in order and returns them as an array', () => {
  const script = buildSequentialScript(DISPATCHES);
  assert.equal(script.split('await agent(').length - 1, 2);
  assert.ok(script.indexOf('"p-a"') < script.indexOf('"p-b"'));
  assert.match(script, /return \[r0, r1\];/);
});

test('buildTryCatchScript: wraps each agent() call in its own try/catch and always returns', () => {
  const script = buildTryCatchScript(DISPATCHES);
  assert.equal((script.match(/try {/g) || []).length, 2);
  assert.equal((script.match(/catch \(e\)/g) || []).length, 2);
  assert.match(script, /return outcomes;/);
});

// ---------------------------------------------------------------------------
// checkBuildFreshness: the guard itself, against synthetic temp trees.
// ---------------------------------------------------------------------------

async function withSyntheticTrees(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), WORKSPACE_PREFIX));
  try {
    const srcDir = path.join(root, 'src');
    const distDir = path.join(root, 'dist');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    await fn({ root, srcDir, distDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writeWithMtime(filePath, contents, mtimeMs) {
  fs.writeFileSync(filePath, contents);
  const t = mtimeMs / 1000;
  fs.utimesSync(filePath, t, t);
}

test('checkBuildFreshness: fresh when dist is newer than src', async () => {
  await withSyntheticTrees(async ({ srcDir, distDir }) => {
    const now = Date.now();
    writeWithMtime(path.join(srcDir, 'a.ts'), 'x', now);
    writeWithMtime(path.join(distDir, 'a.js'), 'x', now + 60_000);
    const result = checkBuildFreshness(srcDir, distDir, []);
    assert.equal(result.fresh, true);
  });
});

test('checkBuildFreshness: stale when src changed after the dist build', async () => {
  await withSyntheticTrees(async ({ srcDir, distDir }) => {
    const now = Date.now();
    writeWithMtime(path.join(distDir, 'a.js'), 'x', now);
    writeWithMtime(path.join(srcDir, 'a.ts'), 'x', now + 60_000);
    const result = checkBuildFreshness(srcDir, distDir, []);
    assert.equal(result.fresh, false);
    assert.equal(result.staleFiles[0].reason, 'source-newer-than-build');
  });
});

test('checkBuildFreshness: missing-compiled-artifact when the dist file is absent', async () => {
  await withSyntheticTrees(async ({ srcDir, distDir }) => {
    writeWithMtime(path.join(srcDir, 'a.ts'), 'x', Date.now());
    const result = checkBuildFreshness(srcDir, distDir, []);
    assert.equal(result.staleFiles[0].reason, 'missing-compiled-artifact');
  });
});

test('checkBuildFreshness: a missing src directory is a dirError, not a silent "fresh"', () => {
  const result = checkBuildFreshness('/definitely/does/not/exist/lal-m2', '/also/missing', []);
  assert.equal(result.fresh, false);
  assert.ok(result.dirError);
});

// ---------------------------------------------------------------------------
// Adaptive integration test.
// ---------------------------------------------------------------------------

test('loadRuntimeModules: against the real repo, either a fresh-build live scenario run or an explicit stale-build skip -- never a silent pass or a false failure', async (t) => {
  const freshness = checkBuildFreshness();
  if (!freshness.fresh) {
    t.skip(
      `apps/cli/packages/core/dist is currently stale relative to its src ` +
        `(${freshness.staleFiles.map((f) => path.basename(f.srcPath)).join(', ')}); ` +
        `loadRuntimeModules() is expected to throw StaleBuildError, which is exactly ` +
        `what node scripts/m2-fault-recovery.mjs observes right now (exit code 3). ` +
        `Skipping the live scenario run rather than failing or silently passing.`,
    );
    await assert.rejects(() => loadRuntimeModules(), StaleBuildError);
    return;
  }
  const modules = await loadRuntimeModules();
  await withTempDir(async (dir) => {
    const journalPath = path.join(dir, 'journal.jsonl');
    const journal = new modules.WorkflowJournal(journalPath);
    const orchestrator = new modules.WorkflowOrchestrator(async () => 'live-ok');
    const outcome = await orchestrator.run({
      script: 'return await agent("smoke test");',
      args: { smoke: true },
      journal,
    });
    assert.equal(outcome.result, 'live-ok');
  });
});
