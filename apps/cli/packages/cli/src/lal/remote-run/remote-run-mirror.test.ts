/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentEventEmitter, AgentEventType } from '@qwen-code/qwen-code-core';
import { GatewayClient } from '../attach/gateway-client.js';
import { RemoteRunMirror } from './remote-run-mirror.js';

function gateway(heartbeatResponse?: { cancelRequested?: boolean }) {
  return {
    registerClientRun: vi.fn(async () => ({
      runId: 'run-local-1',
      conversationId: 'conv-local-1',
      writerToken: 'writer-secret',
    })),
    appendClientRunEvents: vi.fn(async () => undefined),
    heartbeatClientRun: vi.fn(async () => heartbeatResponse),
    settleClientRun: vi.fn(async () => undefined),
  } as unknown as GatewayClient;
}

describe('RemoteRunMirror', () => {
  it('registers the client-owned run and maps native observable events', async () => {
    const emitter = new AgentEventEmitter();
    const client = gateway();
    const mirror = new RemoteRunMirror({
      emitter,
      client,
      model: 'local-model',
    });
    await mirror.start();

    emitter.emit(AgentEventType.STREAM_TEXT, {
      subagentId: 'a',
      round: 1,
      text: 'hello',
      thought: false,
      timestamp: 1,
    });
    emitter.emit(AgentEventType.TOOL_CALL, {
      subagentId: 'a',
      round: 1,
      callId: 'call-1',
      name: 'read_file',
      args: { path: 'x' },
      description: 'read',
      timestamp: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.registerClientRun).toHaveBeenCalledWith({
      conversationId: undefined,
      projectLabel: undefined,
      model: 'local-model',
      mode: undefined,
    });
    expect(client.appendClientRunEvents).toHaveBeenNthCalledWith(
      1,
      'run-local-1',
      'writer-secret',
      expect.arrayContaining([
        expect.objectContaining({ event: { k: 'text', v: 'hello' } }),
      ]),
    );
    expect(client.appendClientRunEvents).toHaveBeenNthCalledWith(
      2,
      'run-local-1',
      'writer-secret',
      expect.arrayContaining([
        expect.objectContaining({
          event: {
            k: 'tool_request',
            v: { id: 'call-1', name: 'read_file', args: { path: 'x' } },
          },
        }),
      ]),
    );
    expect(mirror.status()).toMatchObject({
      state: 'active',
      runId: 'run-local-1',
    });
    await mirror.stop();
  });

  it('keeps the shared run active when one model reply finishes', async () => {
    const emitter = new AgentEventEmitter();
    const client = gateway();
    const mirror = new RemoteRunMirror({
      emitter,
      client,
      model: 'local-model',
    });
    await mirror.start();
    emitter.emit(AgentEventType.FINISH, {
      subagentId: 'a',
      terminateReason: 'done',
      timestamp: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.settleClientRun).not.toHaveBeenCalled();
    expect(mirror.status().state).toBe('active');
    await mirror.stop();
  });

  it('reports progress as changed files and mechanical check outcomes', async () => {
    const emitter = new AgentEventEmitter();
    const client = gateway();
    const mirror = new RemoteRunMirror({
      emitter,
      client,
      model: 'local-model',
    });
    await mirror.start();

    emitter.emit(AgentEventType.TOOL_CALL, {
      subagentId: 'a',
      round: 1,
      callId: 'edit-1',
      name: 'edit',
      args: { file_path: '/project/game.js' },
      description: 'edit',
      timestamp: 1,
    });
    emitter.emit(AgentEventType.TOOL_RESULT, {
      subagentId: 'a',
      round: 1,
      callId: 'edit-1',
      name: 'edit',
      success: true,
      timestamp: 2,
    });
    emitter.emit(AgentEventType.TOOL_CALL, {
      subagentId: 'a',
      round: 2,
      callId: 'test-1',
      name: 'run_shell_command',
      args: { command: 'npm test' },
      description: 'test',
      timestamp: 3,
    });
    emitter.emit(AgentEventType.TOOL_RESULT, {
      subagentId: 'a',
      round: 2,
      callId: 'test-1',
      name: 'run_shell_command',
      success: true,
      timestamp: 4,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sent = (
      client.appendClientRunEvents as ReturnType<typeof vi.fn>
    ).mock.calls
      .flatMap((call) => call[2] as Array<{ event: { k: string; v: unknown } }>)
      .map((entry) => entry.event);
    expect(sent).toContainEqual({
      k: 'artifact',
      v: { path: '/project/game.js', kind: 'file_change' },
    });
    expect(sent).toContainEqual({
      k: 'phase',
      v: { name: 'check passed: npm test' },
    });
    await mirror.stop();
  });

  it('mirrors native approval and round-boundary events with their real tool details', async () => {
    const emitter = new AgentEventEmitter();
    const client = gateway();
    const mirror = new RemoteRunMirror({
      emitter,
      client,
      model: 'local-model',
    });
    await mirror.start();

    emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
      subagentId: 'a',
      round: 1,
      callId: 'approval-1',
      name: 'run_shell_command',
      description: 'run tests',
      args: { command: 'npm test' },
      confirmationDetails: {
        type: 'exec',
        title: 'Run tests',
      } as never,
      respond: async () => undefined,
      timestamp: 1,
    });
    emitter.emit(AgentEventType.ROUND_END, {
      subagentId: 'a',
      round: 1,
      promptId: 'prompt-1',
      timestamp: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sent = (
      client.appendClientRunEvents as ReturnType<typeof vi.fn>
    ).mock.calls
      .flatMap((call) => call[2] as Array<{ event: { k: string; v: unknown } }>)
      .map((entry) => entry.event);
    expect(sent).toContainEqual({
      k: 'approval_needed',
      v: {
        id: 'approval-1',
        name: 'run_shell_command',
        args: { command: 'npm test' },
      },
    });
    expect(sent).toContainEqual({ k: 'round' });
    await mirror.stop();
  });

  it('keeps a tool progress event associated with its native tool name', async () => {
    const emitter = new AgentEventEmitter();
    const client = gateway();
    const mirror = new RemoteRunMirror({
      emitter,
      client,
      model: 'local-model',
    });
    await mirror.start();
    emitter.emit(AgentEventType.TOOL_CALL, {
      subagentId: 'a',
      round: 1,
      callId: 'call-1',
      name: 'run_shell_command',
      args: { command: 'npm test' },
      description: 'test',
      timestamp: 1,
    });
    emitter.emit(AgentEventType.TOOL_OUTPUT_UPDATE, {
      subagentId: 'a',
      round: 1,
      callId: 'call-1',
      outputChunk: 'running tests',
      timestamp: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sent = (
      client.appendClientRunEvents as ReturnType<typeof vi.fn>
    ).mock.calls
      .flatMap((call) => call[2] as Array<{ event: { k: string; v: unknown } }>)
      .map((entry) => entry.event);
    expect(sent).toContainEqual({
      k: 'tool_progress',
      v: {
        id: 'call-1',
        name: 'run_shell_command',
        chars: 13,
        preview: 'running tests',
      },
    });
    await mirror.stop();
  });

  it('cancels and settles the owning native session from a heartbeat', async () => {
    const emitter = new AgentEventEmitter();
    const client = gateway({ cancelRequested: true });
    const onCancel = vi.fn();
    const mirror = new RemoteRunMirror({
      emitter,
      client,
      model: 'local-model',
      onCancel,
    });
    await mirror.start();
    await (
      mirror as unknown as { sendHeartbeat(): Promise<void> }
    ).sendHeartbeat();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(client.settleClientRun).toHaveBeenCalledWith(
      'run-local-1',
      'writer-secret',
      'stopped',
      undefined,
    );
    expect(mirror.status().state).toBe('stopped');
  });

  it('does not duplicate cumulative stream buffers in the remote transcript', async () => {
    const emitter = new AgentEventEmitter();
    const client = gateway();
    const mirror = new RemoteRunMirror({
      emitter,
      client,
      model: 'local-model',
    });
    await mirror.start();
    emitter.emit(AgentEventType.STREAM_TEXT, {
      subagentId: 'a',
      round: 1,
      text: "Let's",
      thought: false,
      timestamp: 1,
    });
    emitter.emit(AgentEventType.STREAM_TEXT, {
      subagentId: 'a',
      round: 1,
      text: "Let's begin",
      thought: false,
      timestamp: 2,
    });
    emitter.emit(AgentEventType.ROUND_TEXT, {
      subagentId: 'a',
      round: 1,
      text: "Let's begin",
      thoughtText: '',
      timestamp: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sent = (
      client.appendClientRunEvents as ReturnType<typeof vi.fn>
    ).mock.calls
      .flatMap((call) => call[2] as Array<{ event: { k: string; v: string } }>)
      .filter((entry) => entry.event.k === 'text')
      .map((entry) => entry.event.v)
      .join('');
    expect(sent).toBe("Let's begin");
    await mirror.stop();
  });
});
