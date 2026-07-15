/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { GatewayClient, GatewayRunMeta } from './gateway-client.js';
import { findLatestRunForConversation, findLiveRun } from './reattach.js';

function run(over: Partial<GatewayRunMeta>): GatewayRunMeta {
  return {
    id: 'run-1',
    kind: 'chat',
    conversationId: 'convo-1',
    model: 'm',
    status: 'running',
    startedAt: 0,
    updatedAt: 0,
    seq: 0,
    ...over,
  };
}

function clientReturning(runs: GatewayRunMeta[]): GatewayClient {
  return { listRuns: async () => runs } as unknown as GatewayClient;
}

describe('findLiveRun', () => {
  it('returns null when nothing is running', async () => {
    const client = clientReturning([run({ id: 'a', status: 'done' })]);
    expect(await findLiveRun(client)).toBeNull();
  });

  it('picks the most recently updated live run across kinds', async () => {
    const client = clientReturning([
      run({ id: 'old', status: 'running', updatedAt: 1 }),
      run({ id: 'done', status: 'done', updatedAt: 100 }),
      run({ id: 'new', status: 'running', updatedAt: 50 }),
    ]);
    const found = await findLiveRun(client);
    expect(found?.id).toBe('new');
  });

  it('filters by conversationId when given — this is the cross-device auto-attach path', async () => {
    const client = clientReturning([
      run({
        id: 'other-convo',
        status: 'running',
        conversationId: 'convo-x',
        updatedAt: 100,
      }),
      run({
        id: 'mine',
        status: 'running',
        conversationId: 'convo-1',
        updatedAt: 1,
      }),
    ]);
    const found = await findLiveRun(client, { conversationId: 'convo-1' });
    expect(found?.id).toBe('mine');
  });

  it('filters by kind when given', async () => {
    const client = clientReturning([
      run({ id: 'chat-run', kind: 'chat', status: 'running', updatedAt: 100 }),
      run({ id: 'hive-run', kind: 'hive', status: 'running', updatedAt: 50 }),
    ]);
    expect((await findLiveRun(client, { kind: 'hive' }))?.id).toBe('hive-run');
  });
});

describe('findLatestRunForConversation', () => {
  it('returns the most recent run for a conversation regardless of status', async () => {
    const client = clientReturning([
      run({ id: 'a', conversationId: 'c1', status: 'done', updatedAt: 10 }),
      run({ id: 'b', conversationId: 'c1', status: 'error', updatedAt: 20 }),
      run({ id: 'c', conversationId: 'c2', status: 'running', updatedAt: 999 }),
    ]);
    const found = await findLatestRunForConversation(client, 'c1');
    expect(found?.id).toBe('b');
  });

  it('returns null when the conversation has no runs', async () => {
    const client = clientReturning([run({ id: 'a', conversationId: 'other' })]);
    expect(await findLatestRunForConversation(client, 'nope')).toBeNull();
  });
});
