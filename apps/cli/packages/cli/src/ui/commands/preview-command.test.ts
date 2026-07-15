/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Config } from '@qwen-code/qwen-code-core';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

vi.mock('../../i18n/index.js', () => ({
  t: (key: string, params?: Record<string, string>) => {
    if (params) {
      return Object.entries(params).reduce(
        (str, [k, v]) => str.replace(`{{${k}}}`, v),
        key,
      );
    }
    return key;
  },
}));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn();
}

// Queue of scripted responses for the next `tailscale <args>` spawn call.
let tailscaleResponses: Array<{ stdout: string; code: number }>;
let tailscaleCalls: string[][];
let bashCommands: string[];
let portComesUp = true;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = vi.fn((command: string, args: string[]) => {
    if (command === 'bash') {
      bashCommands.push(args[1] ?? '');
      return new FakeChild();
    }
    // tailscale
    tailscaleCalls.push(args);
    const child = new FakeChild();
    const response = tailscaleResponses.shift() ?? { stdout: '', code: 0 };
    queueMicrotask(() => {
      if (response.stdout)
        child.stdout.emit('data', Buffer.from(response.stdout));
      child.emit('close', response.code);
    });
    return child;
  });
  return { ...actual, default: { ...actual, spawn }, spawn };
});

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  const connect = vi.fn(() => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      setTimeout: (ms: number, cb: () => void) => void;
    };
    socket.destroy = vi.fn();
    socket.setTimeout = vi.fn();
    queueMicrotask(() => {
      socket.emit(portComesUp ? 'connect' : 'error', new Error('ECONNREFUSED'));
    });
    return socket;
  });
  return { ...actual, default: { ...actual, connect }, connect };
});

const originalKill = process.kill.bind(process);

const { previewCommand } = await import('./preview-command.js');

describe('previewCommand', () => {
  let context: CommandContext;

  beforeEach(() => {
    tailscaleResponses = [];
    tailscaleCalls = [];
    bashCommands = [];
    portComesUp = true;
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    context = createMockCommandContext({
      services: {
        config: { getTargetDir: () => '/project' } as unknown as Config,
      },
    });
  });

  afterEach(() => {
    (process.kill as unknown as ReturnType<typeof vi.fn>).mockRestore?.();
    process.kill = originalKill;
  });

  it('errors when config is unavailable', async () => {
    const noConfig = createMockCommandContext({ services: { config: null } });
    const res = await previewCommand.action!(noConfig, 'status');
    expect(res).toMatchObject({ messageType: 'error' });
  });

  it('reports no preview running by default', async () => {
    const res = await previewCommand.action!(context, '');
    expect(res).toMatchObject({ messageType: 'info' });
    expect((res as { content: string }).content).toContain(
      'No preview is running',
    );
  });

  it('rejects a start with no port', async () => {
    const res = await previewCommand.action!(context, 'npm run dev');
    expect(res).toMatchObject({ messageType: 'error' });
    expect((res as { content: string }).content).toContain('Usage:');
  });

  it('rejects an out-of-range port', async () => {
    const res = await previewCommand.action!(context, 'npm run dev 80');
    expect(res).toMatchObject({ messageType: 'error' });
  });

  it('starts a preview, exposes it via tailscale, then stops it', async () => {
    tailscaleResponses = [
      { stdout: '', code: 0 }, // serve --bg
      {
        stdout: JSON.stringify({
          Self: { DNSName: 'main-pc.tail3ba909.ts.net.' },
        }),
        code: 0,
      }, // status --json
    ];

    const startRes = await previewCommand.action!(context, 'npm run dev 3000');
    expect(bashCommands).toEqual(['npm run dev']);
    expect(tailscaleCalls[0]).toEqual([
      'serve',
      '--bg',
      '--https=3000',
      'http://127.0.0.1:3000',
    ]);
    expect(tailscaleCalls[1]).toEqual(['status', '--json']);
    const startContent = (startRes as { content: string }).content;
    expect(startContent).toContain('http://127.0.0.1:3000');
    expect(startContent).toContain('https://main-pc.tail3ba909.ts.net:3000');

    const secondStart = await previewCommand.action!(
      context,
      'npm run dev 3001',
    );
    expect(secondStart).toMatchObject({ messageType: 'error' });
    expect((secondStart as { content: string }).content).toContain(
      'already running',
    );

    const statusRes = await previewCommand.action!(context, 'status');
    expect((statusRes as { content: string }).content).toContain('port 3000');

    tailscaleResponses = [{ stdout: '', code: 0 }]; // serve ... off
    const stopRes = await previewCommand.action!(context, 'stop');
    expect(process.kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(tailscaleCalls[2]).toEqual(['serve', '--https=3000', 'off']);
    expect((stopRes as { content: string }).content).toContain(
      'Stopped preview',
    );

    const statusAfterStop = await previewCommand.action!(context, 'status');
    expect((statusAfterStop as { content: string }).content).toContain(
      'No preview is running',
    );
  });
});
