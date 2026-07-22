import { describe, expect, it } from 'vitest';
import {
  resolveTerminalRenderer,
  terminalAnimationsEnabled,
} from './terminal-renderer.js';

describe('resolveTerminalRenderer', () => {
  it('keeps animations off until interactive startup selects a renderer', () => {
    expect(terminalAnimationsEnabled()).toBe(false);
  });
  it('uses a viewport for a capable interactive terminal', () => {
    expect(
      resolveTerminalRenderer({
        isTTY: true,
        environment: { TERM: 'xterm-256color' },
      }),
    ).toBe('viewport');
  });
  it('falls back to static for dumb, redirected, CI, and safe-terminal output', () => {
    expect(
      resolveTerminalRenderer({ isTTY: true, environment: { TERM: 'dumb' } }),
    ).toBe('static');
    expect(
      resolveTerminalRenderer({ isTTY: false, environment: { TERM: 'xterm' } }),
    ).toBe('static');
    expect(
      resolveTerminalRenderer({
        isTTY: true,
        environment: { TERM: 'xterm', CI: 'true' },
      }),
    ).toBe('static');
    expect(
      resolveTerminalRenderer({
        isTTY: true,
        safeTerminal: true,
        environment: { TERM: 'xterm' },
      }),
    ).toBe('static');
  });
  it('honors explicit configuration and environment overrides', () => {
    expect(
      resolveTerminalRenderer({
        configured: 'static',
        isTTY: true,
        environment: { TERM: 'xterm' },
      }),
    ).toBe('static');
    expect(
      resolveTerminalRenderer({
        configured: 'static',
        isTTY: true,
        environment: { TERM: 'xterm', LAL_TERMINAL_RENDERER: 'viewport' },
      }),
    ).toBe('viewport');
  });
});
