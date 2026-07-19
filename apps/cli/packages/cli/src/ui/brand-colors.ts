/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// LAL's fixed product palette, independent of the selected editor/syntax
// theme (see Header.tsx's monogram/version accent — the original consumer).
// Shared here so any component that needs the brand hues imports one source
// instead of redeclaring the hex values.
export const LAL_BRAND_CYAN = '#22D3C5';
export const LAL_BRAND_GREEN = '#55E06F';
export const LAL_BRAND_YELLOW = '#E6D85C';
export const LAL_BRAND_GRADIENT = [
  LAL_BRAND_CYAN,
  LAL_BRAND_GREEN,
  LAL_BRAND_YELLOW,
];
