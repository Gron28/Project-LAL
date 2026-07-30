import { describe, expect, it } from 'vitest';
import {
  CODE_MODE_PRESETS,
  DEFAULT_CODE_MODE_MAX_TOKENS,
} from './code-mode-presets.js';

describe('code mode output budgets', () => {
  it('uses one 40K generation default in every mode', () => {
    expect(DEFAULT_CODE_MODE_MAX_TOKENS).toBe(40_960);
    expect(
      new Set(
        Object.values(CODE_MODE_PRESETS).map((preset) => preset.maxTokens),
      ),
    ).toEqual(new Set([DEFAULT_CODE_MODE_MAX_TOKENS]));
  });
});
