/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

let queuedResponses: Array<{ stdout?: string; code?: number }>;
let spawnCalls: Array<{ command: string; args: string[] }>;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = vi.fn((command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    const child = new FakeChildProcess();
    const response = queuedResponses.shift() ?? { stdout: '', code: 0 };
    queueMicrotask(() => {
      if (response.stdout)
        child.stdout.emit('data', Buffer.from(response.stdout));
      child.emit('close', response.code ?? 0);
    });
    return child;
  });
  return { ...actual, default: { ...actual, spawn }, spawn };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

const { gitCommand } = await import('./git-command.js');

describe('gitCommand', () => {
  let context: CommandContext;

  beforeEach(() => {
    queuedResponses = [];
    spawnCalls = [];
    context = createMockCommandContext({
      services: {
        config: {
          getTargetDir: () => '/repo',
        } as unknown as Config,
      },
    });
  });

  it('errors when config is unavailable', async () => {
    const noConfig = createMockCommandContext({ services: { config: null } });
    const res = await gitCommand.action!(noConfig, 'status');
    expect(res).toMatchObject({ messageType: 'error' });
  });

  it('parses branch/ahead/behind and per-file status', async () => {
    queuedResponses = [
      {
        stdout:
          '## main...origin/main [ahead 1, behind 2]\n M src/a.ts\n?? new-file.ts\n',
        code: 0,
      },
    ];
    const res = await gitCommand.action!(context, '');
    expect(spawnCalls[0]).toMatchObject({
      command: 'git',
      args: ['status', '--porcelain=v1', '-b'],
    });
    expect(res).toMatchObject({ messageType: 'info' });
    const content = (res as { content: string }).content;
    expect(content).toContain('main');
    expect(content).toContain('ahead 1, behind 2');
    expect(content).toContain('src/a.ts');
    expect(content).toContain('new-file.ts');
  });

  it('reports a clean working tree', async () => {
    queuedResponses = [{ stdout: '## main\n', code: 0 }];
    const res = await gitCommand.action!(context, 'status');
    expect((res as { content: string }).content).toContain('clean');
  });

  it('runs a scoped diff for a single path', async () => {
    queuedResponses = [
      { stdout: '', code: 0 }, // status --porcelain check (tracked, not untracked)
      { stdout: 'diff --git a/x b/x\n+hello\n', code: 0 },
    ];
    const res = await gitCommand.action!(context, 'diff src/a.ts');
    expect(spawnCalls[1]).toMatchObject({
      args: ['diff', 'HEAD', '--', 'src/a.ts'],
    });
    expect((res as { content: string }).content).toContain('+hello');
  });

  it('diffs an untracked file with --no-index', async () => {
    queuedResponses = [
      { stdout: '?? new.ts\n', code: 0 },
      { stdout: 'diff --git a/dev/null b/new.ts\n+new\n', code: 1 },
    ];
    const res = await gitCommand.action!(context, 'diff new.ts');
    expect(spawnCalls[1]).toMatchObject({
      args: ['diff', '--no-index', '--', '/dev/null', 'new.ts'],
    });
    expect((res as { content: string }).content).toContain('+new');
  });

  it('stages all with --all', async () => {
    queuedResponses = [{ stdout: '', code: 0 }];
    const res = await gitCommand.action!(context, 'add --all');
    expect(spawnCalls[0]).toMatchObject({ args: ['add', '-A'] });
    expect(res).toMatchObject({ messageType: 'info' });
  });

  it('stages specific paths', async () => {
    queuedResponses = [{ stdout: '', code: 0 }];
    await gitCommand.action!(context, 'add src/a.ts src/b.ts');
    expect(spawnCalls[0]).toMatchObject({
      args: ['add', '--', 'src/a.ts', 'src/b.ts'],
    });
  });

  it('refuses to commit with nothing staged', async () => {
    queuedResponses = [{ stdout: '', code: 0 }]; // diff --cached --name-only -> empty
    const res = await gitCommand.action!(context, 'commit "a message"');
    expect(res).toMatchObject({ messageType: 'error' });
    expect((res as { content: string }).content).toContain('Nothing staged');
  });

  it('commits staged changes with a message', async () => {
    queuedResponses = [
      { stdout: 'src/a.ts\n', code: 0 }, // diff --cached --name-only
      { stdout: '[main abc1234] fix things\n', code: 0 }, // commit
    ];
    const res = await gitCommand.action!(context, 'commit fix things');
    expect(spawnCalls[1]).toMatchObject({
      args: ['commit', '-m', 'fix things'],
    });
    expect(res).toMatchObject({ messageType: 'info' });
  });

  it('rejects an unknown subcommand', async () => {
    const res = await gitCommand.action!(context, 'push');
    expect(res).toMatchObject({ messageType: 'error' });
  });
});
