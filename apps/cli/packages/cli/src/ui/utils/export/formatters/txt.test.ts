/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { toTxt } from './txt.js';
import type { ExportSessionData } from '../types.js';

const baseSession: ExportSessionData = {
  sessionId: 'sess-1',
  startTime: '2026-07-18T10:00:00.000Z',
  systemPrompt: 'You are a helpful local agent.',
  metadata: {
    sessionId: 'sess-1',
    startTime: '2026-07-18T10:00:00.000Z',
    exportTime: '2026-07-18T11:00:00.000Z',
    cwd: '/tmp/project',
    model: 'qwen3-8b',
    promptCount: 1,
    totalTokens: 1234,
    contextWindowSize: 16384,
    contextUsagePercent: 42,
    uniqueFiles: ['snake.html'],
  },
  messages: [
    {
      uuid: 'u1',
      timestamp: '2026-07-18T10:00:01.000Z',
      type: 'user',
      message: { parts: [{ text: 'build a snake game' }] },
    },
    {
      uuid: 'a1',
      timestamp: '2026-07-18T10:00:02.000Z',
      type: 'assistant',
      message: { role: 'thinking', parts: [{ text: 'I should use canvas.' }] },
    },
    {
      uuid: 't1',
      timestamp: '2026-07-18T10:00:03.000Z',
      type: 'tool_call',
      toolCall: {
        toolCallId: 'call-1',
        kind: 'edit',
        title: 'WriteFile',
        status: 'failed',
        rawInput: { file_path: 'snake.html', content: '<canvas>' },
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'EACCES: permission denied' },
          },
        ],
      },
    },
    {
      uuid: 'a2',
      timestamp: '2026-07-18T10:00:04.000Z',
      type: 'assistant',
      message: { role: 'assistant', parts: [{ text: 'The write failed.' }] },
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        totalTokenCount: 150,
      },
    },
  ],
};

describe('toTxt', () => {
  it('renders the full forensic transcript', () => {
    const txt = toTxt(baseSession);

    // Header + system prompt
    expect(txt).toContain('LAL CLI SESSION REPORT');
    expect(txt).toContain('Session:   sess-1');
    expect(txt).toContain('Model:     qwen3-8b');
    expect(txt).toContain('SYSTEM PROMPT');
    expect(txt).toContain('You are a helpful local agent.');

    // Thinking is labelled and verbatim
    expect(txt).toContain('ASSISTANT — THINKING');
    expect(txt).toContain('I should use canvas.');

    // Tool failure is loud, with full input and output
    expect(txt).toContain('TOOL CALL — WriteFile [!! FAILED !!]');
    expect(txt).toContain('"file_path": "snake.html"');
    expect(txt).toContain('EACCES: permission denied');

    // Per-message token usage
    expect(txt).toContain('tokens: in=100 out=50 total=150');

    // Summary counts the failure
    expect(txt).toContain('Tool calls: 1 (1 failed)');
    expect(txt).toContain('- #3 WriteFile');
  });

  it('omits the system prompt section when unavailable', () => {
    const txt = toTxt({ ...baseSession, systemPrompt: undefined });
    expect(txt).not.toContain('SYSTEM PROMPT');
  });
});
