/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content, Part } from '@google/genai';
import {
  collectToolCallIdsFromHistory,
  dedupeToolCallsById,
  getProviderToolCallId,
  normalizeModelToolCallIds,
} from './toolCallIdUtils.js';

describe('toolCallIdUtils', () => {
  it('suffixes cross-turn duplicate ids and drops same-turn replays', () => {
    const history: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'dup_id_0001',
              name: 'read_file',
              args: { file_path: 'a.ts' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'dup_id_0001',
              name: 'read_file',
              response: { output: 'A' },
            },
          },
        ],
      },
    ];
    const seenIds = collectToolCallIdsFromHistory(history);
    const turnRawIds = new Set<string>();
    const parts: Part[] = [
      {
        functionCall: {
          id: 'dup_id_0001',
          name: 'read_file',
          args: { file_path: 'b.ts' },
        },
      },
      {
        functionCall: {
          id: 'dup_id_0001',
          name: 'read_file',
          args: { file_path: 'b.ts' },
        },
      },
      { text: 'done' },
    ];

    const normalized = normalizeModelToolCallIds(parts, seenIds, turnRawIds);

    expect(normalized).toEqual([
      {
        functionCall: {
          id: 'dup_id_0001__qwen_dup_2',
          name: 'read_file',
          args: { file_path: 'b.ts' },
        },
      },
      { text: 'done' },
    ]);
    expect(getProviderToolCallId(normalized[0]!.functionCall!)).toBe(
      'dup_id_0001',
    );
    expect(seenIds.has('dup_id_0001__qwen_dup_2')).toBe(true);
  });

  it('generates stable non-empty ids for missing functionCall ids', () => {
    const seenIds = new Set<string>(['call_qwen_1']);

    const normalized = normalizeModelToolCallIds(
      [
        { functionCall: { name: 'first', args: {} } },
        { functionCall: { name: 'second', args: {} } },
      ],
      seenIds,
      new Set<string>(),
    );

    expect(normalized.map((part) => part.functionCall?.id)).toEqual([
      'call_qwen_2',
      'call_qwen_3',
    ]);
    expect(
      normalized.map((part) => getProviderToolCallId(part.functionCall!)),
    ).toEqual([undefined, undefined]);
  });

  it('deduplicates direct function call batches by id', () => {
    const calls = [
      { id: 'call_1', name: 'read_file', args: { file_path: 'a.ts' } },
      { id: 'call_1', name: 'read_file', args: { file_path: 'a.ts' } },
      { id: 'call_2', name: 'read_file', args: { file_path: 'b.ts' } },
      { name: 'missing_id', args: {} },
      { name: 'missing_id_again', args: {} },
    ];

    expect(dedupeToolCallsById(calls)).toEqual([
      calls[0],
      calls[2],
      calls[3],
      calls[4],
    ]);
  });
});

describe('normalizeModelToolCallIds under a provider that reuses one id', () => {
  // llama-server b9835 emits the SAME tool_call id for every call it ever
  // makes (PLAN 2.1a). Keying same-turn replay detection on the id alone meant
  // a parallel batch lost every call after the first — silently, with only a
  // debug log. The model asked for three reads, got one answer, and re-asked;
  // that is a runtime defect that reads as the model looping.
  const CONSTANT = 'ZsSt4SkIFMRz0HtqT7MTlimNvzlKM896';

  it('keeps every distinct call in a parallel batch and gives each a unique id', () => {
    const parts = [
      { functionCall: { id: CONSTANT, name: 'read_file', args: { p: 'a.ts' } } },
      { functionCall: { id: CONSTANT, name: 'read_file', args: { p: 'b.ts' } } },
      { functionCall: { id: CONSTANT, name: 'glob', args: { pattern: '*.ts' } } },
    ];

    const out = normalizeModelToolCallIds(parts, new Set(), new Set());

    expect(out).toHaveLength(3);
    expect(out.map((p) => p.functionCall?.args)).toEqual([
      { p: 'a.ts' },
      { p: 'b.ts' },
      { pattern: '*.ts' },
    ]);
    const ids = out.map((p) => p.functionCall?.id);
    expect(new Set(ids).size).toBe(3);
    // The provider's raw id is preserved for diagnostics on all three.
    for (const p of out) {
      expect(getProviderToolCallId(p.functionCall!)).toBe(CONSTANT);
    }
  });

  it('still drops a genuine same-turn replay of one identical call', () => {
    const call = {
      functionCall: { id: CONSTANT, name: 'read_file', args: { p: 'a.ts' } },
    };
    const out = normalizeModelToolCallIds([call, { ...call }], new Set(), new Set());
    expect(out).toHaveLength(1);
  });
});
