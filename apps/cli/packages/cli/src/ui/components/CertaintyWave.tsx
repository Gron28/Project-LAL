/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { useUIState } from '../contexts/UIStateContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { theme } from '../semantic-colors.js';
import { LAL_BRAND_GREEN, LAL_BRAND_YELLOW } from '../brand-colors.js';

// Eight-level bar so the wave reads as a smooth line at full terminal width
// instead of a coarse three-height strip. Height tracks confidence directly
// (higher % → taller bar) — the ordinary bar-chart reading. An earlier
// version inverted this (confident = short, hesitant = spikes, meant to
// read as "where did it spike"), but that read as backwards/broken in
// practice (reported 2026-07-19) — a taller bar for a higher percentage is
// the less surprising convention and what people expect on first look.
const CERTAINTY_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/**
 * A single linear 0..1 → 0..7 mapping crushed the entire green tier
 * (p >= 0.8, where most tokens land during healthy generation) into level
 * 6-7 — reading as a flat line — while the rarer amber/red tokens spread
 * across the rest of the range. Each tier gets its own local sub-range
 * instead, so all three stay visually alive regardless of how confidence
 * actually clusters.
 */
export function certaintyLevel(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  if (v >= 0.8) {
    const t = (v - 0.8) / 0.2; // 0 at v=0.8 .. 1 at v=1 (most confident)
    return 5 + Math.min(2, Math.floor(t * 3)); // levels 5..7
  }
  if (v >= 0.55) {
    const t = (v - 0.55) / 0.25; // 0 at v=0.55 .. 1 at v=0.8
    return 3 + Math.min(1, Math.floor(t * 2)); // levels 3..4
  }
  const t = v / 0.55; // 0 at v=0 .. 1 at v=0.55
  return Math.min(2, Math.floor(t * 3)); // levels 0..2
}

export function certaintyGlyph(value: number): string {
  return CERTAINTY_GLYPHS[certaintyLevel(value)];
}

export function certaintyColor(value: number): string {
  if (value >= 0.8) return LAL_BRAND_GREEN;
  if (value >= 0.55) return LAL_BRAND_YELLOW;
  return theme.status.error;
}

/**
 * Live token-certainty wave ("J-space"). Renders above the input box rather
 * than as another row in the already-tall Footer stack. Spans the full
 * terminal width — the bar length is computed from the real terminal width
 * each render, not a fixed sample count — and sweeps in from the right with
 * a dim placeholder until enough samples exist to fill the row.
 */
export const CertaintyWave: React.FC = () => {
  const uiState = useUIState();
  const { columns: terminalWidth } = useTerminalSize();
  const certainty = uiState.certaintyWave;
  const showCertaintyWave =
    certainty.length > 0 || uiState.streamingState !== 'idle';

  if (!showCertaintyWave) return null;

  const certaintyAverage = certainty.length
    ? certainty.reduce((sum, value) => sum + value, 0) / certainty.length
    : null;
  const certaintyPrefix = 'J-space ';
  // No explanatory text while there's no signal yet — the dim dot
  // placeholder alone already says "nothing to show".
  const certaintySuffix =
    certaintyAverage == null ? '' : ` ${Math.round(certaintyAverage * 100)}%`;
  // Bar spans the full row: terminal width minus this Box's paddingX={2} (2
  // columns each side) and the label/percentage text either side of it.
  const certaintyBarWidth = Math.max(
    1,
    terminalWidth - 4 - certaintyPrefix.length - certaintySuffix.length,
  );
  const certaintyValues = certainty.slice(-certaintyBarWidth);
  const certaintyPadCount = certaintyBarWidth - certaintyValues.length;

  return (
    <Box width="100%" paddingX={2}>
      <Text wrap="truncate">
        <Text color={theme.text.secondary}>{certaintyPrefix}</Text>
        {certaintyPadCount > 0 && (
          <Text color={theme.text.secondary} dimColor>
            {'·'.repeat(certaintyPadCount)}
          </Text>
        )}
        {certaintyValues.map((value, index) => (
          <Text key={index} color={certaintyColor(value)}>
            {certaintyGlyph(value)}
          </Text>
        ))}
        {certaintySuffix && (
          <Text color={theme.text.secondary}>{certaintySuffix}</Text>
        )}
      </Text>
    </Box>
  );
};
