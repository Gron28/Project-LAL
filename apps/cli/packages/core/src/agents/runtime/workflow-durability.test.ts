/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { setImmediate } from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';
import {
  deriveAgentKey,
  deriveArgsSeed,
  WorkflowJournal,
} from './workflow-journal.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('workflow journal boundaries', () => {
  it('commits the intent before starting a dispatch', async () => {
    const journal = new WorkflowJournal('/unused/journal');
    const gate = deferred<void>();
    const entered = deferred<void>();
    vi.spyOn(journal, 'append').mockImplementation((entry) => {
      if (entry.type === 'started') {
        entered.resolve();
        return gate.promise;
      }
      return Promise.resolve();
    });
    const dispatch = vi.fn(async () => 'done');
    const pending = new WorkflowOrchestrator(dispatch).run({
      script: 'return await agent("edit fixture");',
      args: undefined,
      journal,
    });
    try {
      await entered.promise;
      await setImmediate();
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await pending;
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('commits a result before completing the run', async () => {
    const journal = new WorkflowJournal('/unused/journal');
    const gate = deferred<void>();
    const entered = deferred<void>();
    vi.spyOn(journal, 'append').mockImplementation((entry) => {
      if (entry.type === 'result') {
        entered.resolve();
        return gate.promise;
      }
      return Promise.resolve();
    });
    let completed = false;
    const pending = new WorkflowOrchestrator(async () => 'done')
      .run({
        script: 'return await agent("edit fixture");',
        args: undefined,
        journal,
      })
      .then((value) => {
        completed = true;
        return value;
      });
    try {
      await entered.promise;
      await setImmediate();
      expect(completed).toBe(false);
    } finally {
      gate.resolve();
      await pending;
    }
    expect(completed).toBe(true);
  });

  it('does not execute tools when the intent cannot be recorded', async () => {
    const journal = new WorkflowJournal('/unused/journal');
    vi.spyOn(journal, 'append').mockRejectedValue(new Error('disk full'));
    const dispatch = vi.fn(async () => 'side effect');
    await expect(
      new WorkflowOrchestrator(dispatch).run({
        script: 'return await agent("edit fixture");',
        args: undefined,
        journal,
      }),
    ).rejects.toThrow(/journal.*disk full/i);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not report success if a parallel branch hides a result-write failure', async () => {
    const journal = new WorkflowJournal('/unused/journal');
    vi.spyOn(journal, 'append').mockImplementation((entry) =>
      entry.type === 'result'
        ? Promise.reject(new Error('disk full'))
        : Promise.resolve(),
    );
    const dispatch = vi.fn(async () => 'side effect');
    await expect(
      new WorkflowOrchestrator(dispatch).run({
        script:
          'await parallel([() => agent("edit fixture")]); return "all good";',
        args: undefined,
        journal,
      }),
    ).rejects.toThrow(/journal.*disk full/i);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('replays completed dispatches after restart without duplicating side effects', async () => {
    const rootA = await fs.mkdtemp(
      path.join(os.tmpdir(), 'workflow-durable-a-'),
    );
    const rootB = await fs.mkdtemp(
      path.join(os.tmpdir(), 'workflow-durable-b-'),
    );
    try {
      const script = 'return await agent("edit fixture");';
      const args = { fixture: 'durable' };
      const journalA = new WorkflowJournal(path.join(rootA, 'journal.jsonl'));
      const journalB = new WorkflowJournal(path.join(rootB, 'journal.jsonl'));
      const dispatchA = vi.fn(async () => 'result-a');
      const dispatchB = vi.fn(async () => 'result-b');

      const firstA = await new WorkflowOrchestrator(dispatchA).run({
        script,
        args,
        journal: journalA,
      });
      const firstB = await new WorkflowOrchestrator(dispatchB).run({
        script,
        args,
        journal: journalB,
      });
      expect(firstA.result).toBe('result-a');
      expect(firstB.result).toBe('result-b');
      expect(dispatchA).toHaveBeenCalledTimes(1);
      expect(dispatchB).toHaveBeenCalledTimes(1);

      const replayA = await journalA.load();
      const replayB = await journalB.load();
      const resumedDispatchA = vi.fn(async () => 'duplicate-a');
      const resumedDispatchB = vi.fn(async () => 'duplicate-b');
      const resumedA = await new WorkflowOrchestrator(resumedDispatchA).run({
        script,
        args,
        journal: journalA,
        resumeReplay: replayA,
      });
      const resumedB = await new WorkflowOrchestrator(resumedDispatchB).run({
        script,
        args,
        journal: journalB,
        resumeReplay: replayB,
      });

      expect(resumedA.result).toBe('result-a');
      expect(resumedB.result).toBe('result-b');
      expect(resumedDispatchA).not.toHaveBeenCalled();
      expect(resumedDispatchB).not.toHaveBeenCalled();
    } finally {
      await Promise.all([
        fs.rm(rootA, { recursive: true, force: true }),
        fs.rm(rootB, { recursive: true, force: true }),
      ]);
    }
  });

  it('invalidates the replay suffix after the first changed dispatch', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'workflow-durable-prefix-'),
    );
    try {
      const journal = new WorkflowJournal(path.join(root, 'journal.jsonl'));
      const firstDispatch = vi.fn(
        async (prompt: string) => `initial:${prompt}`,
      );
      const script =
        'const first = await agent("first"); const second = await agent("second"); return [first, second];';
      await new WorkflowOrchestrator(firstDispatch).run({
        script,
        args: { version: 1 },
        journal,
      });
      const replay = await journal.load();
      const resumedDispatch = vi.fn(
        async (prompt: string) => `replayed-live:${prompt}`,
      );
      const resumed = await new WorkflowOrchestrator(resumedDispatch).run({
        script:
          'const first = await agent("changed"); const second = await agent("second"); return [first, second];',
        args: { version: 1 },
        journal,
        resumeReplay: replay,
      });

      expect(resumed.result).toEqual([
        'replayed-live:changed',
        'replayed-live:second',
      ]);
      expect(resumedDispatch).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to silently re-dispatch an effect that completed before a result-commit crash', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'workflow-durable-effect-'),
    );
    try {
      const counterFile = path.join(root, 'counter.json');
      await fs.writeFile(counterFile, JSON.stringify({ count: 0 }));
      // Stand-in for a real write_file/shell effect: a durable, observable,
      // out-of-band mutation performed by the "agent turn" itself — not a
      // mock call count. ACCEPTANCE.md requires the ambiguous crash window
      // be tested "with a persisted action counter, not only a mock
      // dispatch count."
      const bumpCounter = async () => {
        const current = JSON.parse(await fs.readFile(counterFile, 'utf8'));
        current.count += 1;
        await fs.writeFile(counterFile, JSON.stringify(current));
        return 'effect-done';
      };

      const journalPath = path.join(root, 'journal.jsonl');
      const crashingJournal = new WorkflowJournal(journalPath);
      // Real appends land on the real backing file; only the 'result' write
      // is intercepted to simulate a crash landing in the narrow window
      // AFTER the effect (bumpCounter) has already run and returned, but
      // BEFORE its result is committed — the exact seam named in
      // ACCEPTANCE.md ("Crash ... after effect but before result").
      const realAppend = crashingJournal.append.bind(crashingJournal);
      vi.spyOn(crashingJournal, 'append').mockImplementation(async (entry) => {
        if (entry.type === 'result') {
          throw new Error('disk full');
        }
        return realAppend(entry);
      });

      const args = { fixture: 'effect-before-result' };
      await expect(
        new WorkflowOrchestrator(bumpCounter).run({
          script: 'return await agent("edit fixture");',
          args,
          journal: crashingJournal,
        }),
      ).rejects.toThrow(/journal.*disk full/i);

      // The effect really ran, once, durably, before the simulated crash.
      expect(JSON.parse(await fs.readFile(counterFile, 'utf8')).count).toBe(1);

      // Resume with a fresh journal handle reading the same on-disk file —
      // mirrors a real process restart.
      const resumeJournal = new WorkflowJournal(journalPath);
      const replay = await resumeJournal.load();
      const resumedDispatch = vi.fn(bumpCounter);
      await expect(
        new WorkflowOrchestrator(resumedDispatch).run({
          script: 'return await agent("edit fixture");',
          args,
          journal: resumeJournal,
          resumeReplay: replay,
        }),
      ).rejects.toThrow(/ambiguous|reconcil/i);

      // The contract: exactly one effect, never two. Today (pre-fix) this
      // fails: resumedDispatch runs, bumpCounter fires again, count is 2.
      expect(resumedDispatch).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(counterFile, 'utf8')).count).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('re-dispatches an intent left incomplete by a crash', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'workflow-durable-crash-'),
    );
    try {
      const journal = new WorkflowJournal(path.join(root, 'journal.jsonl'));
      const args = { fixture: 'crash-boundary' };
      const key = deriveAgentKey(deriveArgsSeed(args), 'edit fixture', {});
      await journal.append({ type: 'started', key, agentId: 'crashed' });
      const dispatch = vi.fn(async () => 'recovered');

      const replay = await journal.load();
      const outcome = await new WorkflowOrchestrator(dispatch).run({
        script: 'return await agent("edit fixture");',
        args,
        journal,
        resumeReplay: replay,
      });

      expect(outcome.result).toBe('recovered');
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // Gate 2 gap #2 (2026-09-21 incident): `this.dispatch` itself rejects
  // AFTER an internal side effect already landed (e.g. a dropped backend
  // connection after a tool call executed but before the turn resolved).
  // Fixed via the `effect_unknown` journal entry — see workflow-journal.ts
  // and workflow-orchestrator.ts's `countedDispatch`.
  // ---------------------------------------------------------------------
  it('records an honest "effect status unknown" marker and refuses re-dispatch when the dispatch itself rejects after its effect already ran (Gate 2 gap #2 — dirty backend failure)', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'workflow-durable-dirty-'),
    );
    try {
      const counterFile = path.join(root, 'counter.json');
      await fs.writeFile(counterFile, JSON.stringify({ count: 0 }));
      // Models the 2026-09-21 incident: the effect (a real, durable,
      // out-of-band mutation — not a mock call count) really runs, then
      // the connection drops before the dispatch promise can resolve.
      const bumpCounterThenDropConnection = async () => {
        const current = JSON.parse(await fs.readFile(counterFile, 'utf8'));
        current.count += 1;
        await fs.writeFile(counterFile, JSON.stringify(current));
        throw new Error(
          'ECONNRESET: connection dropped after the effect ran, before the result could be reported',
        );
      };

      const journalPath = path.join(root, 'journal.jsonl');
      const journal = new WorkflowJournal(journalPath);
      const args = { fixture: 'dirty-backend-failure' };

      await expect(
        new WorkflowOrchestrator(bumpCounterThenDropConnection).run({
          script: 'return await agent("edit fixture");',
          args,
          journal,
        }),
      ).rejects.toThrow(/ECONNRESET/);

      // The effect really ran, exactly once, before the rejection.
      expect(JSON.parse(await fs.readFile(counterFile, 'utf8')).count).toBe(
        1,
      );

      // The journal must hold an honest ambiguity marker for this key —
      // NOT a bare `started`, which would be structurally identical to
      // "never ran" (that identity IS the gap this closes). The reason is
      // 'effect-unknown' (genuinely don't know), distinct from
      // 'effect-complete' (durably know it ran) — both refuse resume
      // identically, but the claim each records is different and true.
      const key = deriveAgentKey(deriveArgsSeed(args), 'edit fixture', {});
      const replay = await journal.load();
      expect(replay.ambiguousEffects.has(key)).toBe(true);
      expect(replay.ambiguousEffectReasons.get(key)).toBe('effect-unknown');
      expect(replay.results.has(key)).toBe(false);

      // Resume (a fresh journal handle over the same on-disk file, mirroring
      // a real process restart) must refuse to blindly re-dispatch.
      const resumeJournal = new WorkflowJournal(journalPath);
      const resumeReplay = await resumeJournal.load();
      const resumedDispatch = vi.fn(bumpCounterThenDropConnection);
      await expect(
        new WorkflowOrchestrator(resumedDispatch).run({
          script: 'return await agent("edit fixture");',
          args,
          journal: resumeJournal,
          resumeReplay,
        }),
      ).rejects.toThrow(/ambiguous|reconcil/i);

      // The contract this closes: exactly one effect, never two.
      expect(resumedDispatch).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(counterFile, 'utf8')).count).toBe(
        1,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // Gate 2 gap #1, transient case: the `effect_complete` append itself
  // fails right after the effect ran (e.g. one ENOSPC blip), but the
  // journal medium is still writable for a second, immediately-following
  // write. The orchestrator's best-effort fallback (persist an
  // `effect_unknown` marker) closes the gap for this case.
  // ---------------------------------------------------------------------
  it('falls back to an "effect status unknown" marker when the effect_complete write itself fails, closing Gate 2 gap #1 for a transient (non-sustained) journal fault', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'workflow-durable-fallback-'),
    );
    try {
      const counterFile = path.join(root, 'counter.json');
      await fs.writeFile(counterFile, JSON.stringify({ count: 0 }));
      const bumpCounter = async () => {
        const current = JSON.parse(await fs.readFile(counterFile, 'utf8'));
        current.count += 1;
        await fs.writeFile(counterFile, JSON.stringify(current));
        return 'effect-done';
      };

      const journalPath = path.join(root, 'journal.jsonl');
      const journal = new WorkflowJournal(journalPath);
      const realAppend = journal.append.bind(journal);
      // Fail ONLY the `effect_complete` append — a single transient write
      // error, not a sustained full disk. The fallback `effect_unknown`
      // write that immediately follows, on the SAME journal handle, must
      // succeed.
      let effectCompleteAttempts = 0;
      vi.spyOn(journal, 'append').mockImplementation(async (entry) => {
        if (entry.type === 'effect_complete') {
          effectCompleteAttempts += 1;
          throw new Error('ENOSPC: no space left on device');
        }
        return realAppend(entry);
      });

      const args = { fixture: 'effect-complete-write-fails' };
      await expect(
        new WorkflowOrchestrator(bumpCounter).run({
          script: 'return await agent("edit fixture");',
          args,
          journal,
        }),
      ).rejects.toThrow(/journal.*ENOSPC/i);

      expect(effectCompleteAttempts).toBe(1);
      // The effect ran once, durably, before the journal write failed.
      expect(JSON.parse(await fs.readFile(counterFile, 'utf8')).count).toBe(
        1,
      );

      // The on-disk journal now holds the fallback `effect_unknown` marker
      // for this key instead of a bare `started` — the gap is closed for
      // this transient fault.
      const key = deriveAgentKey(deriveArgsSeed(args), 'edit fixture', {});
      const resumeJournal = new WorkflowJournal(journalPath);
      const replay = await resumeJournal.load();
      expect(replay.ambiguousEffects.has(key)).toBe(true);
      expect(replay.ambiguousEffectReasons.get(key)).toBe('effect-unknown');

      const resumedDispatch = vi.fn(bumpCounter);
      await expect(
        new WorkflowOrchestrator(resumedDispatch).run({
          script: 'return await agent("edit fixture");',
          args,
          journal: resumeJournal,
          resumeReplay: replay,
        }),
      ).rejects.toThrow(/ambiguous|reconcil/i);

      expect(resumedDispatch).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(counterFile, 'utf8')).count).toBe(
        1,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // Gate 2 gap #1, sustained (irreducible) case: the journal medium itself
  // is unwritable — every append from `effect_complete` onward fails, not
  // just one. Nothing can be durably recorded: there is no channel left to
  // persist the ambiguity through. This test documents that honestly —
  // it asserts the KNOWN, IRREDUCIBLE limitation (a later resume, once the
  // disk is healed, duplicates the effect) rather than a false claim of
  // safety. What the fix still guarantees even here: the run itself never
  // reports success (it rejects with the journal-write error), so the
  // failure is never hidden.
  // ---------------------------------------------------------------------
  it('documents the irreducible residual of Gate 2 gap #1: a sustained (not transient) journal fault leaves nothing recordable, so a later resume still duplicates the effect — though the original run correctly never reports success', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'workflow-durable-irreducible-'),
    );
    try {
      const counterFile = path.join(root, 'counter.json');
      await fs.writeFile(counterFile, JSON.stringify({ count: 0 }));
      const bumpCounter = async () => {
        const current = JSON.parse(await fs.readFile(counterFile, 'utf8'));
        current.count += 1;
        await fs.writeFile(counterFile, JSON.stringify(current));
        return 'effect-done';
      };

      const journalPath = path.join(root, 'journal.jsonl');
      const journal = new WorkflowJournal(journalPath);
      const realAppend = journal.append.bind(journal);
      // A SUSTAINED fault — models a disk that is genuinely full, so both
      // the `effect_complete` write AND the fallback `effect_unknown` write
      // fail. Only `started` (written before the effect ran) lands.
      vi.spyOn(journal, 'append').mockImplementation(async (entry) => {
        if (entry.type === 'started') return realAppend(entry);
        throw new Error('ENOSPC: no space left on device');
      });

      const args = { fixture: 'sustained-full-disk' };
      await expect(
        new WorkflowOrchestrator(bumpCounter).run({
          script: 'return await agent("edit fixture");',
          args,
          journal,
        }),
      ).rejects.toThrow(/journal.*ENOSPC/i);

      // The effect ran once, durably — the run correctly never reports
      // success despite that (it rejects, above).
      expect(JSON.parse(await fs.readFile(counterFile, 'utf8')).count).toBe(
        1,
      );

      // Nothing could be recorded: on disk this key is `started`-only,
      // structurally identical to "never ran". This IS the irreducible
      // residual — no journal-side code can close it, because the journal
      // itself refused every write attempted after the effect ran.
      const key = deriveAgentKey(deriveArgsSeed(args), 'edit fixture', {});
      const healedJournal = new WorkflowJournal(journalPath);
      const replay = await healedJournal.load();
      expect(replay.ambiguousEffects.has(key)).toBe(false);

      // Once the disk is healed (a fresh, working journal handle over the
      // same file — space freed), resume treats the key as an ordinary
      // miss and duplicates the effect. Documented limitation, not a bug
      // this worker's fix claims to have closed.
      const resumedDispatch = vi.fn(bumpCounter);
      const outcome = await new WorkflowOrchestrator(resumedDispatch).run({
        script: 'return await agent("edit fixture");',
        args,
        journal: healedJournal,
        resumeReplay: replay,
      });
      expect(outcome.result).toBe('effect-done');
      expect(resumedDispatch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await fs.readFile(counterFile, 'utf8')).count).toBe(
        2,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
