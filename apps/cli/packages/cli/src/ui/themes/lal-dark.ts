/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ColorsTheme, Theme } from './theme.js';
import type { SemanticColors } from './semantic-tokens.js';

// LAL brand palette: green → lime → yellow (see Header.tsx brand constants).
// Blue/purple roles from the inherited themes are re-pointed at the
// green–lime axis so every surface (links, accents, focus borders, symbols,
// syntax) reads as one system. Red stays reserved for errors/diff-removed.
const lalDarkColors: ColorsTheme = {
  type: 'dark',
  Background: '#0B0F0C',
  // Keep all reading text comfortably above the near-black background.
  Foreground: '#F2F7F1',
  // "LightBlue" slot → light lime (inline code, names).
  LightBlue: '#D5FF8A',
  // "AccentBlue" slot → lime-green (links, focused borders, types).
  AccentBlue: '#A9FF73',
  // "AccentPurple" slot → yellow-lime (accents, literals).
  AccentPurple: '#FFF28A',
  // Mint-green (quotes, symbols) — cool counterpoint inside the family.
  AccentCyan: '#A7FFE1',
  AccentGreen: '#80FF9B',
  AccentYellow: '#FFE78A',
  AccentRed: '#F26D78',
  AccentYellowDim: '#C9BB56',
  AccentRedDim: '#D97984',
  DiffAdded: '#80FF9B',
  DiffRemoved: '#F26D78',
  Comment: '#AABAAA',
  Gray: '#8FA18F',
  GradientColors: ['#80FF9B', '#CFFF68', '#FFE78A'],
};

const lalDarkSemanticColors: SemanticColors = {
  text: {
    primary: lalDarkColors.Foreground,
    secondary: lalDarkColors.Gray,
    link: lalDarkColors.AccentBlue,
    accent: lalDarkColors.AccentPurple,
    code: lalDarkColors.LightBlue,
  },
  background: {
    primary: lalDarkColors.Background,
    diff: {
      added: lalDarkColors.DiffAdded,
      removed: lalDarkColors.DiffRemoved,
    },
  },
  border: {
    default: lalDarkColors.Gray,
    focused: lalDarkColors.AccentBlue,
  },
  ui: {
    comment: lalDarkColors.Comment,
    symbol: lalDarkColors.AccentGreen,
    gradient: lalDarkColors.GradientColors,
  },
  status: {
    error: lalDarkColors.AccentRed,
    success: lalDarkColors.AccentGreen,
    warning: lalDarkColors.AccentYellow,
    errorDim: lalDarkColors.AccentRedDim,
    warningDim: lalDarkColors.AccentYellowDim,
  },
};

export const LALDark: Theme = new Theme(
  'LAL Dark',
  'dark',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: lalDarkColors.Background,
      color: lalDarkColors.Foreground,
    },
    'hljs-keyword': {
      color: lalDarkColors.AccentYellow,
    },
    'hljs-literal': {
      color: lalDarkColors.AccentPurple,
    },
    'hljs-symbol': {
      color: lalDarkColors.AccentCyan,
    },
    'hljs-name': {
      color: lalDarkColors.LightBlue,
    },
    'hljs-link': {
      color: lalDarkColors.AccentBlue,
    },
    'hljs-function .hljs-keyword': {
      color: lalDarkColors.AccentYellow,
    },
    'hljs-subst': {
      color: lalDarkColors.Foreground,
    },
    'hljs-string': {
      color: lalDarkColors.AccentGreen,
    },
    'hljs-title': {
      color: lalDarkColors.AccentYellow,
    },
    'hljs-type': {
      color: lalDarkColors.AccentBlue,
    },
    'hljs-attribute': {
      color: lalDarkColors.AccentYellow,
    },
    'hljs-bullet': {
      color: lalDarkColors.AccentYellow,
    },
    'hljs-addition': {
      color: lalDarkColors.AccentGreen,
    },
    'hljs-variable': {
      color: lalDarkColors.Foreground,
    },
    'hljs-template-tag': {
      color: lalDarkColors.AccentYellow,
    },
    'hljs-template-variable': {
      color: lalDarkColors.AccentYellow,
    },
    'hljs-comment': {
      color: lalDarkColors.Comment,
      fontStyle: 'italic',
    },
    'hljs-quote': {
      color: lalDarkColors.AccentCyan,
      fontStyle: 'italic',
    },
    'hljs-deletion': {
      color: lalDarkColors.AccentRed,
    },
    'hljs-meta': {
      color: lalDarkColors.AccentYellow,
    },
    'hljs-doctag': {
      fontWeight: 'bold',
    },
    'hljs-strong': {
      fontWeight: 'bold',
    },
    'hljs-emphasis': {
      fontStyle: 'italic',
    },
  },
  lalDarkColors,
  lalDarkSemanticColors,
);
