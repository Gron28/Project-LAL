/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { CODE_MODE_PRESETS } from '@qwen-code/qwen-code-core';
import {
  CommandKind,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';

/** Discoverable one-command entry to the evidence-gated research controller.
 * Natural-language research requests are detected too; this command also
 * leaves the session in deep-research mode for follow-up questions. */
export const researchCommand: SlashCommand = {
  name: 'research',
  description:
    'Run observable, evidence-backed deep research with web search and full-source coverage gates.',
  argumentHint: '<question>',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const config = context.services.config;
    if (!config)
      return {
        type: 'message',
        messageType: 'error',
        content: 'Configuration not available.',
      };
    config.applyCodeModePreset(
      'deep-research',
      CODE_MODE_PRESETS['deep-research'],
    );
    try {
      await config.getGeminiClient()?.refreshSystemInstruction();
    } catch {
      /* next fresh chat still receives it */
    }
    const question = context.invocation?.args?.trim() || args.trim();
    if (!question)
      return {
        type: 'message',
        messageType: 'info',
        content:
          'Deep-research mode enabled. Use /research <question>, or type your research question normally.',
      };
    return {
      type: 'submit_prompt',
      content: [
        {
          text: `Deep research this question with observable searches, opened sources, and an evidence-linked synthesis:\n\n${question}`,
        },
      ],
    };
  },
};
