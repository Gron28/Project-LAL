/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Gate 2 ("Approval allow/deny and restart while waiting")
 * recovery-matrix tests for a workflow run — Worker T.
 *
 * FINDING (read the code first, per task instructions): there is NO durable
 * representation of a workflow-run approval DECISION anywhere in this
 * codebase. Two things could plausibly hold one and neither does:
 *
 *  1. `WorkflowJournal` (workflow-journal.ts) — the only on-disk state a
 *     workflow run produces — has exactly three entry types: `started`,
 *     `effect_complete`, `result` (workflow-journal.ts:47-85). All three
 *     describe an `agent()` DISPATCH the script makes; none of them, and
 *     nothing in `WorkflowOrchestrator` (workflow-orchestrator.ts), has any
 *     concept of "approval" — `grep -in approv` against both files returns
 *     zero matches. Journaling only starts once `.execute()` has already
 *     begun, i.e. strictly AFTER the tool call was approved.
 *
 *  2. The tool-call-level "one decision authorizes the whole script" gate
 *     documented at workflow.ts:194-211 is wired through
 *     `WorkflowToolInvocation.getConfirmationDetails()` (workflow.ts:212-225),
 *     whose `onConfirm` is a literal no-op: "persistence is handled by
 *     coreToolScheduler via PM rules" (workflow.ts:219-222). The actual
 *     pending state lives in `CoreToolScheduler.toolCalls`
 *     (coreToolScheduler.ts), a plain in-memory array with a live JS closure
 *     for `onConfirm` — nothing durable. The ONLY outcome that is ever
 *     written to disk is `ProceedAlways*`, via `persistPermissionOutcome`
 *     (permission-helpers.ts:182-225), and what it persists is a
 *     pattern-level ALLOW RULE, not a record of "this call, this decision".
 *     A plain approve-once or deny leaves zero durable trace anywhere.
 *
 * Consequence: "restart while waiting" (Gate 2's own scenario name) has no
 * substrate to recover from — the pending call is simply gone. And because
 * `WorkflowTool` exposes no scoping specifier (`getSpecifierKind('workflow')
 * → 'literal'`, no stable param matches — rule-parser.ts), the one
 * persistence path that DOES exist (`ProceedAlways*` → a bare `"workflow"`
 * allow rule) does not scope to the approved script at all: it authorizes
 * every future, unrelated workflow script. That is a live Gate 2 violation
 * of "approval ... does not authorize a different action" — see the
 * `[GATE-2 VIOLATION]` test below, which fails on purpose and is quoted
 * verbatim in the report.
 *
 * Sibling fixture patterns reused: `fakeConfig()` / `configWithRegistry()` /
 * direct `WorkflowTool` + injected `dispatch` construction from
 * ../../tools/workflow/workflow.test.ts; the raw-journal-file-read pattern
 * from that same file's "records its provenance" test; the real
 * `WorkflowOrchestrator` + `WorkflowJournal` construction from
 * workflow-durability.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkflowTool } from '../../tools/workflow/workflow.js';
import type { Config } from '../../config/config.js';
import { Storage } from '../../config/storage.js';
import { WorkflowRunRegistry } from '../workflow-run-registry.js';
import { ToolNames } from '../../tools/tool-names.js';
import {
  ToolConfirmationOutcome,
  type ToolInfoConfirmationDetails,
} from '../../tools/tools.js';
import { evaluatePermissionFlow } from '../../core/permissionFlow.js';
import { buildPermissionCheckContext } from '../../core/permission-helpers.js';
import { PermissionManager } from '../../permissions/permission-manager.js';
import { buildPermissionRules } from '../../permissions/rule-parser.js';

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return { ...overrides } as unknown as Config;
}

