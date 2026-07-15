/** Change the per-response generation ceiling for the current session. */
import type { CommandContext, MessageActionReturn, SlashCommand } from './types.js';
import { CommandKind } from './types.js';

const MIN_TOKENS = 512;
const MAX_TOKENS = 64_000;

export const tokensCommand: SlashCommand = {
  name: 'tokens',
  description: 'Set or inspect the per-response output token ceiling.',
  argumentHint: '[number]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context: CommandContext, actionArgs: string): Promise<MessageActionReturn> => {
    const config = context.services.config;
    if (!config) return { type: 'message', messageType: 'error', content: 'Configuration not available.' };
    const raw = actionArgs.trim();
    const current = config.getContentGeneratorConfig()?.samplingParams?.max_tokens;
    if (!raw) {
      return { type: 'message', messageType: 'info', content: `Output token ceiling: ${current ?? '(mode default)'}\nUse /tokens <number> (512–${MAX_TOKENS}). Example: /tokens 16000` };
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < MIN_TOKENS || value > MAX_TOKENS) {
      return { type: 'message', messageType: 'error', content: `Invalid token ceiling. Use an integer from ${MIN_TOKENS} to ${MAX_TOKENS}.` };
    }
    config.setSamplingOverride({ max_tokens: value });
    return { type: 'message', messageType: 'info', content: `Output token ceiling set to ${value.toLocaleString()} for future responses. It overrides the current /mode budget until changed.` };
  },
};
