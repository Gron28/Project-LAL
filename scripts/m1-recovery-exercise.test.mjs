/**
 * Self-tests for scripts/m1-recovery-exercise.mjs.
 *
 * Runs entirely in-process, with NO subprocess spawning, NO model, and NO
 * GPU. These tests pin four things independent of build state:
 *   - the isolation guard (`assertDisposableWorkspace`)
 *   - the durable, on-disk effect counter (`runEffect`/`readEffectCounts`)
 *   - the sandboxed-script builder (`buildSequentialScript`)
 *   - the journal-holding wrapper (`makeHoldingJournal`), exercised against
 *     a small FAKE in-memory journal (NOT the real dist import) so these
 *     tests do not depend on `apps/cli/packages/core/dist` being fresh
 *   - the build-freshness guard itself (`checkBuildFreshness`), exercised
 *     against synthetic temp source/dist trees with controlled mtimes
 *
 * One additional, ADAPTIVE integration test calls the real
 * `checkBuildFreshness()` (default, real repo paths) and, only if it
 * reports fresh, does a real `loadRuntimeModules()` + a tiny live smoke run
 * against the actual compiled orchestrator; if the build is currently
 * stale, that test SKIPS with an explicit reason instead of failing --
 * exactly the "stale build, cannot judge" distinction the guard exists to
 * make, applied to this test suite itself.
 *
 * Run with: node --test scripts/m1-recovery-exercise.test.mjs
 *
 * The full, real exercise (real SIGKILL, real compiled orchestrator, all
 * five scenarios) is `node scripts/m1-recovery-exercise.mjs` itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';

import {
  assertDisposableWorkspace,
  runEffect,
  readEffectCounts,
  buildSequentialScript,
  makeHoldingJournal,
  checkBuildFreshness,
  loadRuntimeModules,
  StaleBuildError,
  DISPATCHES,
  ARGS_SEED,
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

test("assertDisposableWorkspace: refuses a path under ~/.lal", () => {
  assert.throws(() => assertDisposableWorkspace(path.join(os.homedir(), '.lal')));
  assert.throws(() => assertDisposableWorkspace(path.join(os.homedir(), '.lal', 'runtime.db')));
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
    assert.equal(await runEffect(effectsFile, 'alpha'), 1);
    assert.equal(await runEffect(effectsFile, 'alpha'), 2);
    assert.equal(await runEffect(effectsFile, 'beta'), 1);
    const counts = await readEffectCounts(effectsFile);
    assert.deepEqual(counts, { alpha: 2, beta: 1 });
  });
});

test('readEffectCounts: returns {} when the file does not exist yet', async () => {
  await withTempDir(async (dir) => {
    const counts = await readEffectCounts(path.join(dir, 'never-written.json'));
    assert.deepEqual(counts, {});
  });
});

// ---------------------------------------------------------------------------
// buildSequentialScript: the real sandboxed workflow script text
// ---------------------------------------------------------------------------

test('buildSequentialScript: emits one `agent()` call per dispatch, in order, JSON-safe', () => {
  const script = buildSequentialScript(DISPATCHES);
  assert.equal(script.split('await agent(').length - 1, DISPATCHES.length);
  const alphaIdx = script.indexOf(DISPATCHES[0].prompt);
  const betaIdx = script.indexOf(DISPATCHES[1].prompt);
  const gammaIdx = script.indexOf(DISPATCHES[2].prompt);
  assert.ok(alphaIdx >= 0 && betaIdx > alphaIdx && gammaIdx > betaIdx, 'dispatches must appear in order');
  assert.match(script, /return \[r0, r1, r2\];/);
});

test('buildSequentialScript: opts never include `isolation` (the sandbox rejects any value other than worktree/remote)', () => {
  for (const d of DISPATCHES) {
    assert.equal('isolation' in d.opts, false, `dispatch ${d.id} must omit isolation entirely`);
  }
});

test('buildSequentialScript: ARGS_SEED is a plain JSON-serializable object (required for deriveArgsSeed)', () => {
  assert.doesNotThrow(() => JSON.stringify(ARGS_SEED));
});

// ---------------------------------------------------------------------------
// makeHoldingJournal: the seam used to pause the REAL orchestrator mid-run,
// exercised here against a small fake in-memory journal so it needs no
// build at all.
// ---------------------------------------------------------------------------

function makeFakeJournal() {
  const entries = [];
  return {
    entries,
    load: async () => ({ entries: entries.slice() }),
    append: async (entry) => {
      entries.push(entry);
    },
  };
}

test('makeHoldingJournal: phase "pre" fires BEFORE the real append for the matching occurrence', async () => {
  const fake = makeFakeJournal();
  const holdLog = [];
  const holding = makeHoldingJournal(fake, 'pre', 'started', 1, async (phase, type, index, key) => {
    holdLog.push({ phase, type, index, key, entriesAtHoldTime: fake.entries.length });
  });
  await holding.append({ type: 'started', key: 'k0', agentId: '1' });
  await holding.append({ type: 'started', key: 'k1', agentId: '2' });
  assert.equal(holdLog.length, 1);
  assert.equal(holdLog[0].index, 1);
  assert.equal(holdLog[0].key, 'k1');
  // "pre" must fire before the real append lands -- at hold time only k0's
  // entry should exist yet.
  assert.equal(holdLog[0].entriesAtHoldTime, 1);
  assert.equal(fake.entries.length, 2);
});

test('makeHoldingJournal: phase "post" fires AFTER the real append for the matching occurrence', async () => {
  const fake = makeFakeJournal();
  const holdLog = [];
  const holding = makeHoldingJournal(fake, 'post', 'effect_complete', 0, async (phase, type, index, key) => {
    holdLog.push({ phase, type, index, key, entriesAtHoldTime: fake.entries.length });
  });
  await holding.append({ type: 'started', key: 'k0', agentId: '1' });
  await holding.append({ type: 'effect_complete', key: 'k0', agentId: '1' });
  assert.equal(holdLog.length, 1);
  // "post" fires after the real write -- both entries must already be durable.
  assert.equal(holdLog[0].entriesAtHoldTime, 2);
});

test('makeHoldingJournal: occurrence counting is per-type, not global', async () => {
  const fake = makeFakeJournal();
  const holdLog = [];
  // Hold on the 2nd 'started' (index 1), which is the 4th append overall
  // (started, effect_complete, result, started).
  const holding = makeHoldingJournal(fake, 'post', 'started', 1, async (phase, type, index) => {
    holdLog.push({ phase, type, index });
  });
  await holding.append({ type: 'started', key: 'k0', agentId: '1' });
  await holding.append({ type: 'effect_complete', key: 'k0', agentId: '1' });
  await holding.append({ type: 'result', key: 'k0', agentId: '1', result: 1 });
  await holding.append({ type: 'started', key: 'k1', agentId: '2' });
  assert.equal(holdLog.length, 1, 'must not fire on the first started (occurrence 0) or any other type');
});

test('makeHoldingJournal: never fires when holdPhase is "none"', async () => {
  const fake = makeFakeJournal();
  let fired = false;
  const holding = makeHoldingJournal(fake, 'none', 'started', 0, async () => {
    fired = true;
  });
  await holding.append({ type: 'started', key: 'k0', agentId: '1' });
  assert.equal(fired, false);
});

test('makeHoldingJournal: load() delegates to the wrapped real journal', async () => {
  const fake = makeFakeJournal();
  await fake.append({ type: 'started', key: 'k0', agentId: '1' });
  const holding = makeHoldingJournal(fake, 'none', 'started', 0, async () => {});
  const replay = await holding.load();
  assert.equal(replay.entries.length, 1);
});

// ---------------------------------------------------------------------------
// checkBuildFreshness: the guard itself, against synthetic temp trees so
// this does not depend on -- or get invalidated by -- the real repo's
// current build state.
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

test('checkBuildFreshness: reports fresh when every dist file is newer than its src', async () => {
  await withSyntheticTrees(async ({ srcDir, distDir }) => {
    const now = Date.now();
    writeWithMtime(path.join(srcDir, 'a.ts'), 'export const a = 1;', now);
    writeWithMtime(path.join(distDir, 'a.js'), 'export const a = 1;', now + 60_000);
    const result = checkBuildFreshness(srcDir, distDir, []);
    assert.equal(result.fresh, true);
    assert.deepEqual(result.staleFiles, []);
    assert.equal(result.filesChecked, 1);
  });
});

test('checkBuildFreshness: reports stale (source-newer-than-build) when src changed after the dist build', async () => {
  await withSyntheticTrees(async ({ srcDir, distDir }) => {
    const now = Date.now();
    writeWithMtime(path.join(distDir, 'a.js'), 'export const a = 1;', now);
    writeWithMtime(path.join(srcDir, 'a.ts'), 'export const a = 2;', now + 60_000);
    const result = checkBuildFreshness(srcDir, distDir, []);
    assert.equal(result.fresh, false);
    assert.equal(result.staleFiles.length, 1);
    assert.equal(result.staleFiles[0].reason, 'source-newer-than-build');
    assert.ok(result.staleFiles[0].staleBySeconds >= 59);
  });
});

test('checkBuildFreshness: reports missing-compiled-artifact when the dist file does not exist at all', async () => {
  await withSyntheticTrees(async ({ srcDir, distDir }) => {
    writeWithMtime(path.join(srcDir, 'a.ts'), 'export const a = 1;', Date.now());
    const result = checkBuildFreshness(srcDir, distDir, []);
    assert.equal(result.fresh, false);
    assert.equal(result.staleFiles[0].reason, 'missing-compiled-artifact');
  });
});

test('checkBuildFreshness: excludes .test.ts and .d.ts files from the scan', async () => {
  await withSyntheticTrees(async ({ srcDir, distDir }) => {
    const now = Date.now();
    writeWithMtime(path.join(srcDir, 'a.ts'), 'export const a = 1;', now);
    writeWithMtime(path.join(distDir, 'a.js'), 'export const a = 1;', now + 60_000);
    // A newer .test.ts / .d.ts with NO dist counterpart at all must not
    // affect freshness -- if it were scanned, it would report
    // missing-compiled-artifact and this test would fail.
    writeWithMtime(path.join(srcDir, 'a.test.ts'), 'test', now + 120_000);
    writeWithMtime(path.join(srcDir, 'a.d.ts'), 'declare', now + 120_000);
    const result = checkBuildFreshness(srcDir, distDir, []);
    assert.equal(result.fresh, true);
    assert.equal(result.filesChecked, 1);
  });
});

test('checkBuildFreshness: extraFiles (cross-directory dependencies) are checked the same way', async () => {
  await withSyntheticTrees(async ({ root, srcDir, distDir }) => {
    const now = Date.now();
    writeWithMtime(path.join(srcDir, 'a.ts'), 'export const a = 1;', now);
    writeWithMtime(path.join(distDir, 'a.js'), 'export const a = 1;', now + 60_000);
    const otherSrcDir = path.join(root, 'other-src');
    fs.mkdirSync(otherSrcDir, { recursive: true });
    const extraFile = path.join(otherSrcDir, 'utils.ts');
    // No dist counterpart at all under distDir/../other-src for this one --
    // checkBuildFreshness resolves extraFiles relative to
    // apps/cli/packages/core/src -> dist, not the synthetic srcDir/distDir
    // passed in, so instead just confirm it is INCLUDED in the scan (not
    // silently dropped) by pointing it at a real, known-fresh pair.
    writeWithMtime(extraFile, 'x', now);
    const result = checkBuildFreshness(srcDir, distDir, [extraFile]);
    assert.equal(result.filesChecked, 2, 'extraFiles must be counted alongside the directory scan');
  });
});

test('checkBuildFreshness: a missing src directory is reported as a dirError, not a false "fresh"', async () => {
  const result = checkBuildFreshness('/definitely/does/not/exist/lal-m1', '/also/missing', []);
  assert.equal(result.fresh, false);
  assert.ok(result.dirError);
});

// ---------------------------------------------------------------------------
// Adaptive integration test: exercises the REAL loadRuntimeModules() against
// the REAL repo paths, but only asserts behavior when the build is
// currently fresh -- otherwise it explicitly skips, which is itself the
// stale-vs-violated distinction under test, applied one level up.
// ---------------------------------------------------------------------------

test('loadRuntimeModules: against the real repo, either a fresh-build live smoke run or an explicit stale-build skip -- never a silent pass or a false failure', async (t) => {
  const freshness = checkBuildFreshness();
  if (!freshness.fresh) {
    t.skip(
      `apps/cli/packages/core/dist is currently stale relative to its src ` +
        `(${freshness.staleFiles.map((f) => path.basename(f.srcPath)).join(', ')}); ` +
        `loadRuntimeModules() is expected to throw StaleBuildError, which is exactly ` +
        `what node scripts/m1-recovery-exercise.mjs observes right now (exit code 3). ` +
        `Skipping the live smoke run rather than failing or silently passing.`,
    );
    // Still verify the REFUSAL behavior itself, since that much does not
    // depend on a fresh build.
    await assert.rejects(() => loadRuntimeModules(), StaleBuildError);
    return;
  }
  const modules = await loadRuntimeModules();
  assert.equal(typeof modules.WorkflowJournal, 'function');
  assert.equal(typeof modules.WorkflowOrchestrator, 'function');
  assert.equal(typeof modules.deriveAgentKey, 'function');
  assert.equal(typeof modules.deriveArgsSeed, 'function');

  await withTempDir(async (dir) => {
    const journalPath = path.join(dir, 'journal.jsonl');
    const journal = new modules.WorkflowJournal(journalPath);
    const orchestrator = new modules.WorkflowOrchestrator(async () => 'live-smoke-ok');
    const outcome = await orchestrator.run({
      script: 'return await agent("smoke test");',
      args: { smoke: true },
      journal,
    });
    assert.equal(outcome.result, 'live-smoke-ok');
    const raw = await readFile(journalPath, 'utf8');
    assert.ok(raw.includes('"type":"result"'));
  });
});
