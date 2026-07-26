/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { researchCommand } from './research-command.js';

describe('researchCommand', () => {
  it('enables deep research and submits the question', async () => {
    const config = {
      applyCodeModePreset: vi.fn(),
      getGeminiClient: () => ({ refreshSystemInstruction: vi.fn() }),
    };
    const result = await researchCommand.action!(
      { services: { config } } as never,
      'current local LLM context research',
    );
    expect(config.applyCodeModePreset).toHaveBeenCalledWith(
      'deep-research',
      expect.any(Object),
    );
    expect(result).toMatchObject({ type: 'submit_prompt' });
  });
});
