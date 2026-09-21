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
});
