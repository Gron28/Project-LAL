/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { type CommandContext } from './types.js';
import { modeCommand } from './mode-command.js';
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

describe('modeCommand', () => {
  let applyCodeModePreset: ReturnType<typeof vi.fn>;
  let getActiveCodeMode: ReturnType<typeof vi.fn>;
  let refreshSystemInstruction: ReturnType<typeof vi.fn>;
  let getGeminiClient: ReturnType<typeof vi.fn>;
  let context: CommandContext;

  beforeEach(() => {
    let currentMode: string | undefined;
    applyCodeModePreset = vi.fn((name: string) => {
      currentMode = name;
    });
    getActiveCodeMode = vi.fn(() => currentMode);
    refreshSystemInstruction = vi.fn().mockResolvedValue(undefined);
    getGeminiClient = vi.fn(() => ({ refreshSystemInstruction }));
    context = createMockCommandContext({
      services: {
        config: {
          applyCodeModePreset,
          getActiveCodeMode,
          getGeminiClient,
        } as unknown as Config,
      },
    });
  });

  it('reports the current mode (default) with no args', async () => {
    const res = await modeCommand.action!(context, '');
    expect(res).toMatchObject({ type: 'message', messageType: 'info' });
    expect((res as { content: string }).content).toContain('default');
    expect(applyCodeModePreset).not.toHaveBeenCalled();
  });

  it('sets a valid preset and refreshes the system instruction', async () => {
    const res = await modeCommand.action!(context, 'quick-edit');
    expect(applyCodeModePreset).toHaveBeenCalledWith(
      'quick-edit',
      expect.objectContaining({ think: false, maxRounds: 8 }),
    );
    expect(refreshSystemInstruction).toHaveBeenCalled();
    expect(res).toMatchObject({ messageType: 'info' });
    expect((res as { content: string }).content).toContain('quick-edit');
  });

  it('accepts mixed case and reports the active mode afterward', async () => {
    await modeCommand.action!(context, 'Deep-Research');
    expect(applyCodeModePreset).toHaveBeenCalledWith(
      'deep-research',
      expect.objectContaining({ maxRounds: 64 }),
    );
    const res = await modeCommand.action!(context, '');
    expect((res as { content: string }).content).toContain('deep-research');
  });

  it('rejects an unknown mode without mutating config', async () => {
    const res = await modeCommand.action!(context, 'turbo');
    expect(applyCodeModePreset).not.toHaveBeenCalled();
    expect(res).toMatchObject({ messageType: 'error' });
  });

  it('errors cleanly when config is unavailable', async () => {
    const noConfigContext = createMockCommandContext({
      services: { config: null },
    });
    const res = await modeCommand.action!(noConfigContext, 'planning');
    expect(res).toMatchObject({ messageType: 'error' });
  });

  it('does not fail the command if refreshSystemInstruction throws', async () => {
    refreshSystemInstruction.mockRejectedValueOnce(new Error('no chat yet'));
    const res = await modeCommand.action!(context, 'planning');
    expect(res).toMatchObject({ messageType: 'info' });
  });
});