describe('workflow approval recovery (Gate 2)', () => {
  // ── 0. Durable representation ───────────────────────────────────────────
  describe('0. what is actually durable', () => {
    it('a completed run journal contains ZERO approval-related entries — the journal has no concept of approval at all', async () => {
      const projectDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'wf-approval-journal-'),
      );
      try {
        const registry = new WorkflowRunRegistry();
        const storage = new Storage(projectDir);
        const config = fakeConfig({
          getWorkflowRunRegistry: () => registry,
          storage,
        });
        const tool = new WorkflowTool(config, {
          dispatch: async (prompt: string) => `done:${prompt}`,
        });
        const invocation = tool.build({
          script: 'return await agent("first"); ',
        });
        const result = await invocation.execute(new AbortController().signal);
        expect(result.error).toBeUndefined();

        const entries = registry.list();
        expect(entries).toHaveLength(1);
        const journalPath = storage.getWorkflowRunJournalPath(
          entries[0].runId,
        );
        const raw = await fs.readFile(journalPath, 'utf8');
        const lines = raw
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));

        // Every entry is one of the three dispatch-lifecycle types...
        for (const entry of lines) {
          expect(['started', 'effect_complete', 'result']).toContain(
            entry.type,
          );
        }
        // ...and nothing in the raw text even mentions approval/confirmation.
        expect(raw.toLowerCase()).not.toMatch(/approv|confirm/);
      } finally {
        await fs.rm(projectDir, { recursive: true, force: true });
      }
    });

    it('a call still awaiting approval mints no runId and leaves no filesystem trace — there is nothing to recover on restart', async () => {
      const projectDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'wf-approval-pending-'),
      );
      try {
        const storage = new Storage(projectDir);
        const tool = new WorkflowTool(fakeConfig({ storage }));
        const invocation = tool.build({
          script: 'return await agent("would run after approval");',
        });

        // "The decision is made" — call the confirmation's onConfirm, but
        // never call execute(). This is the exact window Gate 2 names:
        // "restart while waiting" / a crash right as the decision lands.
        const details = (await invocation.getConfirmationDetails(
          new AbortController().signal,
        )) as ToolInfoConfirmationDetails;
        await details.onConfirm(ToolConfirmationOutcome.ProceedOnce);

        // No workflow run directory was ever created — runId is minted
        // inside execute() (workflow.ts ~275-276), which never ran.
        await expect(fs.stat(storage.getWorkflowRunsDir())).rejects.toThrow(
          /ENOENT/,
        );
        // The invocation object itself carries no new field either — a
        // second, independent read of its confirmation prompt is byte
        // identical, proving onConfirm recorded nothing observable.
        const detailsAgain = (await invocation.getConfirmationDetails(
          new AbortController().signal,
        )) as ToolInfoConfirmationDetails;
        expect(detailsAgain.prompt).toBe(details.prompt);
      } finally {
        await fs.rm(projectDir, { recursive: true, force: true });
      }
    });
  });

  // ── a. One approval must not authorize a different action ──────────────
  describe('a. approval for one action does not authorize a different action', () => {
    it('PROTECTED: a plain (non-"Always") decision on one invocation leaves a sibling invocation at its own independent "ask"', async () => {
      const tool = new WorkflowTool(fakeConfig());
      const invocationA = tool.build({ script: 'return 1;' });
      const invocationB = tool.build({
        script: 'return await agent("an unrelated later action");',
      });

      const detailsA = (await invocationA.getConfirmationDetails(
        new AbortController().signal,
      )) as ToolInfoConfirmationDetails;
      await detailsA.onConfirm(ToolConfirmationOutcome.ProceedOnce);

      // B was never touched by A's decision: it still independently asks,
      // and its disclosed scope is its own script, not A's.
      expect(await invocationB.getDefaultPermission()).toBe('ask');
      const detailsB = (await invocationB.getConfirmationDetails(
        new AbortController().signal,
      )) as ToolInfoConfirmationDetails;
      expect(detailsB.prompt).toContain('an unrelated later action');
      expect(detailsB.prompt).not.toContain('return 1');
    });

    it('[GATE-2 VIOLATION] "Always Allow" on one workflow script silently authorizes every future, unrelated workflow script', async () => {
      // Step 1 — reproduce exactly what the real persistence pipeline writes
      // for a workflow "Always Allow" outcome. WorkflowTool sets no
      // `permissionRules` of its own, so `injectPermissionRulesIfMissing`
      // (permission-helpers.ts:153-165) falls back to `buildPermissionRules`
      // (rule-parser.ts:469-536). `workflow` has no shell/path/domain
      // specifier kind (getSpecifierKind → 'literal', rule-parser.ts:197-202)
      // and none of WorkflowParams's fields (`script`/`scriptPath`/`args`/
      // `resumeFromRunId`) match the stable-param allowlist
      // (`model`/`subagent_type`/`skill`) — so the rule has NO specifier at
      // all.
      const pmCtx = buildPermissionCheckContext(
        ToolNames.WORKFLOW,
        { script: 'return 1;' },
        '/proj',
      );
      const rules = buildPermissionRules(pmCtx);
      expect(rules).toEqual(['workflow']); // bare — carries no script identity

      // Step 2 — persist it with a REAL PermissionManager, exactly as
      // `persistPermissionOutcome` does on ProceedAlwaysProject/User
      // (permission-helpers.ts:214-223: `pm.addPersistentRule(rule, 'allow')`).
      const pm = new PermissionManager({
        getPermissionsAllow: () => [],
        getPermissionsAsk: () => [],
        getPermissionsDeny: () => [],
        getProjectRoot: () => '/proj',
        getCwd: () => '/proj',
      });
      pm.initialize();
      pm.addPersistentRule(rules[0], 'allow');

      // Step 3 — a SECOND workflow script, never shown to the user, never
      // approved by name, arrives later.
      const config = fakeConfig({
        getPermissionManager: () => pm,
        getTargetDir: () => '/proj',
      });
      const tool = new WorkflowTool(config);
      const laterInvocation = tool.build({
        script:
          'return await agent("delete the production database via a spawned shell tool call");',
      });
      const flow = await evaluatePermissionFlow(
        config,
        laterInvocation,
        ToolNames.WORKFLOW,
        laterInvocation.params as unknown as Record<string, unknown>,
      );

      // Gate 2: "One durable scoped decision ... stale/repeated decisions
      // cannot authorize another action." The decision approved ONE
      // disclosed script; this asserts it must not silently allow a
      // completely different, undisclosed one.
      expect(flow.finalPermission).not.toBe('allow');
    });
  });

  // ── b. Denial must prevent execution ────────────────────────────────────
  describe('b. denial prevents execution (not silently retried into success)', () => {
    it('SEAM (documented, not fixed here): WorkflowToolInvocation.execute() has no internal check of the confirmation outcome — it runs unconditionally whenever called', async () => {
      // This is not itself a violation of Gate 2 — BaseToolInvocation's
      // contract (and workflow.ts:219-222's own comment) delegates
      // enforcement entirely to the caller (CoreToolScheduler), matching
      // every other tool (edit.ts/write-file.ts/shell.ts). But it means
      // "denial prevents execution" is NOT a property this test file (or
      // the workflow module) can verify or protect — it is 100% dependent
      // on CoreToolScheduler never calling `.execute()` for a call whose
      // status is not 'scheduled'. That guard lives at
      // coreToolScheduler.ts (e.g. the Cancel branch ~3296-3299, which sets
      // status 'cancelled' and returns without scheduling execution) and is
      // already exercised generically — independent of which tool is
      // pending — by coreToolScheduler.test.ts's many
      // `ToolConfirmationOutcome.Cancel` cases. This test only pins the
      // workflow-specific half of the boundary: execute() itself trusts the
      // caller completely.
      const tool = new WorkflowTool(fakeConfig());
      const invocation = tool.build({ script: 'return 42;' });
      // Never call getConfirmationDetails() or onConfirm() at all.
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(JSON.stringify(result.llmContent)).toContain('42');
    });
  });

  // ── c. A decision made before a restart ─────────────────────────────────
  describe('c. a decision made before a restart is honoured after the restart, exactly once', () => {
    it('[GATE-2 VIOLATION] resuming a run after its one decision was already made re-prompts for approval instead of honouring the prior decision', async () => {
      const projectDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'wf-approval-restart-'),
      );
      try {
        const registry = new WorkflowRunRegistry();
        const storage = new Storage(projectDir);
        const config = fakeConfig({
          getWorkflowRunRegistry: () => registry,
          storage,
        });
        const script = 'return await agent("step one");';

        // "Before the restart": the run's single decision is made and the
        // run executes (and, per requirement (a)'s journal, durably records
        // its agent() dispatch).
        const tool = new WorkflowTool(config, {
          dispatch: async (prompt: string) => `T:${prompt}`,
        });
        const first = tool.build({ script });
        const firstDetails = (await first.getConfirmationDetails(
          new AbortController().signal,
        )) as ToolInfoConfirmationDetails;
        await firstDetails.onConfirm(ToolConfirmationOutcome.ProceedOnce);
        await first.execute(new AbortController().signal);
        const runId = registry.list()[0].runId;
        expect(runId).toMatch(/^wf_[0-9a-f]+$/);

        // "The restart": the SAME run is resumed by runId (this is the one
        // real, disk-backed, restart-surviving handle the workflow system
        // has — resumeFromRunId reads the same on-disk journal). Gate 2
        // requires the earlier decision to be honoured once, not re-asked.
        const resumedTool = new WorkflowTool(config, {
          dispatch: async (prompt: string) => `T2:${prompt}`,
        });
        const resumed = resumedTool.build({
          script,
          resumeFromRunId: runId,
        });
        const permission = await resumed.getDefaultPermission();

        expect(permission).not.toBe('ask');
      } finally {
        await fs.rm(projectDir, { recursive: true, force: true });
      }
    });
  });

  // ── d. A repeated/replayed decision must not authorize later work ──────
  describe('d. a repeated or replayed decision cannot authorize a second, later action', () => {
    it('PROTECTED: replaying the same plain decision many times, including after a sibling action exists, authorizes nothing beyond its own call', async () => {
      const tool = new WorkflowTool(fakeConfig());
      const invocationA = tool.build({ script: 'return "a";' });
      const invocationB = tool.build({
        script: 'return await agent("second, later action");',
      });

      const detailsA = (await invocationA.getConfirmationDetails(
        new AbortController().signal,
      )) as ToolInfoConfirmationDetails;
      // Replay: fire the same decision object's onConfirm repeatedly and
      // out of order relative to B's construction.
      await detailsA.onConfirm(ToolConfirmationOutcome.ProceedOnce);
      await detailsA.onConfirm(ToolConfirmationOutcome.ProceedOnce);
      await detailsA.onConfirm(ToolConfirmationOutcome.Cancel);

      // B is untouched: still its own fresh 'ask', with its own scope.
      expect(await invocationB.getDefaultPermission()).toBe('ask');
      const detailsB = (await invocationB.getConfirmationDetails(
        new AbortController().signal,
      )) as ToolInfoConfirmationDetails;
      expect(detailsB.prompt).toContain('second, later action');

      // NOTE: this protection is coincidental, not designed — `onConfirm`
      // is a literal no-op (workflow.ts:219-222), so replaying it cannot
      // possibly do anything, to A or to B. The one path where a decision
      // DOES get durably remembered and reused across calls — "Always
      // Allow" → a persisted PermissionManager rule — is exactly the path
      // shown to fail requirement (a) above, because that persisted rule
      // has no specifier tying it back to the approved script.
    });
  });
});
