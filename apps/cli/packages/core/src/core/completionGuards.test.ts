/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { judgeCompletion, MAX_VERIFY_NUDGES } from './completionGuards.js';

const activity = (toolNames: string[], verifyNudgeCount = 0) => ({
  toolNames,
  verifyNudgeCount,
});

describe('judgeCompletion', () => {
  it('accepts a turn that wrote nothing — a question is not a broken promise', () => {
    expect(judgeCompletion(activity(['read_file', 'grep'])).kind).toBe('accept');
  });

  it('refuses a turn that wrote a file and never looked at it', () => {
    const verdict = judgeCompletion(activity(['write_file']));
    expect(verdict.kind).toBe('nudge-verify');
  });

  it('accepts when the file was read back after writing', () => {
    expect(judgeCompletion(activity(['write_file', 'read_file'])).kind).toBe(
      'accept',
    );
  });

  it('accepts when the result was executed after writing', () => {
    expect(
      judgeCompletion(activity(['write_file', 'run_shell_command'])).kind,
    ).toBe('accept');
  });

  it('does NOT count inspection that happened before the last write', () => {
    // read → write → "done" is the hallucinated-verification shape from the
    // field reports: the model inspected the OLD bytes and claimed the new
    // ones were fine.
    expect(judgeCompletion(activity(['read_file', 'write_file'])).kind).toBe(
      'nudge-verify',
    );
  });

  it('does not count inspection before the LAST of several writes', () => {
    expect(
      judgeCompletion(
        activity(['write_file', 'read_file', 'edit', 'write_file']),
      ).kind,
    ).toBe('nudge-verify');
  });

  it('treats edit and notebook_edit as mutations too', () => {
    expect(judgeCompletion(activity(['edit'])).kind).toBe('nudge-verify');
    expect(judgeCompletion(activity(['notebook_edit'])).kind).toBe(
      'nudge-verify',
    );
  });

  it('gives up after the nudge budget so an ignoring model still terminates', () => {
    // Progress beats purity: a model that ignores the nudge must not loop.
    expect(
      judgeCompletion(activity(['write_file'], MAX_VERIFY_NUDGES)).kind,
    ).toBe('accept');
  });

  it('names what to do, not just what is wrong', () => {
    const verdict = judgeCompletion(activity(['write_file']));
    if (verdict.kind !== 'nudge-verify') throw new Error('expected a nudge');
    expect(verdict.reason).toMatch(/read the file back, or/);
  });
});
