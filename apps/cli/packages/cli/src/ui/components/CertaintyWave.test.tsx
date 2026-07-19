/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import {
  CertaintyWave,
  certaintyColor,
  certaintyLevel,
} from './CertaintyWave.js';
import * as useTerminalSize from '../hooks/useTerminalSize.js';
import { type UIState, UIStateContext } from '../contexts/UIStateContext.js';
import { LAL_BRAND_GREEN, LAL_BRAND_YELLOW } from '../brand-colors.js';
import { theme } from '../semantic-colors.js';
import { StreamingState } from '../types.js';

vi.mock('../hooks/useTerminalSize.js');
const useTerminalSizeMock = vi.mocked(useTerminalSize.useTerminalSize);

const createMockUIState = (overrides: Partial<UIState> = {}): UIState =>
  ({
    certaintyWave: [],
    streamingState: StreamingState.Idle,
    ...overrides,
  }) as UIState;

const renderWithWidth = (width: number, uiState: UIState) => {
  useTerminalSizeMock.mockReturnValue({ columns: width, rows: 24 });
  return render(
    <UIStateContext.Provider value={uiState}>
      <CertaintyWave />
    </UIStateContext.Provider>,
  );
};

const jspaceLine = (frame: string | undefined) =>
  frame?.split('\n').find((line) => line.includes('J-space'));

describe('certaintyColor', () => {
  it('uses the LAL brand green for high confidence', () => {
    expect(certaintyColor(0.95)).toBe(LAL_BRAND_GREEN);
    expect(certaintyColor(0.8)).toBe(LAL_BRAND_GREEN);
  });

  it('uses the LAL brand yellow for medium confidence', () => {
    expect(certaintyColor(0.7)).toBe(LAL_BRAND_YELLOW);
    expect(certaintyColor(0.55)).toBe(LAL_BRAND_YELLOW);
  });

  it('uses the semantic danger red below the yellow threshold', () => {
    expect(certaintyColor(0.2)).toBe(theme.status.error);
  });
});

describe('certaintyLevel', () => {
  it('gives the green tier (>=0.8) more than one distinct level', () => {
    // Regression: a single linear 0..1 -> 0..7 mapping crushed every value
    // >= 0.8 into level 0-1, so a realistic run of high-confidence samples
    // (which is most tokens, in healthy generation) rendered as one
    // repeated glyph — a flat line — while red/amber alone showed variety.
    const levels = new Set(
      [0.8, 0.85, 0.9, 0.95, 0.99, 1.0].map(certaintyLevel),
    );
    expect(levels.size).toBeGreaterThan(1);
  });

  it('gives the yellow tier (0.55-0.8) more than one distinct level', () => {
    const levels = new Set([0.55, 0.6, 0.65, 0.7, 0.75].map(certaintyLevel));
    expect(levels.size).toBeGreaterThan(1);
  });

  it('gives the red tier (<0.55) more than one distinct level', () => {
    const levels = new Set([0, 0.1, 0.2, 0.3, 0.4, 0.5].map(certaintyLevel));
    expect(levels.size).toBeGreaterThan(1);
  });

  it('keeps tiers ordered: more confident never produces a taller level than less confident', () => {
    expect(certaintyLevel(1.0)).toBeLessThan(certaintyLevel(0.79));
    expect(certaintyLevel(0.8)).toBeLessThan(certaintyLevel(0.54));
  });
});

describe('<CertaintyWave />', () => {
  it('is not rendered when idle with no samples', () => {
    const { lastFrame } = renderWithWidth(
      160,
      createMockUIState({ certaintyWave: [], streamingState: StreamingState.Idle }),
    );
    expect(lastFrame()).not.toContain('J-space');
  });

  it('renders dots only (no explanatory text) while streaming with no samples yet', () => {
    const { lastFrame } = renderWithWidth(
      160,
      createMockUIState({ certaintyWave: [], streamingState: StreamingState.Responding }),
    );
    const line = jspaceLine(lastFrame());
    expect(line).toBeDefined();
    expect(line).toContain('·');
    expect(line).not.toContain('n/a');
    expect(line).not.toContain('backend sent no token probabilities');
    expect(line).not.toMatch(/\d+%/);
  });

  it('shows a rounded average percentage once samples exist', () => {
    // A narrow mock width here: ink-testing-library's fake stdout hardcodes
    // 100 real columns regardless of the mock, so a wide mocked width (used
    // in the width-scaling tests above) computes a bar sized for 160 cols
    // and the trailing percentage gets truncated off the end of the
    // actually-rendered 100-col line. Keep this one comfortably under 100.
    const { lastFrame } = renderWithWidth(
      60,
      createMockUIState({ certaintyWave: [0.9, 0.9, 0.9, 0.9] }),
    );
    expect(jspaceLine(lastFrame())).toContain('90%');
  });

  it('spans the full terminal width, not a fixed-width strip', () => {
    const values = Array.from({ length: 200 }, () => 0.9);
    const { lastFrame } = renderWithWidth(
      160,
      createMockUIState({ certaintyWave: values }),
    );
    const line = jspaceLine(lastFrame());
    expect(line).toBeDefined();
    // ink-testing-library's fake stdout hardcodes 100 real columns
    // regardless of the useTerminalSize mock, so the line can't actually
    // reach our mocked 160; what matters is that it fills the available
    // render width instead of stopping at the old fixed ~47-sample cap
    // (which would have produced a much shorter line, ~59 chars with the
    // label/percentage included).
    expect(line!.length).toBeGreaterThan(90);
  });

  it('grows a narrower bar on a narrow terminal instead of overflowing', () => {
    const values = Array.from({ length: 200 }, () => 0.9);
    const wide = renderWithWidth(
      160,
      createMockUIState({ certaintyWave: values }),
    );
    const narrow = renderWithWidth(
      80,
      createMockUIState({ certaintyWave: values }),
    );
    const wideLine = jspaceLine(wide.lastFrame())!;
    const narrowLine = jspaceLine(narrow.lastFrame())!;
    expect(narrowLine.length).toBeLessThan(wideLine.length);
  });

  it('left-pads with a dim placeholder when there are fewer samples than the bar width', () => {
    const { lastFrame } = renderWithWidth(
      160,
      createMockUIState({ certaintyWave: [0.9, 0.9, 0.9] }),
    );
    expect(jspaceLine(lastFrame())).toContain('·');
  });
});
