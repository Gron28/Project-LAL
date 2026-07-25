/**
 * @license
 * Copyright 2025 Project-LAL
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyAgainstDraft,
  clearDraft,
  completeLinePrefix,
  draftPathFor,
  resetDraftRefusals,
  resumeMarker,
} from './resumable-draft.js';

describe('resumable draft reconciliation (PLAN 3.1)', () => {
  let dir: string;
  let target: string;

  const stage = (staged: string) => {
    fs.writeFileSync(draftPathFor(target), staged, 'utf8');
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lal-draft-'));
    target = path.join(dir, 'index.html');
    resetDraftRefusals();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports none when no draft was staged', () => {
    expect(classifyAgainstDraft(target, '<html></html>').kind).toBe('none');
  });

  it('recognises a resume: the new content begins with every complete staged line', () => {
    // The trailing "<div" is the line the stream was cut on, so it is not part of
    // the prefix a resume is measured against.
    stage('<html>\n<body>\n<div');
    const verdict = classifyAgainstDraft(target, '<html>\n<body>\n<div>ok</div>\n</body>\n</html>');
    expect(verdict.kind).toBe('resumed');
    if (verdict.kind !== 'resumed') throw new Error('unreachable');
    expect(verdict.reusedChars).toBe('<html>\n<body>\n'.length);
    expect(resumeMarker(verdict)).toContain('resume=from-draft');
  });

  it('refuses a restart that is smaller than the staged work', () => {
    stage('line one\nline two\nline three\nline fo');
    const verdict = classifyAgainstDraft(target, 'oops\n');
    expect(verdict.kind).toBe('refuse');
    if (verdict.kind !== 'refuse') throw new Error('unreachable');
    expect(verdict.message).toContain(draftPathFor(target));
    expect(verdict.message).toContain('read_file');
  });

  it('refuses at most once per path, so a determined model is never hard-blocked', () => {
    stage('line one\nline two\nline three\nline fo');
    expect(classifyAgainstDraft(target, 'oops\n').kind).toBe('refuse');
    const second = classifyAgainstDraft(target, 'oops\n');
    expect(second.kind).toBe('discarded');
    expect(resumeMarker(second)).toContain('resume=discarded-draft');
  });

  it('allows a larger divergent rewrite but labels it as regenerated', () => {
    stage('old start\nold middle\nold cut');
    const bigger = 'completely different\n'.repeat(20);
    const verdict = classifyAgainstDraft(target, bigger);
    expect(verdict.kind).toBe('discarded');
    expect(resumeMarker(verdict)).toContain('regenerated from scratch');
  });

  it('treats a draft with no complete line as advisory only', () => {
    stage('no newline anywhere');
    expect(classifyAgainstDraft(target, 'x').kind).toBe('discarded');
  });

  it('never throws on an unreadable draft — a telemetry artifact must not fail a write', () => {
    fs.mkdirSync(draftPathFor(target)); // a directory where a file is expected
    expect(classifyAgainstDraft(target, 'anything').kind).toBe('none');
  });

  it('clearDraft removes the consumed draft and tolerates a missing one', () => {
    stage('a\nb\n');
    clearDraft(draftPathFor(target));
    expect(fs.existsSync(draftPathFor(target))).toBe(false);
    expect(() => clearDraft(draftPathFor(target))).not.toThrow();
  });

  it('completeLinePrefix stops at the last newline', () => {
    expect(completeLinePrefix('a\nb\nc')).toBe('a\nb\n');
    expect(completeLinePrefix('no newline')).toBe('');
    expect(completeLinePrefix('trailing\n')).toBe('trailing\n');
  });
});
