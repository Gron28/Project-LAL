/**
 * @license
 * Copyright 2025 Project-LAL
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ChatRecord } from '@lal/core';
import { collectSessionData } from './collect.js';
import { toTxt } from './formatters/txt.js';

/**
 * PLAN 1.2: a failed run must be explainable from its trace alone. Before this,
 * the export contained the conversation and none of the runtime's decisions, so
 * the 2026-07-25 research diagnosis rested on the model's narration of its own
 * rejection ("The evidence gate is rejecting my synthesis...").
 */
describe('runtime decisions reach the forensic export', () => {
  const record = (over: Partial<ChatRecord>): ChatRecord =>
    ({
      uuid: 'u1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: '2026-07-25T16:00:00.000Z',
      type: 'user',
      ...over,
    }) as ChatRecord;

  const conversation = {
    sessionId: 's1',
    startTime: '2026-07-25T16:00:00.000Z',
    messages: [
      record({
        uuid: 'u1',
        timestamp: '2026-07-25T16:00:00.000Z',
        type: 'user',
        content: 'research monitors',
      } as Partial<ChatRecord>),
      record({
        uuid: 'u2',
        timestamp: '2026-07-25T16:00:05.000Z',
        type: 'system',
        subtype: 'runtime_decision',
        systemPayload: {
          message: 'The evidence gate cannot see any research.',
        },
      } as Partial<ChatRecord>),
    ],
  };

  it('includes the decision, attributed to the runtime', async () => {
    const data = await collectSessionData(
      conversation as never,
      {} as never,
    );
    const system = data.messages.filter((m) => m.type === 'system');
    expect(system).toHaveLength(1);
    expect(system[0].message?.content).toBe(
      '[runtime] The evidence gate cannot see any research.',
    );
  });

  it('renders it in the txt transcript', async () => {
    const data = await collectSessionData(
      conversation as never,
      {} as never,
    );
    const text = toTxt(data);
    expect(text).toContain('[runtime] The evidence gate cannot see any research.');
  });

  it('orders decisions by timestamp rather than by discovery', async () => {
    const outOfOrder = {
      ...conversation,
      messages: [
        record({
          uuid: 'later',
          timestamp: '2026-07-25T16:00:20.000Z',
          type: 'system',
          subtype: 'runtime_decision',
          systemPayload: { message: 'second decision' },
        } as Partial<ChatRecord>),
        record({
          uuid: 'earlier',
          timestamp: '2026-07-25T16:00:10.000Z',
          type: 'system',
          subtype: 'runtime_decision',
          systemPayload: { message: 'first decision' },
        } as Partial<ChatRecord>),
      ],
    };
    const data = await collectSessionData(outOfOrder as never, {} as never);
    expect(data.messages.map((m) => m.message?.content)).toEqual([
      '[runtime] first decision',
      '[runtime] second decision',
    ]);
  });

  it('ignores other system records and malformed payloads', async () => {
    const noise = {
      ...conversation,
      messages: [
        record({
          uuid: 'a',
          type: 'system',
          subtype: 'slash_command',
          systemPayload: { message: 'not a runtime decision' },
        } as Partial<ChatRecord>),
        record({
          uuid: 'b',
          type: 'system',
          subtype: 'runtime_decision',
          systemPayload: {},
        } as Partial<ChatRecord>),
      ],
    };
    const data = await collectSessionData(noise as never, {} as never);
    expect(data.messages.filter((m) => m.type === 'system')).toEqual([]);
  });
});
