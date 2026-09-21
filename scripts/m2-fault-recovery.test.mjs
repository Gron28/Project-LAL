/**
 * Self-tests for scripts/m2-fault-recovery.mjs.
 *
 * Runs entirely in-process, with NO subprocess spawning, NO model, and NO
 * GPU, and touches no real disk space beyond a few small files under a
 * disposable mkdtemp workspace: `FaultInjectedJournal` manufactures its
 * ENOSPC error at the call boundary and never calls into `fs` when it
 * fires, and the backend-failure stubs are plain async functions.
 *
 * Run with: node --test scripts/m2-fault-recovery.test.mjs
 *
 * The full exercise (all six fault scenarios, with the honest FAIL exit
 * code for the two reproduced Gate 2 gaps) is
 * `node scripts/m2-fault-recovery.mjs` itself — these unit tests instead
 * pin the primitives and `runChain`'s documented behavior in isolation so a
 * regression in the port (not the scenarios) is caught quickly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';

import {
  canonicalizeAgentOpts,
  deriveAgentKey,
  deriveArgsSeed,
  buildReplay,
  WorkflowJournalFile,
  FaultInjectedJournal,
  assertDisposableWorkspace,
  runEffect,
  readEffectCounts,
  withTimeout,
  runChain,
  makeCleanDispatch,
  makeCleanBackendFailure,
  makeDirtyBackendFailure,
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

const OPTS = { model: 'stub-model-v1', isolation: 'none', agentType: 'exercise' };

// ---------------------------------------------------------------------------
// Ported primitives (same properties m1-recovery-exercise.test.mjs pins,
// re-verified here for THIS file's independent port).
// ---------------------------------------------------------------------------

test('canonicalizeAgentOpts: only schema/model/isolation/agentType are projected', () => {
  const a = canonicalizeAgentOpts({ ...OPTS, label: 'a', stallMs: 1, phase: 'x' });
  const b = canonicalizeAgentOpts({ ...OPTS, label: 'b', stallMs: 2, phase: 'y' });
  assert.equal(a, b, 'cosmetic/operational fields must not affect the projection');
});

test('canonicalizeAgentOpts: model difference changes the projection', () => {
  const a = canonicalizeAgentOpts({ ...OPTS, model: 'm1' });
  const b = canonicalizeAgentOpts({ ...OPTS, model: 'm2' });
  assert.notEqual(a, b);
});

test('deriveAgentKey: deterministic; different prompt or prefix changes the key', () => {
  const k1 = deriveAgentKey('seed', 'p1', OPTS);
  const k2 = deriveAgentKey('seed', 'p1', OPTS);
  assert.equal(k1, k2);
  assert.match(k1, /^v2:[0-9a-f]{64}$/);
  assert.notEqual(k1, deriveAgentKey('seed', 'p2', OPTS));
  assert.notEqual(k1, deriveAgentKey('seed-other', 'p1', OPTS));
});

test('deriveArgsSeed: deterministic and sensitive to args (the changed-inputs mechanism)', () => {
  const s1 = deriveArgsSeed({ run: 'A' });
  const s2 = deriveArgsSeed({ run: 'A' });
  const s3 = deriveArgsSeed({ run: 'B' });
  assert.equal(s1, s2);
  assert.notEqual(s1, s3);
});

test('buildReplay: started + effect_complete + no result => ambiguous; + result => not ambiguous', () => {
  const ambiguous = buildReplay([
    { type: 'started', key: 'k1', agentId: '1' },
    { type: 'effect_complete', key: 'k1', agentId: '1' },
  ]);
  assert.equal(ambiguous.ambiguousEffects.has('k1'), true);

  const resolved = buildReplay([
    { type: 'started', key: 'k1', agentId: '1' },
    { type: 'effect_complete', key: 'k1', agentId: '1' },
    { type: 'result', key: 'k1', agentId: '1', result: 42 },
  ]);
  assert.equal(resolved.ambiguousEffects.has('k1'), false);
  assert.equal(resolved.results.get('k1').result, 42);
});

test('buildReplay: started-only (no effect_complete) is an ordinary miss, never ambiguous', () => {
  const replay = buildReplay([{ type: 'started', key: 'k1', agentId: '1' }]);
  assert.equal(replay.ambiguousEffects.has('k1'), false);
  assert.equal(replay.results.has('k1'), false);
});

// ---------------------------------------------------------------------------
// Isolation guard
// ---------------------------------------------------------------------------

test('assertDisposableWorkspace: accepts a real mkdtemp path with our prefix', async () => {
  await withTempDir(async (dir) => {
    assert.doesNotThrow(() => assertDisposableWorkspace(dir));
  });
});

test('assertDisposableWorkspace: refuses the repository root and subpaths', () => {
  assert.throws(() => assertDisposableWorkspace(process.cwd()));
  assert.throws(() => assertDisposableWorkspace(path.join(process.cwd(), 'scripts')));
});

test('assertDisposableWorkspace: refuses ~/.lal', () => {
  assert.throws(() => assertDisposableWorkspace(path.join(os.homedir(), '.lal')));
});

test('assertDisposableWorkspace: refuses a tmp-root path lacking this exercise\'s own prefix', () => {
  assert.throws(() => assertDisposableWorkspace(path.join(os.tmpdir(), 'some-other-tool-dir')));
});

test('assertDisposableWorkspace: refuses a path outside the OS temp root entirely', () => {
  assert.throws(() => assertDisposableWorkspace('/var/lib/some-service'));
});

// ---------------------------------------------------------------------------
// runEffect: durable, on-disk, per-key action counter
// ---------------------------------------------------------------------------

test('runEffect: increments a durable per-key counter; independent keys do not interfere', async () => {
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
// FaultInjectedJournal: the ENOSPC-simulation boundary. The critical
// property under test here is that NOTHING is ever written to disk when the
// fault fires — i.e. the injected fault never touches the real filesystem,
// which is how this whole exercise avoids consuming any real disk space.
// ---------------------------------------------------------------------------

test('FaultInjectedJournal: passes through when the predicate is false', async () => {
  await withTempDir(async (dir) => {
    const journal = new FaultInjectedJournal(path.join(dir, 'journal.jsonl'), () => false);
    await journal.append({ type: 'started', key: 'k1', agentId: '1' });
    const replay = await journal.load();
    assert.equal(replay.started.get('k1').length, 1);
  });
});

test('FaultInjectedJournal: throws an ENOSPC-shaped error and writes NOTHING when the predicate fires', async () => {
  await withTempDir(async (dir) => {
    const journalPath = path.join(dir, 'journal.jsonl');
    const journal = new FaultInjectedJournal(journalPath, (_entry, idx) => idx === 0);
    await assert.rejects(
      () => journal.append({ type: 'started', key: 'k1', agentId: '1' }),
      (err) => {
        assert.equal(err.code, 'ENOSPC');
        return true;
      },
    );
    // Nothing was written at all — the file must not even exist.
    await assert.rejects(() => readFile(journalPath, 'utf8'), (err) => err.code === 'ENOENT');
  });
});

test('FaultInjectedJournal: predicate sees an increasing call index, so "fail the Nth call" is expressible', async () => {
  await withTempDir(async (dir) => {
    const journal = new FaultInjectedJournal(path.join(dir, 'journal.jsonl'), (_entry, idx) => idx === 1);
    await journal.append({ type: 'started', key: 'k1', agentId: '1' }); // idx 0, passes
    await assert.rejects(() => journal.append({ type: 'effect_complete', key: 'k1', agentId: '1' })); // idx 1, fails
    const replay = await journal.load();
    assert.equal(replay.started.get('k1').length, 1);
    assert.equal(replay.ambiguousEffects.has('k1'), false, 'the failed effect_complete write must not have landed');
  });
});

// ---------------------------------------------------------------------------
// withTimeout: this harness must never hang on a stub that never settles.
// ---------------------------------------------------------------------------

test('withTimeout: resolves normally when the promise settles in time', async () => {
  const result = await withTimeout(Promise.resolve('ok'), 500, 'test');
  assert.equal(result, 'ok');
});

test('withTimeout: rejects (does not hang) when the promise never settles', async () => {
  const neverSettles = new Promise(() => {});
  await assert.rejects(() => withTimeout(neverSettles, 50, 'test'), (err) => {
    assert.equal(err.code, 'ETIMEDOUT');
    return true;
  });
});

// ---------------------------------------------------------------------------
// runChain: the ported dispatch/persist/latch contract itself.
// ---------------------------------------------------------------------------

test('runChain: a clean run persists started -> effect_complete -> result for every dispatch, effect runs exactly once each', async () => {
  await withTempDir(async (dir) => {
    const effectsFile = path.join(dir, 'effects.json');
    const journal = new WorkflowJournalFile(path.join(dir, 'journal.jsonl'));
    const dispatches = [
      { prompt: 'p1', opts: OPTS },
      { prompt: 'p2', opts: OPTS },
    ];
    const outcome = await runChain({
      dispatches,
      journal,
      dispatchFn: makeCleanDispatch(effectsFile),
      argsSeed: { run: 'x' },
    });
    assert.equal(outcome.aborted, false);
    assert.deepEqual(outcome.perIndex.map((e) => e.outcome), ['redispatched', 'redispatched']);
    const counts = await readEffectCounts(effectsFile);
    for (const e of outcome.perIndex) assert.equal(counts[e.key], 1);
  });
});

test('runChain: a cache hit on resume runs zero live effects', async () => {
  await withTempDir(async (dir) => {
    const effectsFile = path.join(dir, 'effects.json');
    const journal = new WorkflowJournalFile(path.join(dir, 'journal.jsonl'));
    const dispatches = [{ prompt: 'p1', opts: OPTS }];
    await runChain({ dispatches, journal, dispatchFn: makeCleanDispatch(effectsFile), argsSeed: { run: 'x' } });
    const countsAfterFirst = await readEffectCounts(effectsFile);

    const replay = await journal.load();
    const resumed = await runChain({
      dispatches,
      journal,
      dispatchFn: makeCleanDispatch(effectsFile),
      replay,
      argsSeed: { run: 'x' },
    });
    assert.equal(resumed.perIndex[0].outcome, 'recovered-cached');
    const countsAfterResume = await readEffectCounts(effectsFile);
    assert.deepEqual(countsAfterResume, countsAfterFirst, 'a cache hit must not run the effect again');
  });
});

test('runChain: an ambiguous key is refused and aborts the resume immediately, without touching the effect', async () => {
  await withTempDir(async (dir) => {
    const effectsFile = path.join(dir, 'effects.json');
    const journal = new WorkflowJournalFile(path.join(dir, 'journal.jsonl'));
    const dispatches = [{ prompt: 'p1', opts: OPTS }];
    // Discover the real key deterministically, then hand-build an ambiguous
    // replay (started + effect_complete, no result) for it.
    const probe = await runChain({ dispatches, journal: new WorkflowJournalFile(path.join(dir, 'probe.jsonl')), dispatchFn: makeCleanDispatch(path.join(dir, 'probe-effects.json')), argsSeed: { run: 'x' } });
    const key = probe.perIndex[0].key;
    await runEffect(effectsFile, key); // the effect already ran once
    const replay = buildReplay([
      { type: 'started', key, agentId: '1' },
      { type: 'effect_complete', key, agentId: '1' },
    ]);
    const outcome = await runChain({ dispatches, journal, dispatchFn: makeCleanDispatch(effectsFile), replay, argsSeed: { run: 'x' } });
    assert.equal(outcome.aborted, true);
    assert.equal(outcome.abortReason, 'ambiguous-effect');
    assert.equal(outcome.perIndex[0].outcome, 'refused-ambiguous');
    const counts = await readEffectCounts(effectsFile);
    assert.equal(counts[key], 1, 'the ambiguous effect must NOT be re-run');
  });
});

test('runChain: a journal write failure latches for the rest of the run — later dispatches are blocked without their own write or effect', async () => {
  await withTempDir(async (dir) => {
    const effectsFile = path.join(dir, 'effects.json');
    const journal = new FaultInjectedJournal(path.join(dir, 'journal.jsonl'), (_entry, idx) => idx === 0);
    const dispatches = [{ prompt: 'p1', opts: OPTS }, { prompt: 'p2', opts: OPTS }];
    const outcome = await runChain({ dispatches, journal, dispatchFn: makeCleanDispatch(effectsFile), argsSeed: { run: 'x' } });
    assert.equal(outcome.perIndex[0].outcome, 'blocked-journal-write-failed');
    assert.equal(outcome.perIndex[1].outcome, 'blocked-journal-poisoned');
    const counts = await readEffectCounts(effectsFile);
    assert.deepEqual(counts, {}, 'no effect must run once the journal is known unwritable');
  });
});

test('runChain: a clean backend failure (before any effect) leaves the key an ordinary miss, safely redispatched once on retry', async () => {
  await withTempDir(async (dir) => {
    const effectsFile = path.join(dir, 'effects.json');
    const journal = new WorkflowJournalFile(path.join(dir, 'journal.jsonl'));
    const dispatches = [{ prompt: 'p1', opts: OPTS }];
    const failed = await runChain({ dispatches, journal, dispatchFn: makeCleanBackendFailure(), argsSeed: { run: 'x' } });
    assert.equal(failed.perIndex[0].outcome, 'blocked-backend-failed');
    assert.deepEqual(await readEffectCounts(effectsFile), {});

    const replay = await journal.load();
    const retried = await runChain({ dispatches, journal, dispatchFn: makeCleanDispatch(effectsFile), replay, argsSeed: { run: 'x' } });
    assert.equal(retried.perIndex[0].outcome, 'redispatched');
    const counts = await readEffectCounts(effectsFile);
    assert.equal(counts[failed.perIndex[0].key], 1);
  });
});

test('runChain: GATE 2 GAP reproduction — a dirty backend failure (effect ran, then rejected) duplicates the effect on resume', async () => {
  await withTempDir(async (dir) => {
    const effectsFile = path.join(dir, 'effects.json');
    const journal = new WorkflowJournalFile(path.join(dir, 'journal.jsonl'));
    const dispatches = [{ prompt: 'p1', opts: OPTS }];
    const failed = await runChain({ dispatches, journal, dispatchFn: makeDirtyBackendFailure(effectsFile), argsSeed: { run: 'x' } });
    const key = failed.perIndex[0].key;
    assert.equal(failed.perIndex[0].outcome, 'blocked-backend-failed');
    assert.equal((await readEffectCounts(effectsFile))[key], 1, 'the effect already ran once inside the failed attempt');

    const onDisk = await journal.load();
    assert.equal(onDisk.ambiguousEffects.has(key), false, 'no journal entry exists to mark this key ambiguous — that IS the gap');
    assert.equal(onDisk.results.has(key), false);

    const replay = await journal.load();
    const resumed = await runChain({ dispatches, journal, dispatchFn: makeCleanDispatch(effectsFile), replay, argsSeed: { run: 'x' } });
    assert.equal(resumed.perIndex[0].outcome, 'redispatched', 'resume treats it as an ordinary miss, per the gap');
    const finalCount = (await readEffectCounts(effectsFile))[key];
    assert.equal(finalCount, 2, 'REPRODUCED: the non-idempotent effect ran twice with no crash involved');
  });
});

test('runChain: GATE 2 GAP reproduction — an ENOSPC on the effect_complete write duplicates the effect on resume', async () => {
  await withTempDir(async (dir) => {
    const effectsFile = path.join(dir, 'effects.json');
    const journalPath = path.join(dir, 'journal.jsonl');
    const faultyJournal = new FaultInjectedJournal(journalPath, (_entry, idx) => idx === 1); // idx1 = effect_complete
    const dispatches = [{ prompt: 'p1', opts: OPTS }];
    const failed = await runChain({ dispatches, journal: faultyJournal, dispatchFn: makeCleanDispatch(effectsFile), argsSeed: { run: 'x' } });
    const key = failed.perIndex[0].key;
    assert.equal(failed.perIndex[0].outcome, 'blocked-journal-write-failed');
    assert.equal((await readEffectCounts(effectsFile))[key], 1, 'this.dispatch already resolved before the journal write failed');

    const healedJournal = new WorkflowJournalFile(journalPath);
    const replay = await healedJournal.load();
    assert.equal(replay.ambiguousEffects.has(key), false, 'started-only on disk — identical to "never ran"');

    const resumed = await runChain({ dispatches, journal: healedJournal, dispatchFn: makeCleanDispatch(effectsFile), replay, argsSeed: { run: 'x' } });
    assert.equal(resumed.perIndex[0].outcome, 'redispatched');
    const finalCount = (await readEffectCounts(effectsFile))[key];
    assert.equal(finalCount, 2, 'REPRODUCED: an ordinary ENOSPC (no crash) duplicated the non-idempotent effect');
  });
});

test('runChain: changed args produce a fully disjoint key space on resume (no cross-run reuse)', async () => {
  await withTempDir(async (dir) => {
    const effectsFile = path.join(dir, 'effects.json');
    const journal = new WorkflowJournalFile(path.join(dir, 'journal.jsonl'));
    const dispatches = [{ prompt: 'p1', opts: OPTS }, { prompt: 'p2', opts: OPTS }];
    const runA = await runChain({ dispatches, journal, dispatchFn: makeCleanDispatch(effectsFile), argsSeed: { run: 'A' } });
    const keysA = new Set(runA.perIndex.map((e) => e.key));

    const replay = await journal.load();
    const runB = await runChain({ dispatches, journal, dispatchFn: makeCleanDispatch(effectsFile), replay, argsSeed: { run: 'B' } });
    for (const e of runB.perIndex) {
      assert.equal(e.outcome, 'redispatched');
      assert.equal(keysA.has(e.key), false, 'changed-args key must not collide with a run-A key');
    }
    const counts = await readEffectCounts(effectsFile);
    for (const key of keysA) assert.equal(counts[key], 1, 'run A keys must remain untouched');
  });
});

test('runChain: a different dispatch at the same position never reuses a stale committed result', async () => {
  await withTempDir(async (dir) => {
    const effectsFile = path.join(dir, 'effects.json');
    const journal = new WorkflowJournalFile(path.join(dir, 'journal.jsonl'));
    const runX = await runChain({ dispatches: [{ prompt: 'task-x', opts: OPTS }], journal, dispatchFn: makeCleanDispatch(effectsFile), argsSeed: { run: 'x' } });
    const keyX = runX.perIndex[0].key;

    const replay = await journal.load();
    const runY = await runChain({ dispatches: [{ prompt: 'task-y', opts: OPTS }], journal, dispatchFn: makeCleanDispatch(effectsFile), replay, argsSeed: { run: 'x' } });
    assert.equal(runY.perIndex[0].outcome, 'redispatched');
    assert.notEqual(runY.perIndex[0].key, keyX);
    const counts = await readEffectCounts(effectsFile);
    assert.equal(counts[keyX], 1);
    assert.equal(counts[runY.perIndex[0].key], 1);
  });
});
