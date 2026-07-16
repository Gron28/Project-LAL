/** Change the per-response generation ceiling for the current session. */
import type { CommandContext, MessageActionReturn, SlashCommand } from './types.js';
import { CommandKind } from './types.js';

const MIN_TOKENS = 512;
// Sanity bound only — the real per-turn limit is the context-window clamp
// (clampOutputTokensToWindow), which sizes every request to the room actually
// left in the window. A user asking for more than the window can hold gets
// the window's room, not an error.
const MAX_TOKENS = 1_000_000;

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
    const window = config.getContentGeneratorConfig()?.contextWindowSize;
    if (!raw) {
      return { type: 'message', messageType: 'info', content: `Output token ceiling: ${current ?? '(mode default)'}${window ? `\nContext window: ${window.toLocaleString()} tokens — each response is additionally clamped to the room left in the window.` : ''}\nUse /tokens <number> (min ${MIN_TOKENS}). Example: /tokens 16000` };
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < MIN_TOKENS || value > MAX_TOKENS) {
      return { type: 'message', messageType: 'error', content: `Invalid token ceiling. Use an integer from ${MIN_TOKENS} to ${MAX_TOKENS.toLocaleString()}.` };
    }
    config.setSamplingOverride({ max_tokens: value }, { pin: true });
    const windowNote = window && value > window
      ? ` Note: the ${window.toLocaleString()}-token context window means each response is clamped to the room actually left in the window.`
      : ' It persists across /mode changes until you change it.';
    return { type: 'message', messageType: 'info', content: `Output token ceiling set to ${value.toLocaleString()} for future responses.${windowNote}` };
  },
};
