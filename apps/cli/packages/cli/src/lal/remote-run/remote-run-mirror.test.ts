/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentEventEmitter, AgentEventType } from '@qwen-code/qwen-code-core';
import { GatewayClient } from '../attach/gateway-client.js';
import { RemoteRunMirror } from './remote-run-mirror.js';

function gateway() {
  return {
    registerClientRun: vi.fn(async () => ({
      runId: 'run-local-1',
      conversationId: 'conv-local-1',
      writerToken: 'writer-secret',
    })),
    appendClientRunEvents: vi.fn(async () => undefined),
    heartbeatClientRun: vi.fn(async () => undefined),
    settleClientRun: vi.fn(async () => undefined),
  } as unknown as GatewayClient;
}

describe('RemoteRunMirror', () => {
  it('registers the client-owned run and maps native observable events', async () => {
    const emitter = new AgentEventEmitter();
    const client = gateway();
    const mirror = new RemoteRunMirror({ emitter, client, model: 'local-model' });
    await mirror.start();

    emitter.emit(AgentEventType.STREAM_TEXT, {
      subagentId: 'a', round: 1, text: 'hello', thought: false, timestamp: 1,
    });
    emitter.emit(AgentEventType.TOOL_CALL, {
      subagentId: 'a', round: 1, callId: 'call-1', name: 'read_file', args: { path: 'x' }, description: 'read', timestamp: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.registerClientRun).toHaveBeenCalledWith({
      conversationId: undefined, projectLabel: undefined, model: 'local-model', mode: undefined,
    });
    expect(client.appendClientRunEvents).toHaveBeenNthCalledWith(
      1, 'run-local-1', 'writer-secret', expect.arrayContaining([
        expect.objectContaining({ event: { k: 'text', v: 'hello' } }),
      ]),
    );
    expect(client.appendClientRunEvents).toHaveBeenNthCalledWith(
      2, 'run-local-1', 'writer-secret', expect.arrayContaining([
        expect.objectContaining({ event: { k: 'tool_request', v: { id: 'call-1', name: 'read_file', args: { path: 'x' } } } }),
      ]),
    );
    expect(mirror.status()).toMatchObject({ state: 'active', runId: 'run-local-1' });
    await mirror.stop();
  });

  it('settles and detaches when the native agent finishes', async () => {
    const emitter = new AgentEventEmitter();
    const client = gateway();
    const mirror = new RemoteRunMirror({ emitter, client, model: 'local-model' });
    await mirror.start();
    emitter.emit(AgentEventType.FINISH, {
      subagentId: 'a', terminateReason: 'done', timestamp: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.settleClientRun).toHaveBeenCalledWith('run-local-1', 'writer-secret', 'done', undefined);
    expect(mirror.status().state).toBe('stopped');
  });
});
