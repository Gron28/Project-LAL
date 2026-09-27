/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// LAL's fixed product palette, independent of the selected editor/syntax
// theme (see Header.tsx's monogram/version accent — the original consumer).
// Shared here so any component that needs the brand hues imports one source
// instead of redeclaring the hex values. Values come from design/tokens.json
// via the generated lal-palette.ts; the export names predate the v1 palette
// and are kept so call sites stay stable (CYAN = tertiary, GREEN = sage,
// YELLOW = solar).
import { LAL_BRAND, LAL_PALETTE_DARK } from './themes/lal-palette.js';

export const LAL_BRAND_CYAN = LAL_BRAND.tertiary;
export const LAL_BRAND_GREEN = LAL_BRAND.secondary;
export const LAL_BRAND_YELLOW = LAL_BRAND.primary;
export const LAL_BRAND_GRADIENT: string[] = [...LAL_PALETTE_DARK.GradientColors];
