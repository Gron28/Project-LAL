/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';
import {
  buildNativeHiveWorkflowParams,
  NATIVE_HIVE_CODING_WORKFLOW,
} from './native-hive-recipe.js';

describe('native HIVE coding recipe', () => {
  it('skips repair and completes when the check confirms acceptance criteria met', async () => {
    const prompts: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      if (/Independently verify/.test(prompt)) {
        return { passed: true, evidence: 'all checks green' };
      }
      return `stage-${prompts.length}`;
    });
    const params = buildNativeHiveWorkflowParams('repair the parser');

    const outcome = await new WorkflowOrchestrator(dispatch).run(params);

    // Only 3 dispatches: Inspect, Implement, Check. Repair must not run
    // after a successful verification (the documented "repair always
    // runs" defect).
    expect(prompts).toHaveLength(3);
    expect(outcome.phases).toEqual(['Inspect', 'Implement', 'Check']);
    expect(prompts[0]).toMatch(/Inspect the current project/);
    expect(prompts[2]).toMatch(/Independently verify/);
    expect(maxInFlight).toBe(1);
    expect(outcome.result).toMatchObject({
      objective: 'repair the parser',
      inspection: 'stage-1',
      implementation: 'stage-2',
      repair: null,
    });
    expect(
      (outcome.result as { verification: unknown }).verification,
    ).toEqual({ passed: true, evidence: 'all checks green' });
  });

  it('runs bounded repair on an unmet check and completes once repair confirms a fix', async () => {
    const prompts: string[] = [];
    const dispatch = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      if (/Independently verify/.test(prompt)) {
        return {
          passed: false,
          evidence: 'lint failed',
          unmetCriteria: ['lint must pass'],
        };
      }
      if (/Review the verification/.test(prompt)) {
        return { fixed: true, evidence: 'lint now passes' };
      }
      return `stage-${prompts.length}`;
    });
    const params = buildNativeHiveWorkflowParams('repair the parser');

    const outcome = await new WorkflowOrchestrator(dispatch).run(params);

    expect(prompts).toHaveLength(4);
    expect(outcome.phases).toEqual(['Inspect', 'Implement', 'Check', 'Repair']);
    // The repair prompt must carry the check's diagnostic forward.
    expect(prompts[3]).toContain('lint failed');
    expect(outcome.result).toMatchObject({
      objective: 'repair the parser',
      repair: { fixed: true, evidence: 'lint now passes' },
    });
  });

  it('does not report complete when repair cannot confirm the criteria are met (false-completion guard)', async () => {
    const dispatch = vi.fn(async (prompt: string) => {
      if (/Independently verify/.test(prompt)) {
        return { passed: false, evidence: 'tests fail', unmetCriteria: ['tests'] };
      }
      if (/Review the verification/.test(prompt)) {
        return {
          fixed: false,
          evidence: 'still failing after attempted repair',
          remainingUnmet: ['tests'],
        };
      }
      return 'ok';
    });
    const params = buildNativeHiveWorkflowParams('repair the parser');

    // Before the fix, the script always returned normally regardless of
    // whether verification/repair ever established success — this run must
    // now reject instead of resolving with a false "complete" result.
    await expect(new WorkflowOrchestrator(dispatch).run(params)).rejects.toThrow(
      /native HIVE incomplete/,
    );
  });

  it('does not report complete when the check never produces a verifiable verdict (unchecked guard)', async () => {
    const dispatch = vi.fn(async (prompt: string) => {
      if (/Independently verify/.test(prompt)) {
        // No structured verdict at all (e.g. the model ignored the schema
        // contract and returned prose) — this must count as "unchecked",
        // never as an implicit pass.
        return 'I looked around, seems fine';
      }
      if (/Review the verification/.test(prompt)) {
        return 'made a change, should be ok now';
      }
      return 'ok';
    });
    const params = buildNativeHiveWorkflowParams('repair the parser');

    await expect(new WorkflowOrchestrator(dispatch).run(params)).rejects.toThrow(
      /native HIVE blocked/,
    );
  });

  it('keeps unmet ("incomplete") and unchecked ("blocked") outcomes distinguishable', async () => {
    const unmetDispatch = vi.fn(async (prompt: string) => {
      if (/Independently verify/.test(prompt)) {
        return { passed: false, evidence: 'fails', unmetCriteria: ['x'] };
      }
      if (/Review the verification/.test(prompt)) {
        return { fixed: false, evidence: 'still fails' };
      }
      return 'ok';
    });
    const unmetOutcome = new WorkflowOrchestrator(unmetDispatch).run(
      buildNativeHiveWorkflowParams('repair the parser'),
    );

    const uncheckedDispatch = vi.fn(async (prompt: string) => {
      if (/Independently verify/.test(prompt) || /Review the verification/.test(prompt)) {
        return 'no structured verdict here';
      }
      return 'ok';
    });
    const uncheckedOutcome = new WorkflowOrchestrator(uncheckedDispatch).run(
      buildNativeHiveWorkflowParams('repair the parser'),
    );

    await expect(unmetOutcome).rejects.toThrow(/native HIVE incomplete/);
    await expect(unmetOutcome).rejects.not.toThrow(/native HIVE blocked/);
    await expect(uncheckedOutcome).rejects.toThrow(/native HIVE blocked/);
    await expect(uncheckedOutcome).rejects.not.toThrow(/native HIVE incomplete/);
  });

  it('reports blocked, not complete, when a criterion has no executable check in this project', async () => {
    const dispatch = vi.fn(async (prompt: string) => {
      if (/Independently verify/.test(prompt)) {
        // Nothing was actually run and nothing actually failed — the
        // project simply defines no test command. This must NOT be folded
        // into unmetCriteria (that would misreport a real failing check).
        return {
          passed: false,
          evidence: 'inspected package.json: no test script is defined in this project',
          blockedCriteria: ['automated test command'],
        };
      }
      if (/Review the verification/.test(prompt)) {
        // Repair legitimately cannot invent a project-appropriate test
        // command, so it stays blocked after a fresh recheck too.
        return {
          fixed: false,
          evidence: 'still no test command defined after inspecting the project again',
          remainingBlocked: ['automated test command'],
        };
      }
      return 'ok';
    });
    const params = buildNativeHiveWorkflowParams('add a helper function');

    await expect(new WorkflowOrchestrator(dispatch).run(params)).rejects.toThrow(
      /native HIVE blocked/,
    );
    await expect(new WorkflowOrchestrator(dispatch).run(params)).rejects.not.toThrow(
      /native HIVE incomplete/,
    );
  });

  it('reports incomplete, not complete, when a criterion has a failing executable check', async () => {
    const dispatch = vi.fn(async (prompt: string) => {
      if (/Independently verify/.test(prompt)) {
        // A real command was actually run and it actually failed.
        return {
          passed: false,
          evidence: 'ran `npm test`, exit code 1: 2 failing specs',
          unmetCriteria: ['npm test'],
        };
      }
      if (/Review the verification/.test(prompt)) {
        return {
          fixed: false,
          evidence: 'ran `npm test` again after the attempted fix, exit code 1: 1 failing spec',
          remainingUnmet: ['npm test'],
        };
      }
      return 'ok';
    });
    const params = buildNativeHiveWorkflowParams('fix the failing parser test');

    // failing-then-passing pair (first half): the run must reject as
    // incomplete, never resolve, while the executable check is failing.
    await expect(new WorkflowOrchestrator(dispatch).run(params)).rejects.toThrow(
      /native HIVE incomplete/,
    );
  });

  it('completes when a criterion has a passing executable check', async () => {
    const dispatch = vi.fn(async (prompt: string) => {
      if (/Independently verify/.test(prompt)) {
        // Same scenario as the previous test, but the executable check now
        // passes — fresh, executed, exit-code evidence justifies `complete`.
        return {
          passed: true,
          evidence: 'ran `npm test`, exit code 0: all specs pass',
        };
      }
      return 'ok';
    });
    const params = buildNativeHiveWorkflowParams('fix the failing parser test');

    // failing-then-passing pair (second half): identical objective/params
    // shape as above, only the Check phase's fresh evidence differs, and
    // now the run resolves instead of throwing.
    const outcome = await new WorkflowOrchestrator(dispatch).run(params);
    expect(outcome.result).toMatchObject({
      objective: 'fix the failing parser test',
      repair: null,
    });
    expect(
      (outcome.result as { verification: unknown }).verification,
    ).toEqual({ passed: true, evidence: 'ran `npm test`, exit code 0: all specs pass' });
  });

  it('default acceptance criteria demand executable evidence and forbid inventing project commands', () => {
    const { args } = buildNativeHiveWorkflowParams('add a helper function');
    const joined = args.definitionOfDone.join(' | ');
    // Measurable, not prose: every criterion that names a check is
    // conditioned on the project defining that check itself, with an exit
    // code as evidence, and an explicit escape hatch to "blocked" instead of
    // a guessed command.
    expect(joined).toMatch(/exit code/);
    expect(joined).toMatch(/reported blocked rather than passed or failed/);
    expect(joined).not.toMatch(/\bnpm\b/);
    expect(joined).not.toMatch(/\byarn\b/);
  });

  it('Check/Repair prompts instruct distinguishing an unmet (checked, failed) criterion from a blocked (uncheckable) one', () => {
    expect(NATIVE_HIVE_CODING_WORKFLOW).toContain('blockedCriteria');
    expect(NATIVE_HIVE_CODING_WORKFLOW).toContain('remainingBlocked');
    expect(NATIVE_HIVE_CODING_WORKFLOW).toMatch(/do not guess/);
  });

  it('contains no parallel or pipeline branch', () => {
    expect(NATIVE_HIVE_CODING_WORKFLOW).not.toContain('parallel(');
    expect(NATIVE_HIVE_CODING_WORKFLOW).not.toContain('pipeline(');
  });

  it('rejects an empty objective before starting a workflow', () => {
    expect(() => buildNativeHiveWorkflowParams('   ')).toThrow(
      /non-empty objective/,
    );
  });
});
