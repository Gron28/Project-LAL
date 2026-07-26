/**
 * @license
 * Copyright 2025 Project-LAL
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';

/**
 * The read half of the resumable writer (PLAN 3.1).
 *
 * When a stream dies mid-`write_file`, `openaiContentGenerator/pipeline.ts`
 * stages the characters that already arrived at `<target>.lal-partial` and tells
 * the model to continue from the last complete line. That was advice, and advice
 * is not a mechanism: PLAN rule 4 is "the model proposes; the runtime decides",
 * and PLAN 3.1's acceptance criterion is "no already-accepted generated content
 * is ever regenerated". Nothing checked whether the model actually resumed, so a
 * regeneration was indistinguishable from a resume — including to HTML-001,
 * whose condition 7 has been `null` for exactly this reason.
 *
 * This module classifies the next write against the staged draft. It is
 * deliberately not clever: there is no attempt to detect a "continuation" and
 * splice it on, because a wrong splice corrupts a file the user asked for, which
 * is worse than the regeneration it would have saved. Only three outcomes exist,
 * and each rests on a fact rather than a guess.
 */

export const DRAFT_SUFFIX = '.lal-partial';

export type DraftVerdict =
  /** No draft staged for this path — the ordinary case. */
  | { kind: 'none' }
  /** The new content begins with everything the draft had. Work was reused. */
  | { kind: 'resumed'; draftPath: string; reusedChars: number }
  /**
   * The new content is SHORTER than what is already staged and does not contain
   * it. Accepting this provably destroys generated work, so the write is
   * refused once with instructions. Refused at most once per path: if the model
   * insists, progress beats purity and the second attempt is allowed through as
   * `discarded`.
   */
  | { kind: 'refuse'; draftPath: string; stagedChars: number; incomingChars: number; message: string }
  /** The draft was thrown away by a full rewrite. Allowed, but counted. */
  | { kind: 'discarded'; draftPath: string; stagedChars: number };

/** Paths already refused once, so a determined model is never hard-blocked. */
const refusedOnce = new Set<string>();

/** Test seam — the set is module state that would otherwise leak across cases. */
export function resetDraftRefusals(): void {
  refusedOnce.clear();
}

export function draftPathFor(filePath: string): string {
  return `${filePath}${DRAFT_SUFFIX}`;
}

/**
 * The staged text up to its last complete line. The final line of an
 * interrupted stream was cut mid-token, so it is never part of the prefix a
 * resume is measured against — the same rule the staging side applies when it
 * tells the model where to continue from.
 */
export function completeLinePrefix(staged: string): string {
  const lastNewline = staged.lastIndexOf('\n');
  return lastNewline === -1 ? '' : staged.slice(0, lastNewline + 1);
}

/**
 * Classify `content` against any draft staged for `filePath`. Never throws: an
 * unreadable draft yields `none`, because failing a user's write over a
 * telemetry artifact would be a worse bug than the one this fixes.
 */
export function classifyAgainstDraft(filePath: string, content: string): DraftVerdict {
  const draftPath = draftPathFor(filePath);
  let staged: string;
  try {
    if (!fs.existsSync(draftPath)) return { kind: 'none' };
    staged = fs.readFileSync(draftPath, 'utf8');
  } catch {
    return { kind: 'none' };
  }
  if (!staged) return { kind: 'none' };

  const prefix = completeLinePrefix(staged);
  // A draft with no newline at all has no verifiable prefix to resume from.
  // Treat it as advisory only rather than inventing a boundary.
  if (!prefix) return { kind: 'discarded', draftPath, stagedChars: staged.length };

  if (content.startsWith(prefix)) {
    return { kind: 'resumed', draftPath, reusedChars: prefix.length };
  }

  if (content.length < prefix.length && !refusedOnce.has(filePath)) {
    refusedOnce.add(filePath);
    return {
      kind: 'refuse',
      draftPath,
      stagedChars: prefix.length,
      incomingChars: content.length,
      message:
        `Refused: this write would destroy generated work.\n` +
        `${prefix.length} characters were already generated for "${filePath}" and are ` +
        `staged at:\n  ${draftPath}\n` +
        `The content just submitted is ${content.length} characters and does not begin ` +
        `with what is already staged, so it is a restart, not a continuation — and it ` +
        `is smaller than what exists.\n\n` +
        `Do this instead:\n` +
        `1. read_file "${draftPath}".\n` +
        `2. Write the staged content back VERBATIM as the beginning of the file, then ` +
        `append only the part that is still missing.\n` +
        `Regenerating from the beginning is what exhausted the response that failed ` +
        `here; it will fail the same way.`,
    };
  }

  return { kind: 'discarded', draftPath, stagedChars: prefix.length };
}

/**
 * Remove a consumed draft. Called only after the real file is written, so a
 * failed write leaves the staged work exactly where it was.
 */
export function clearDraft(draftPath: string): void {
  try {
    fs.unlinkSync(draftPath);
  } catch {
    // A draft we cannot delete is stale telemetry, not a failed write.
  }
}

/**
 * The line appended to a successful write's tool result.
 *
 * The marker is machine-readable on purpose: HTML-001 reads the trace, not the
 * process, so `resume=` is how conditions 7 and 8 become measurable instead of
 * `null`.
 */
export function resumeMarker(verdict: DraftVerdict): string | null {
  switch (verdict.kind) {
    case 'resumed':
      return `resume=from-draft reused=${verdict.reusedChars}chars (staged work was continued, not regenerated)`;
    case 'discarded':
      return `resume=discarded-draft staged=${verdict.stagedChars}chars (the staged partial was NOT reused — this content was regenerated from scratch)`;
    default:
      return null;
  }
}
