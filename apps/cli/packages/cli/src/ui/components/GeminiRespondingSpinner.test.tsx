/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { GeminiSpinner } from './GeminiRespondingSpinner.js';
import { setTerminalRenderer } from '../utils/terminal-renderer.js';

describe('<GeminiSpinner />', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setTerminalRenderer('static');
  });

  it('uses a low-frequency fixed-width indicator inside tmux', () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,12345,0');
    // The renderer defaults to 'static', and the !animationsEnabled branch
    // short-circuits to '…' before the tmux branch is ever reached. This test
    // is about the tmux indicator, so animations have to be on.
    setTerminalRenderer('viewport');

    const { lastFrame } = render(<GeminiSpinner />);

    expect(lastFrame()).toContain('.');
  });

  // Regression: Footer.tsx renders <GeminiSpinner /> inside a <Text> wrapper
  // ('<Text>...<GeminiSpinner /> {msg}</Text>'). Ink forbids <Box> from being
  // nested inside <Text>, so the tmux branch must return a <Text>, not a
  // <Box>-wrapped one — otherwise the CLI throws on startup inside tmux.
  it('renders without throwing when nested inside a <Text> (Footer context)', () => {
    vi.stubEnv('TMUX', '/tmp/tmux-1000/default,12345,0');

    expect(() =>
      render(
        <Text>
          <GeminiSpinner /> startup message
        </Text>,
      ),
    ).not.toThrow();
  });
});
