/**
 * Self-tests for scripts/m1-recovery-exercise.mjs.
 *
 * Runs entirely in-process, with NO subprocess spawning, NO model, and NO
 * GPU: `runEffect` (the "fake dispatch"/side-effect stub) is a plain
 * durable file counter, and `resumeAndReconcile` is exercised against
 * hand-built `replay` objects (the shape `buildReplay` produces) instead of
 * real crashed journals, so these tests are fast and deterministic.
 *
 * Run with: node --test scripts/m1-recovery-exercise.test.mjs
 *
 * The real, process-killing exercise (the thing these unit tests do NOT
 * cover) is `node scripts/m1-recovery-exercise.mjs` itself.
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
  assertDisposableWorkspace,
  runEffect,
  readEffectCounts,
  resumeAndReconcile,
} from './m1-recovery-exercise.mjs';

const WORKSPACE_PREFIX = 'lal-m1-recovery-';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), WORKSPACE_PREFIX));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

test('canonicalizeAgentOpts: cosmetic fields (label) do not affect the projection', () => {
  const a = canonicalizeAgentOpts({ model: 'm1', isolation: 'none', agentType: 'x', label: 'alpha' });
  const b = canonicalizeAgentOpts({ model: 'm1', isolation: 'none', agentType: 'x', label: 'beta' });
  assert.equal(a, b);
});

test('canonicalizeAgentOpts: dispatch-affecting fields (model) DO affect the projection', () => {
  const a = canonicalizeAgentOpts({ model: 'm1', isolation: 'none', agentType: 'x' });
  const b = canonicalizeAgentOpts({ model: 'm2', isolation: 'none', agentType: 'x' });
  assert.notEqual(a, b);
});

test('canonicalizeAgentOpts: key order does not matter (sorted deep)', () => {
  const a = canonicalizeAgentOpts({ model: 'm1', isolation: 'none' });
  const b = canonicalizeAgentOpts({ isolation: 'none', model: 'm1' });
  assert.equal(a, b);
});

test('deriveAgentKey: deterministic for identical inputs', () => {
  const k1 = deriveAgentKey('seed', 'prompt-1', { model: 'm1' });
  const k2 = deriveAgentKey('seed', 'prompt-1', { model: 'm1' });
  assert.equal(k1, k2);
  assert.match(k1, /^v2:[0-9a-f]{64}$/);
});

test('deriveAgentKey: different prompt -> different key', () => {
  const k1 = deriveAgentKey('seed', 'prompt-1', { model: 'm1' });
  const k2 = deriveAgentKey('seed', 'prompt-2', { model: 'm1' });
  assert.notEqual(k1, k2);
});

test('deriveAgentKey: different prefix (upstream edit) -> different key (chain invalidation)', () => {
  const k1 = deriveAgentKey('seed-a', 'prompt-1', { model: 'm1' });
  const k2 = deriveAgentKey('seed-b', 'prompt-1', { model: 'm1' });
  assert.notEqual(k1, k2);
});

test('deriveAgentKey: label difference alone does not change the key', () => {
  const k1 = deriveAgentKey('seed', 'prompt-1', { model: 'm1', label: 'a' });
  const k2 = deriveAgentKey('seed', 'prompt-1', { model: 'm1', label: 'b' });
  assert.equal(k1, k2);
});

test('deriveArgsSeed: deterministic and sensitive to args', () => {
  const s1 = deriveArgsSeed({ a: 1 });
  const s2 = deriveArgsSeed({ a: 1 });
  const s3 = deriveArgsSeed({ a: 2 });
  assert.equal(s1, s2);
  assert.notEqual(s1, s3);
});

// ---------------------------------------------------------------------------
// buildReplay / journal semantics
// ---------------------------------------------------------------------------

test('buildReplay: started-only key is an ordinary miss (not ambiguous, no result)', () => {
  const replay = buildReplay([{ type: 'started', key: 'k1', agentId: '1' }]);
  assert.equal(replay.results.has('k1'), false);
  assert.equal(replay.ambiguousEffects.has('k1'), false);
  assert.equal(replay.started.get('k1').length, 1);
});

test('buildReplay: started + effect_complete + no result => ambiguous', () => {
  const replay = buildReplay([
    { type: 'started', key: 'k1', agentId: '1' },
    { type: 'effect_complete', key: 'k1', agentId: '1' },
  ]);
  assert.equal(replay.ambiguousEffects.has('k1'), true);
  assert.equal(replay.results.has('k1'), false);
});

test('buildReplay: started + effect_complete + result => fully recovered, NOT ambiguous', () => {
  const replay = buildReplay([
    { type: 'started', key: 'k1', agentId: '1' },
    { type: 'effect_complete', key: 'k1', agentId: '1' },
    { type: 'result', key: 'k1', agentId: '1', result: { ok: true } },
  ]);
  assert.equal(replay.ambiguousEffects.has('k1'), false);
  assert.deepEqual(replay.results.get('k1').result, { ok: true });
});

test('buildReplay: an old journal (no effect_complete entries at all) never marks anything ambiguous', () => {
  const replay = buildReplay([
    { type: 'started', key: 'k1', agentId: '1' },
    { type: 'started', key: 'k2', agentId: '2' },
  ]);
  assert.equal(replay.ambiguousEffects.size, 0);
});

test('WorkflowJournalFile: round-trips append -> load -> buildReplay, missing file loads empty', async () => {
  await withTempDir(async (dir) => {
    const journal = new WorkflowJournalFile(path.join(dir, 'nested', 'journal.jsonl'));
    const emptyReplay = await journal.load();
    assert.equal(emptyReplay.results.size, 0);

    await journal.append({ type: 'started', key: 'k1', agentId: '1' });
    await journal.append({ type: 'effect_complete', key: 'k1', agentId: '1' });
    const midReplay = await journal.load();
    assert.equal(midReplay.ambiguousEffects.has('k1'), true);

    await journal.append({ type: 'result', key: 'k1', agentId: '1', result: 42 });
    const finalReplay = await journal.load();
    assert.equal(finalReplay.ambiguousEffects.has('k1'), false);
    assert.equal(finalReplay.results.get('k1').result, 42);

    const raw = await readFile(journal.path, 'utf8');
    assert.equal(raw.split('\n').filter(Boolean).length, 3);
  });
});

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
  assert.throws(() => assertDisposableWorkspace(path.join(process.cwd(), 'scripts')));
});

test('assertDisposableWorkspace: refuses a path under ~/.lal', () => {
  assert.throws(() => assertDisposableWorkspace(path.join(os.homedir(), '.lal')));
  assert.throws(() => assertDisposableWorkspace(path.join(os.homedir(), '.lal', 'runtime.db')));
});

test('assertDisposableWorkspace: refuses a tmp-root path lacking this exercise\'s own prefix', () => {
  assert.throws(() => assertDisposableWorkspace(path.join(os.tmpdir(), 'some-other-tool-dir')));
});

test('assertDisposableWorkspace: refuses a path outside the OS temp root entirely', () => {
  assert.throws(() => assertDisposableWorkspace('/var/lib/some-service'));
});

// ---------------------------------------------------------------------------
// runEffect: the durable, on-disk, per-key action counter
// ---------------------------------------------------------------------------

test('runEffect: increments a durable per-key counter; independent keys do not interfere', async () => {
  await withTempDir(async (dir) => {
    const effectsFile = path.join(dir, 'effects.json');
    assert.equal(await runEffect(effectsFile, 'k1'), 1);
    assert.equal(await runEffect(effectsFile, 'k1'), 2);
    assert.equal(await runEffect(effectsFile, 'k2'), 1);
    const counts = await readEffectCounts(effectsFile);
    assert.deepEqual(counts, { k1: 2, k2: 1 });
  });
});

test('readEffectCounts: returns {} when the file does not exist yet', async () => {
  await withTempDir(async (dir) => {
    const counts = await readEffectCounts(path.join(dir, 'never-written.json'));
    assert.deepEqual(counts, {});
  });
});

// ---------------------------------------------------------------------------
// resumeAndReconcile: the Gate-2 contract itself, exercised with a stub
// dispatch (runEffect) and hand-built replay objects standing in for a
// crashed journal's parsed state, per boundary.
// ---------------------------------------------------------------------------

test('resumeAndReconcile: a totally empty journal (crash before any intent) redispatches everything exactly once', async () => {
  await withTempDir(async (dir) => {
    const journal = new WorkflowJournalFile(path.join(dir, 'journal.jsonl'));
    const effectsFile = path.join(dir, 'effects.json');
    const replay = buildReplay([]);
    const outcome = await resumeAndReconcile(replay, { journal, effectsFile });
    assert.equal(outcome.aborted, false);
    assert.equal(outcome.perIndex.length, 3);
    for (const entry of outcome.perIndex) assert.equal(entry.outcome, 'redispatched');
    const counts = await readEffectCounts(effectsFile);
    for (const entry of outcome.perIndex) assert.equal(counts[entry.key], 1);
  });
});

test('resumeAndReconcile: a `started`-only key (after-intent crash) is redispatched exactly once, never twice', async () => {
  await withTempDir(async (dir) => {
    const journal = new WorkflowJournalFile(path.join(dir, 'journal.jsonl'));
    const effectsFile = path.join(dir, 'effects.json');

    // Discover dispatch #2's real key the same way the module does, by
    // replaying an empty-then-partial resume once to read off the key.
    const probe = await resumeAndReconcile(buildReplay([]), {
      journal: new WorkflowJournalFile(path.join(dir, 'probe.jsonl')),
      effectsFile: path.join(dir, 'probe-effects.json'),
    });
    const key1 = probe.perIndex[1].key;

    const replay = buildReplay([{ type: 'started', key: key1, agentId: '2' }]);
    const outcome = await resumeAndReconcile(replay, { journal, effectsFile });
    assert.equal(outcome.aborted, false);
    assert.equal(outcome.perIndex[0].outcome, 'redispatched'); // index0 had nothing journaled either
    assert.equal(outcome.perIndex[1].outcome, 'redispatched');
    const counts = await readEffectCounts(effectsFile);
    assert.equal(counts[key1], 1, 'the effect must run exactly once, not zero and not twice');
  });
});

test('resumeAndReconcile: an ambiguous key (effect_complete, no result) is REFUSED and the effect is never re-run', async () => {
  await withTempDir(async (dir) => {
    const journal = new WorkflowJournalFile(path.join(dir, 'journal.jsonl'));
    const effectsFile = path.join(dir, 'effects.json');

    const probe = await resumeAndReconcile(buildReplay([]), {
      journal: new WorkflowJournalFile(path.join(dir, 'probe.jsonl')),
      effectsFile: path.join(dir, 'probe-effects.json'),
    });
    const key0 = probe.perIndex[0].key;
    const key1 = probe.perIndex[1].key;

    // Simulate: index0 fully committed pre-crash (its effect already ran
    // once, durably recorded), index1's effect ran and effect_complete was
    // durably written, but the process died before `result`.
    await runEffect(effectsFile, key0);
    await runEffect(effectsFile, key1);
    const replay = buildReplay([
      { type: 'started', key: key0, agentId: '1' },
      { type: 'effect_complete', key: key0, agentId: '1' },
      { type: 'result', key: key0, agentId: '1', result: { ok: true } },
      { type: 'started', key: key1, agentId: '2' },
      { type: 'effect_complete', key: key1, agentId: '2' },
    ]);

    const outcome = await resumeAndReconcile(replay, { journal, effectsFile });
    assert.equal(outcome.aborted, true);
    assert.equal(outcome.abortedAtIndex, 1);
    assert.equal(outcome.perIndex[0].outcome, 'recovered-cached');
    assert.equal(outcome.perIndex[1].outcome, 'refused-ambiguous');
    assert.equal(outcome.perIndex.length, 2, 'index2 must never be reached once index1 is refused');

    const counts = await readEffectCounts(effectsFile);
    assert.equal(counts[key0], 1, 'committed work must not be re-executed');
    assert.equal(counts[key1], 1, 'the ambiguous effect must NOT be re-run — this is the safety contract under test');

    // The journal itself must not have gained a spurious result for the
    // refused key either.
    const finalReplay = await journal.load();
    assert.equal(finalReplay.results.has(key1), false);
  });
});

test('resumeAndReconcile: a fully-committed key (crash after result) is reused from cache with zero re-execution', async () => {
  await withTempDir(async (dir) => {
    const journal = new WorkflowJournalFile(path.join(dir, 'journal.jsonl'));
    const effectsFile = path.join(dir, 'effects.json');

    const probe = await resumeAndReconcile(buildReplay([]), {
      journal: new WorkflowJournalFile(path.join(dir, 'probe.jsonl')),
      effectsFile: path.join(dir, 'probe-effects.json'),
    });
    const key0 = probe.perIndex[0].key;

    await runEffect(effectsFile, key0);
    const replay = buildReplay([
      { type: 'started', key: key0, agentId: '1' },
      { type: 'effect_complete', key: key0, agentId: '1' },
      { type: 'result', key: key0, agentId: '1', result: { ok: true, prompt: 'x' } },
    ]);

    const outcome = await resumeAndReconcile(replay, { journal, effectsFile });
    assert.equal(outcome.perIndex[0].outcome, 'recovered-cached');
    // The other two dispatches were never journaled, so they are ordinary
    // unfinished intents and get redispatched.
    assert.equal(outcome.perIndex[1].outcome, 'redispatched');
    assert.equal(outcome.perIndex[2].outcome, 'redispatched');

    const counts = await readEffectCounts(effectsFile);
    assert.equal(counts[key0], 1, 'a cached result must never cause the effect to run again');
  });
});

test('resumeAndReconcile: a fully-complete journal for all three dispatches replays entirely from cache (idempotent resume)', async () => {
  await withTempDir(async (dir) => {
    const journal = new WorkflowJournalFile(path.join(dir, 'journal.jsonl'));
    const effectsFile = path.join(dir, 'effects.json');

    const probe = await resumeAndReconcile(buildReplay([]), { journal, effectsFile });
    assert.equal(probe.perIndex.every((e) => e.outcome === 'redispatched'), true);
    const counts1 = await readEffectCounts(effectsFile);
    for (const entry of probe.perIndex) assert.equal(counts1[entry.key], 1);

    const replay = await journal.load();
    const second = await resumeAndReconcile(replay, { journal, effectsFile });
    assert.equal(second.aborted, false);
    for (const entry of second.perIndex) assert.equal(entry.outcome, 'recovered-cached');
    const counts2 = await readEffectCounts(effectsFile);
    assert.deepEqual(counts2, counts1, 'resuming an already-complete run must not execute any effect again');
  });
});
