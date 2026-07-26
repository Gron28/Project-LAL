/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

// PLAN 2.4, step 3: the completion guards as PURE predicates.
//
// The web tool loop (web/src/lib/toolloop.ts) refuses to accept a completion
// claim it has not seen evidence for. The CLI path — the one `lal` runs, the
// one shipped to Windows, and the one HTML-001 measures — had none of those
// guards, which is why a run could write nothing (or write and never check)
// and still report success. Both surfaces should reach the SAME verdict for
// the same turn, so the decision lives here as data-in/data-out with no I/O,
// importable by either runtime.
//
// Deliberately pure: no Config, no chat history, no fetch. That is what makes
// it testable without a model and what will let the web loop adopt it without
// dragging CLI types across the boundary.

import { ToolNames } from '../tools/tool-names.js';

/** Tools whose successful execution counts as "the model changed something". */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.NOTEBOOK_EDIT,
]);

/**
 * Tools that count as inspecting what was produced. `run_shell_command` counts
 * because that is how a page/script/test is actually exercised; re-reading the
 * file you just wrote also counts, since it at least confronts the model with
 * the real bytes rather than its memory of them.
 */
export const VERIFYING_TOOL_NAMES: ReadonlySet<string> = new Set([
  ToolNames.READ_FILE,
  ToolNames.SHELL,
]);

export interface TurnToolActivity {
  /** Names of tools that ran during this request, in order. */
  readonly toolNames: readonly string[];
  /** How many verification nudges have already been issued this request. */
  readonly verifyNudgeCount: number;
}

export type CompletionVerdict =
  | { kind: 'accept' }
  | { kind: 'nudge-verify'; reason: string };

/** Longest a single request may be nudged before we stop and let it finish. */
export const MAX_VERIFY_NUDGES = 1;

export function wroteFiles(activity: TurnToolActivity): boolean {
  return activity.toolNames.some((n) => MUTATING_TOOL_NAMES.has(n));
}

export function verifiedAfterWriting(activity: TurnToolActivity): boolean {
  const lastWrite = activity.toolNames.reduce(
    (acc, name, i) => (MUTATING_TOOL_NAMES.has(name) ? i : acc),
    -1,
  );
  if (lastWrite === -1) return false;
  // Only inspection that happened AFTER the last mutation counts. Reading a
  // file, then overwriting it, then declaring success is the exact shape of
  // the "hallucinated verification" failures in the field reports.
  return activity.toolNames
    .slice(lastWrite + 1)
    .some((n) => VERIFYING_TOOL_NAMES.has(n));
}

/**
 * Decide whether a turn that produced a final answer may be accepted.
 *
 * The only refusal today is "you wrote files and never looked at them". It is
 * bounded to MAX_VERIFY_NUDGES so a model that ignores the nudge still
 * terminates — progress beats purity, the same trade-off PLAN 3.1 made for the
 * write stash.
 */
export function judgeCompletion(
  activity: TurnToolActivity,
): CompletionVerdict {
  if (activity.verifyNudgeCount >= MAX_VERIFY_NUDGES) return { kind: 'accept' };
  if (!wroteFiles(activity)) return { kind: 'accept' };
  if (verifiedAfterWriting(activity)) return { kind: 'accept' };
  return {
    kind: 'nudge-verify',
    reason:
      'This turn wrote files but never inspected the result. Before claiming ' +
      'completion, verify what you actually produced: read the file back, or ' +
      'run it. If it is already correct, say so and stop.',
  };
}
