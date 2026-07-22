/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import {
  CODE_MODE_NAMES,
  CODE_MODE_PRESETS,
  type CodeModeName,
} from '@qwen-code/qwen-code-core';

const NAME_LIST = CODE_MODE_NAMES.join(', ');

function describePreset(name: CodeModeName): string {
  const p = CODE_MODE_PRESETS[name];
  return `${name} — rounds:${p.maxRounds} tokens:${p.maxTokens} ctx:${p.ctx ?? 'verified-runtime'} think:${p.think ? 'on' : 'off'} temp:${p.temperature}`;
}

export const modeCommand: SlashCommand = {
  name: 'mode',
  get description() {
    return t(
      'Set the code-mode workflow preset ({{names}}); sets rounds/tokens/ctx/temp/thinking budgets, /effort still adjusts reasoning on top.',
      { names: NAME_LIST },
    );
  },
  argumentHint: '[default|quick-edit|planning|deep-research|orchestrator]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (
    context: CommandContext,
    actionArgs: string,
  ): Promise<MessageActionReturn> => {
    const { config } = context.services;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Configuration not available.'),
      };
    }

    const args = (
      context.invocation?.args?.trim() || actionArgs.trim()
    ).toLowerCase();

    if (!args) {
      const current = config.getActiveCodeMode() ?? 'default';
      const lines = CODE_MODE_NAMES.map((name) =>
        name === current
          ? `* ${describePreset(name)}`
          : `  ${describePreset(name)}`,
      );
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Current mode: {{current}}\n{{lines}}\nUse "/mode <name>" to switch. "/effort <tier>" still adjusts reasoning strength on top of the active mode.',
          { current, lines: lines.join('\n') },
        ),
      };
    }

    if (!(CODE_MODE_NAMES as readonly string[]).includes(args)) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Unknown mode "{{value}}". Choose one of: {{names}}.', {
          value: args,
          names: NAME_LIST,
        }),
      };
    }

    const name = args as CodeModeName;
    const preset = CODE_MODE_PRESETS[name];
    config.applyCodeModePreset(name, preset);

    // Rebind the live chat's system instruction so the addendum takes effect
    // on the next turn instead of only on a fresh session. Best-effort: a
    // fresh session (no chat started yet) has nothing to rebind.
    try {
      await config.getGeminiClient()?.refreshSystemInstruction();
    } catch {
      // Non-fatal: the addendum still applies to the next new chat.
    }

    return {
      type: 'message',
      messageType: 'info',
      content: t(
        'Mode set to {{name}} ({{desc}}). "/effort" still adjusts reasoning strength on top of this mode.',
        { name, desc: describePreset(name) },
      ),
    };
  },
};
