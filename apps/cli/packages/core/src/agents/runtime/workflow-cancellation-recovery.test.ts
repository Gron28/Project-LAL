/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Gate 2 recovery-matrix coverage for the CANCELLATION row
 * only (docs/ACCEPTANCE.md, "Cancellation during inference/tools and
 * repeated cancellation" -> "Acknowledged terminal state, owned child
 * cleanup, released resources, preserved partial work; unrelated processes
 * remain alive").
 *
 * Fixture patterns reused rather than reinvented:
 *  - `deferred<T>()` / controllable in-flight dispatch: workflow-journal
 *    boundary tests and workflow-durability.test.ts.
 *  - Durable-marker-over-mock-call-count for the crash/cancel window:
 *    workflow-durability.test.ts's `bumpCounter` / `counterFile` pattern.
 *  - Real `WorkflowTool` + real `WorkflowRunRegistry` + a controllable
 *    test-injected dispatch that only settles when triggered externally:
 *    tools/workflow/workflow.test.ts's "R7: dialog-cancel race during run"
 *    test and its local `configWithRegistry()` helper (reimplemented here
 *    since that helper isn't exported).
 *
 * Scope note: this file only asserts against production code it is
 * permitted to read (workflow-orchestrator.ts, workflow-journal.ts,
 * workflow-run-registry.ts, tools/workflow/workflow.ts, config.ts,
 * gemini.tsx). It does not and must not edit any of them — where a test
 * exposes a real defect, the fix is reported (file:line + proposed change),
 * not implemented here.
 */

import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';
import type { WorkflowAgentDispatch } from './workflow-orchestrator.js';
import { WorkflowJournal } from './workflow-journal.js';
import { WorkflowRunRegistry } from '../workflow-run-registry.js';
import { WorkflowTool } from '../../tools/workflow/workflow.js';
import { Storage } from '../../config/storage.js';
import type { Config } from '../../config/config.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirrors tools/workflow/workflow.test.ts's local `configWithRegistry()`. */
function configWithRegistry(): { config: Config; registry: WorkflowRunRegistry } {
  const registry = new WorkflowRunRegistry();
  const config = {
    getWorkflowRunRegistry: () => registry,
  } as unknown as Config;
  return { config, registry };
}

/**
 * Same as `configWithRegistry()` but with a real `Storage` rooted at a temp
 * dir, so `writeWorkflowSnapshot` (workflow.ts's `finally` block) performs
 * real file I/O instead of a no-op — required to test requirement (e). The
 * `getProjectDir` override mirrors workflow.test.ts's "execute() loads a
 * saved-workflow scriptPath..." test, which does the same thing to avoid
 * ever touching the real user's `~/.qwen` directory.
 */
async function configWithStorage(): Promise<{
  config: Config;
  registry: WorkflowRunRegistry;
  storage: Storage;
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cancel-recovery-'));
  const registry = new WorkflowRunRegistry();
  const storage = new Storage(root);
  vi.spyOn(storage, 'getProjectDir').mockReturnValue(path.join(root, 'runtime'));
  const config = {
    getWorkflowRunRegistry: () => registry,
    storage,
  } as unknown as Config;
  return {
    config,
    registry,
    storage,
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

describe('Gate 2 cancellation recovery matrix', () => {
  // ── (a) distinct acknowledged terminal state ────────────────────────────
  describe('(a) cancellation reaches a distinct acknowledged terminal state', () => {
    it("a run cancelled via the registry (dialog / SIGINT path) settles as 'cancelled', never 'completed'", async () => {
      const { config, registry } = configWithRegistry();
      let inflight: { reject: (e: Error) => void } | undefined;
      const dispatch: WorkflowAgentDispatch = () =>
        new Promise((_resolve, reject) => {
          inflight = { reject };
        });
      const tool = new WorkflowTool(config, { dispatch });
      const exec = tool
        .build({ script: 'return await agent("q1");' })
        .execute(new AbortController().signal);

      for (let i = 0; i < 200 && !inflight; i++) await sleep(10);
      expect(inflight).toBeDefined();
      const runId = registry.list()[0]!.runId;

      // Production dialog-cancel / shutdown path: workflow-run-registry.ts
      // `cancel()` flips status synchronously and aborts the entry's own
      // controller (which IS `dispatchController` — workflow.ts:298).
      registry.cancel(runId, Date.now());
      expect(registry.get(runId)!.status).toBe('cancelled');

      inflight!.reject(new Error('aborted by cancel'));
      const result = await exec;

      expect(result.error).toBeDefined();
      expect(registry.get(runId)!.status).toBe('cancelled');
      expect(registry.get(runId)!.status).not.toBe('completed');
    });

    it("cancellation is distinguishable from an ordinary script/tool failure ('cancelled' vs 'failed')", async () => {
      const { config, registry } = configWithRegistry();

      // Control: the SAME shape of run, but the dispatch throws a real bug
      // (no cancel, no abort anywhere) — must settle 'failed', not
      // 'cancelled'. This is the contrast that proves the two terminal
      // states are actually distinguishable, not just differently named.
      const failingTool = new WorkflowTool(config, {
        dispatch: async () => {
          throw new Error('boom: real script bug');
        },
      });
      const failResult = await failingTool
        .build({ script: 'return await agent("q1");' })
        .execute(new AbortController().signal);
      expect(failResult.error).toBeDefined();
      const failedRunId = registry.list()[0]!.runId;
      expect(registry.get(failedRunId)!.status).toBe('failed');

      // Cancelled case, same as the previous test.
      let inflight: { reject: (e: Error) => void } | undefined;
      const cancelTool = new WorkflowTool(config, {
        dispatch: () =>
          new Promise((_resolve, reject) => {
            inflight = { reject };
          }),
      });
      const exec = cancelTool
        .build({ script: 'return await agent("q1");' })
        .execute(new AbortController().signal);
      for (let i = 0; i < 200 && !inflight; i++) await sleep(10);
      const cancelledRunId = registry
        .list()
        .find((e) => e.runId !== failedRunId)!.runId;
      registry.cancel(cancelledRunId, Date.now());
      inflight!.reject(new Error('aborted by cancel'));
      await exec;

      expect(registry.get(failedRunId)!.status).toBe('failed');
      expect(registry.get(cancelledRunId)!.status).toBe('cancelled');
      expect(registry.get(failedRunId)!.status).not.toBe(
        registry.get(cancelledRunId)!.status,
      );
    });

    it('outer-signal cancellation (Esc / scheduler abort, not a dialog/registry cancel) also reaches the acknowledged cancelled state', async () => {
      // Exercises the OTHER branch of workflow.ts's catch handler:
      // `if (signal.aborted) { registry?.cancel(...) } else { registry?.fail(...) }`
      // (tools/workflow/workflow.ts:455-459) — here the TOOL's own outer
      // `signal` (the execute() parameter) is what's aborted, not the
      // registry-owned child controller directly.
      const { config, registry } = configWithRegistry();
      const outer = new AbortController();
      const dispatch: WorkflowAgentDispatch = () =>
        new Promise((_resolve, reject) => {
          const entry = registry.list()[0];
          const onAbort = () =>
            reject(new DOMException('Workflow aborted.', 'AbortError'));
          if (entry.abortController.signal.aborted) onAbort();
          else entry.abortController.signal.addEventListener('abort', onAbort, { once: true });
        });
      const tool = new WorkflowTool(config, { dispatch });
      const exec = tool
        .build({ script: 'return await agent("q1");' })
        .execute(outer.signal);

      for (let i = 0; i < 200 && registry.list().length === 0; i++) await sleep(10);
      expect(registry.list()).toHaveLength(1);
      const runId = registry.list()[0]!.runId;

      // createChildAbortController (utils/abortController.ts) chains parent
      // abort into the child synchronously, so this reaches the same
      // dispatchController the registry entry holds.
      outer.abort();
      const result = await exec;

      expect(result.error).toBeDefined();
      expect(registry.get(runId)!.status).toBe('cancelled');
    });
  });

  // ── (b) repeated cancellation is safe and idempotent ────────────────────
  describe('(b) repeated cancellation is safe and idempotent', () => {
    it('a second cancel() does not corrupt state, throw, or flip the outcome', async () => {
      const { config, registry } = configWithRegistry();
      let inflight: { reject: (e: Error) => void } | undefined;
      const dispatch: WorkflowAgentDispatch = () =>
        new Promise((_resolve, reject) => {
          inflight = { reject };
        });
      const tool = new WorkflowTool(config, { dispatch });
      const exec = tool
        .build({ script: 'return await agent("q1");' })
        .execute(new AbortController().signal);
      for (let i = 0; i < 200 && !inflight; i++) await sleep(10);
      const runId = registry.list()[0]!.runId;

      const t1 = Date.now();
      registry.cancel(runId, t1);
      expect(registry.get(runId)!.status).toBe('cancelled');
      expect(registry.get(runId)!.endTime).toBe(t1);

      // Repeated cancellation from every direction a real session can
      // trigger it (double Esc, Esc-then-shutdown, shutdown-then-Esc):
      // workflow-run-registry.ts `cancel()` / `abortAll()` both guard on
      // `entry.status !== 'running'`, and a native AbortController's own
      // second `.abort()` is a documented no-op.
      expect(() => registry.cancel(runId, t1 + 10_000)).not.toThrow();
      expect(() => registry.abortAll()).not.toThrow();
      expect(() => registry.get(runId)!.abortController.abort()).not.toThrow();

      const afterRepeats = registry.get(runId)!;
      expect(afterRepeats.status).toBe('cancelled'); // never flips
      expect(afterRepeats.endTime).toBe(t1); // untouched by the later calls

      // The in-flight dispatch's own rejection still reaches the tool's
      // catch handler, which will itself call `registry?.fail(...)`
      // (signal.aborted is false on this path — see the (a) "outer-signal"
      // test above for the branch where it's true). Prove `fail()`'s own
      // `status !== 'running'` guard keeps the already-cancelled outcome
      // from being overwritten.
      inflight!.reject(new Error('aborted by cancel'));
      const result = await exec;
      expect(result.error).toBeDefined();
      expect(registry.get(runId)!.status).toBe('cancelled');
    });
  });

  // ── (c) partial work is preserved and reused on resume ──────────────────
  describe('(c) partial work completed before cancel is preserved and reusable on resume', () => {
    it('an effect committed before a mid-run cancel is replayed, not re-run, on resume (durable counter marker)', async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'workflow-cancel-partial-'),
      );
      try {
        const counterFile = path.join(root, 'counter.json');
        await fs.writeFile(counterFile, JSON.stringify({ count: 0 }));
        // Durable, observable, out-of-band mutation — not a mock call
        // count. Mirrors workflow-durability.test.ts's `bumpCounter`.
        const bump = async (label: string): Promise<string> => {
          const current = JSON.parse(await fs.readFile(counterFile, 'utf8'));
          current.count += 1;
          await fs.writeFile(counterFile, JSON.stringify(current));
          return `${label}-done`;
        };

        const controller = new AbortController();
        const journalPath = path.join(root, 'journal.jsonl');
        const journal = new WorkflowJournal(journalPath);
        const script =
          'const a = await agent("first"); const b = await agent("second"); return [a, b];';
        const args = { fixture: 'cancel-partial' };

        const dispatch: WorkflowAgentDispatch = async (prompt) => {
          const result = await bump(prompt);
          if (prompt === 'first') {
            // The cancel lands right as the first dispatch's effect and
            // result are committing — e.g. Esc/SIGINT fired mid-run. The
            // second `agent()` call's `signal.throwIfAborted()`
            // (workflow-orchestrator.ts countedDispatch, ~line 1528/1551)
            // then rejects before ever invoking this dispatch again — the
            // first call's own effect_complete/result persistence is NOT
            // gated on the signal, so it still lands durably.
            controller.abort();
          }
          return result;
        };

        await expect(
          new WorkflowOrchestrator(dispatch).run({
            script,
            args,
            journal,
            abortOnTimeout: controller,
          }),
        ).rejects.toThrow(/abort/i);

        // Exactly one effect ran before the cancel took hold.
        expect(JSON.parse(await fs.readFile(counterFile, 'utf8')).count).toBe(1);
        const entries = (await fs.readFile(journalPath, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { type: string });
        expect(entries.map((e) => e.type)).toEqual([
          'started',
          'effect_complete',
          'result',
        ]);

        // Resume: fresh journal handle reading the same on-disk file,
        // fresh dispatch, no more aborting — mirrors a real process
        // restart / continued session after the cancel was acknowledged.
        const resumeJournal = new WorkflowJournal(journalPath);
        const replay = await resumeJournal.load();
        const resumedDispatch = vi.fn(bump);
        const outcome = await new WorkflowOrchestrator(resumedDispatch).run({
          script,
          args,
          journal: resumeJournal,
          resumeReplay: replay,
        });

        expect(outcome.result).toEqual(['first-done', 'second-done']);
        // The durable proof: only ONE more effect ran (the second call).
        // If "first" had been silently re-dispatched, this would be 3.
        expect(JSON.parse(await fs.readFile(counterFile, 'utf8')).count).toBe(2);
        expect(resumedDispatch).toHaveBeenCalledTimes(1);
        expect(resumedDispatch).toHaveBeenCalledWith('second', expect.anything());
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  // ── (d) cancellation isolation ───────────────────────────────────────────
  describe('(d) cancellation does not abort unrelated concurrent runs', () => {
    it('cancelling run A leaves run B untouched and able to complete normally', async () => {
      const { config, registry } = configWithRegistry();
      const pending: Record<string, { resolve: (v: string) => void; reject: (e: Error) => void }> = {};
      const dispatch: WorkflowAgentDispatch = (prompt) =>
        new Promise((resolve, reject) => {
          pending[prompt] = { resolve, reject };
        });

      const execA = new WorkflowTool(config, { dispatch })
        .build({ script: 'return await agent("task-a");' })
        .execute(new AbortController().signal);
      const execB = new WorkflowTool(config, { dispatch })
        .build({ script: 'return await agent("task-b");' })
        .execute(new AbortController().signal);

      for (
        let i = 0;
        i < 200 && !(pending['task-a'] && pending['task-b'] && registry.list().length === 2);
        i++
      ) {
        await sleep(10);
      }
      expect(registry.list()).toHaveLength(2);
      const entryA = registry.list().find((e) => e.script.includes('task-a'))!;
      const entryB = registry.list().find((e) => e.script.includes('task-b'))!;
      expect(entryA.runId).not.toBe(entryB.runId);

      registry.cancel(entryA.runId, Date.now());
      expect(registry.get(entryA.runId)!.status).toBe('cancelled');
      // Isolation: B's own controller must be completely untouched by A's
      // cancellation — no shared abort fan-out across unrelated runs.
      expect(entryB.abortController.signal.aborted).toBe(false);
      expect(registry.get(entryB.runId)!.status).toBe('running');

      pending['task-a']!.reject(new Error('aborted by cancel'));
      const resultA = await execA;
      expect(resultA.error).toBeDefined();
      expect(registry.get(entryA.runId)!.status).toBe('cancelled');

      // B proceeds and completes as if nothing happened to A. (Its own
      // controller IS aborted at the very end by workflow.ts's own
      // `finally` — "T40: cancel any straggler subagent on natural
      // completion" — that is normal self-cleanup on ANY terminal path,
      // not a symptom of A's cancellation, so it is not asserted against
      // here; the isolation claim is the pre-resolution check above.)
      pending['task-b']!.resolve('b-result');
      const resultB = await execB;
      expect(resultB.error).toBeUndefined();
      expect(registry.get(entryB.runId)!.status).toBe('completed');
    });
  });

  // ── (e) the snapshot/finally path, and the grace-wait gap hypothesis ────
  describe('(e) the snapshot/finally path runs on abort (and the known grace-wait gap)', () => {
    it("writes the terminal snapshot when the compensating grace wait is granted (registry not pre-cancelled)", async () => {
      // Control case: mirrors gemini.tsx's compensating cleanup block
      // (gemini.tsx:771-783) in ISOLATION, i.e. exactly the precondition
      // the existing regression test gemini.sigint-workflow-abort.test.ts
      // exercises with its `hasRunningEntries: vi.fn(() => true)` mock —
      // the registry has NOT already been cancelled by something else.
      const { config, registry, storage, cleanup } = await configWithStorage();
      const REACTION_MS = 30; // dispatch's own abort-observation delay
      const GRACE_MS = 300; // gemini.tsx's literal constant

      const dispatch: WorkflowAgentDispatch = () =>
        new Promise((_resolve, reject) => {
          const entry = registry.list()[0];
          const onAbort = () =>
            setTimeout(
              () => reject(new DOMException('Workflow aborted.', 'AbortError')),
              REACTION_MS,
            );
          if (entry.abortController.signal.aborted) onAbort();
          else entry.abortController.signal.addEventListener('abort', onAbort, { once: true });
        });

      const tool = new WorkflowTool(config, { dispatch });
      const exec = tool
        .build({ script: 'return await agent("q1");' })
        .execute(new AbortController().signal);

      for (let i = 0; i < 200 && registry.list().length === 0; i++) await sleep(10);
      const runId = registry.list()[0]!.runId;
      const snapshotPath = storage.getWorkflowRunSnapshotPath(runId);

      try {
        // gemini.tsx:771-783, quoted:
        //   const workflowRegistry = config.getWorkflowRunRegistry?.();
        //   if (!workflowRegistry?.hasRunningEntries()) { return; }
        //   workflowRegistry.abortAll();
        //   await new Promise((resolve) => setTimeout(resolve, 300));
        expect(registry.hasRunningEntries()).toBe(true); // precondition holds
        registry.abortAll();
        await sleep(GRACE_MS);

        // The 300ms grace window comfortably covers the 30ms dispatch
        // reaction + the finally block's fs write, so the snapshot exists.
        const stat = await fs.stat(snapshotPath).catch(() => undefined);
        expect(stat).toBeDefined();

        const result = await exec;
        expect(result.error).toBeDefined();
        expect(registry.get(runId)!.status).toBe('cancelled');
      } finally {
        await cleanup();
      }
    });

    it('KNOWN GAP: when Config.shutdown() has already cancelled the registry first (the real SIGINT ordering), the compensating grace wait never runs and the snapshot is not given a chance to land', async () => {
      // Reproduces the REAL cleanup ordering, not the isolated mock the
      // existing gemini.sigint-workflow-abort.test.ts uses. In gemini.tsx,
      // cleanups run FIFO (utils/cleanup.ts: `for (const fn of
      // cleanupFunctions)`), and:
      //   gemini.tsx:759  registerCleanup(() => config.shutdown());
      //   gemini.tsx:771  registerCleanup(async () => { ...compensating block... });
      // `config.shutdown()` (config.ts:4252) itself calls
      // `this.workflowRunRegistry.abortAll()` — proven by
      // config.shutdown-workflow-abort.test.ts's "aborts the controller and
      // cancels a running workflow entry" test, whose own comment already
      // flags this: "by the time config.shutdown() resolves,
      // hasRunningEntries() is already false ... so that block's
      // `if (!workflowRegistry?.hasRunningEntries()) return;` now
      // short-circuits and the grace wait never runs."
      //
      // Step 1 below IS `config.shutdown()`'s effect on this registry
      // (calling the same `abortAll()` it calls internally). Step 2 is
      // gemini.tsx's compensating block, verbatim, run second — exactly
      // the FIFO order `runExitCleanup` uses.
      const { config, registry, storage, cleanup } = await configWithStorage();
      const REACTION_MS = 30;

      const dispatch: WorkflowAgentDispatch = () =>
        new Promise((_resolve, reject) => {
          const entry = registry.list()[0];
          const onAbort = () =>
            setTimeout(
              () => reject(new DOMException('Workflow aborted.', 'AbortError')),
              REACTION_MS,
            );
          if (entry.abortController.signal.aborted) onAbort();
          else entry.abortController.signal.addEventListener('abort', onAbort, { once: true });
        });

      const tool = new WorkflowTool(config, { dispatch });
      const exec = tool
        .build({ script: 'return await agent("q1");' })
        .execute(new AbortController().signal);

      for (let i = 0; i < 200 && registry.list().length === 0; i++) await sleep(10);
      const runId = registry.list()[0]!.runId;
      const snapshotPath = storage.getWorkflowRunSnapshotPath(runId);

      try {
        // Step 1: config.shutdown() (config.ts:4252).
        registry.abortAll();

        // Step 2: gemini.tsx's compensating block (gemini.tsx:771-783),
        // run second, exactly as `runExitCleanup` drains it.
        const graceWaitEntered = { value: false };
        async function compensatingBlock(): Promise<void> {
          if (!registry.hasRunningEntries()) {
            return;
          }
          graceWaitEntered.value = true;
          registry.abortAll();
          await sleep(300);
        }
        await compensatingBlock();

        // Pin: the guard trips because step 1 already cancelled the entry,
        // so the grace wait's own `await sleep(300)` line is never reached.
        expect(graceWaitEntered.value).toBe(false);

        // Pin (the Gate 2-relevant consequence): "cleanup" is now
        // considered finished — in the real SIGINT path `process.exit()`
        // follows immediately — but the in-flight dispatch's abort
        // reaction (REACTION_MS) plus the finally block's snapshot write
        // have NOT had any bounded window reserved for them. The snapshot
        // does not exist yet.
        //
        // THIS IS THE FAILING ASSERTION THAT PINS THE GAP. Gate 2 requires
        // "preserved partial work" on cancellation, which for the native
        // Workflow tool depends on this snapshot write actually happening
        // before the process can exit. On the real SIGINT path nothing
        // guarantees that anymore.
        const stat = await fs.stat(snapshotPath).catch(() => undefined);
        expect(stat).toBeDefined();
      } finally {
        // Let the in-flight promise settle so the test doesn't leak a
        // pending timer/handle into the next test.
        await exec.catch(() => undefined);
        await cleanup();
      }
    });
  });
});
