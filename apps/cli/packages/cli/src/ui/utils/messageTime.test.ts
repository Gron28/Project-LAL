/**
 * @license
 * Copyright 2025 LAL
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  messageTimeFromId,
  messageTimeWithSecondsFromId,
} from './messageTime.js';

describe('messageTimeFromId', () => {
  const at = (y: number, m: number, d: number, h: number, min: number, s = 0) =>
    new Date(y, m, d, h, min, s).getTime();

  it('renders local HH:MM from a timestamp id', () => {
    expect(messageTimeFromId(at(2026, 6, 25, 9, 5))).toBe('09:05');
  });

  it('zero-pads both fields', () => {
    expect(messageTimeFromId(at(2026, 6, 25, 0, 0))).toBe('00:00');
  });

  it('includes seconds on request, for judging turn length', () => {
    expect(messageTimeWithSecondsFromId(at(2026, 6, 25, 13, 4, 7))).toBe(
      '13:04:07',
    );
  });

  it('refuses a small sequential id rather than inventing a time', () => {
    // Older/synthetic items used small ids. Rendering "01:00" for id=42 would be
    // a fabricated fact dressed as data.
    expect(messageTimeFromId(42)).toBeUndefined();
    expect(messageTimeFromId(0)).toBeUndefined();
  });

  it('refuses an id far in the future', () => {
    const now = () => at(2026, 6, 25, 12, 0);
    expect(messageTimeFromId(at(2027, 0, 1, 12, 0), now)).toBeUndefined();
  });

  it('accepts an id slightly ahead of now (counter skew)', () => {
    const base = at(2026, 6, 25, 12, 0);
    expect(messageTimeFromId(base + 5, () => base)).toBe('12:00');
  });

  it('refuses undefined and non-finite ids', () => {
    expect(messageTimeFromId(undefined)).toBeUndefined();
    expect(messageTimeFromId(Number.NaN)).toBeUndefined();
  });
});
