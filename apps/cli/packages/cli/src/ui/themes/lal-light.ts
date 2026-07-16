/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ColorsTheme, Theme } from './theme.js';
import type { SemanticColors } from './semantic-tokens.js';

// Light variant of the LAL green → lime → yellow palette. Hues are deepened
// for contrast on a paper-white background; red stays reserved for errors.
const lalLightColors: ColorsTheme = {
  type: 'light',
  Background: '#F7FAF5',
  Foreground: '#2B342C',
  // "LightBlue" slot → deep lime (inline code, names).
  LightBlue: '#5C8F1E',
  // "AccentBlue" slot → deep green (links, focused borders, types).
  AccentBlue: '#1E9E4A',
  // "AccentPurple" slot → olive-yellow (accents, literals).
  AccentPurple: '#87851A',
  // Deep mint (quotes, symbols).
  AccentCyan: '#1C8F76',
  AccentGreen: '#1E9E4A',
  AccentYellow: '#9A8A16',
  AccentRed: '#D14856',
  AccentYellowDim: '#C6BA6E',
  AccentRedDim: '#E2A2A9',
  DiffAdded: '#1E9E4A',
  DiffRemoved: '#D14856',
  Comment: '#7A857B',
  Gray: '#9AA69B',
  GradientColors: ['#1E9E4A', '#5C8F1E', '#9A8A16'],
};

const lalLightSemanticColors: SemanticColors = {
  text: {
    primary: lalLightColors.Foreground,
    secondary: lalLightColors.Gray,
    link: lalLightColors.AccentBlue,
    accent: lalLightColors.AccentPurple,
    code: lalLightColors.LightBlue,
  },
  background: {
    primary: lalLightColors.Background,
    diff: {
      added: lalLightColors.DiffAdded,
      removed: lalLightColors.DiffRemoved,
    },
  },
  border: {
    default: lalLightColors.Gray,
    focused: lalLightColors.AccentBlue,
  },
  ui: {
    comment: lalLightColors.Comment,
    symbol: lalLightColors.AccentGreen,
    gradient: lalLightColors.GradientColors,
  },
  status: {
    error: lalLightColors.AccentRed,
    success: lalLightColors.AccentGreen,
    warning: lalLightColors.AccentYellow,
    errorDim: lalLightColors.AccentRedDim,
    warningDim: lalLightColors.AccentYellowDim,
  },
};

export const LALLight: Theme = new Theme(
  'LAL Light',
  'light',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: lalLightColors.Background,
      color: lalLightColors.Foreground,
    },
    'hljs-keyword': {
      color: lalLightColors.AccentYellow,
    },
    'hljs-literal': {
      color: lalLightColors.AccentPurple,
    },
    'hljs-symbol': {
      color: lalLightColors.AccentCyan,
    },
    'hljs-name': {
      color: lalLightColors.LightBlue,
    },
    'hljs-link': {
      color: lalLightColors.AccentBlue,
    },
    'hljs-function .hljs-keyword': {
      color: lalLightColors.AccentYellow,
    },
    'hljs-subst': {
      color: lalLightColors.Foreground,
    },
    'hljs-string': {
      color: lalLightColors.AccentGreen,
    },
    'hljs-title': {
      color: lalLightColors.AccentYellow,
    },
    'hljs-type': {
      color: lalLightColors.AccentBlue,
    },
    'hljs-attribute': {
      color: lalLightColors.AccentYellow,
    },
    'hljs-bullet': {
      color: lalLightColors.AccentYellow,
    },
    'hljs-addition': {
      color: lalLightColors.AccentGreen,
    },
    'hljs-variable': {
      color: lalLightColors.Foreground,
    },
    'hljs-template-tag': {
      color: lalLightColors.AccentYellow,
    },
    'hljs-template-variable': {
      color: lalLightColors.AccentYellow,
    },
    'hljs-comment': {
      color: lalLightColors.Comment,
      fontStyle: 'italic',
    },
    'hljs-quote': {
      color: lalLightColors.AccentCyan,
      fontStyle: 'italic',
    },
    'hljs-deletion': {
      color: lalLightColors.AccentRed,
    },
    'hljs-meta': {
      color: lalLightColors.AccentYellow,
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
  lalLightColors,
  lalLightSemanticColors,
);
