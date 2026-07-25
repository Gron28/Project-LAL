/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import { Box, Text } from 'ink';
import {
  AuthType,
  findProviderByCredentials,
  resolveMetadataKey,
} from '@qwen-code/qwen-code-core';
import { Header, AuthDisplayType } from './Header.js';
import { Tips } from './Tips.js';
import { theme } from '../semantic-colors.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { resolveCustomBanner } from '../utils/customBanner.js';
import { t } from '../../i18n/index.js';

interface AppHeaderProps {
  version: string;
  /**
   * Collapse the banner to a single identity line.
   *
   * In virtual-scroll mode the header is PINNED outside the scroll area and its
   * measured height is subtracted from the transcript's
   * (`MainContent`: `availableTerminalHeight - vpHeaderHeight`), so it is not
   * scrollback — it is a permanent tax on the chat. Measured: an 11-line ascii
   * logo, ~4 header info lines, 2 project/shortcut lines and 3 Tips lines, about
   * 20 rows. The operator reported the result as "60% header, 20% chat, 20%
   * footer" on 2026-07-25.
   *
   * Legacy mode does not need this: there the header is the first item inside
   * <Static>, so it scrolls away into terminal scrollback on its own.
   *
   * The full banner still renders on the startup screen — the logo is kept, as
   * PLAN 7.4 requires; it just stops charging rent once there is a conversation
   * to read.
   */
  compact?: boolean;
}

/**
 * Determine the auth display type based on auth type and configuration.
 */
function getAuthDisplayType(
  authType?: AuthType,
  baseUrl?: string,
  apiKeyEnvKey?: string,
): AuthDisplayType | string {
  if (!authType) {
    return AuthDisplayType.UNKNOWN;
  }

  // LAL's managed gateway connection is identified by its fixed env key.
  // Checking this before the generic preset lookup means the header always
  // shows LAL's own name for LAL's own connection, regardless of whatever
  // provider preset a baseUrl/envKey pair might otherwise coincidentally
  // resolve to.
  if (apiKeyEnvKey === 'LAL_API_KEY') {
    return 'Local AI Lab';
  }

  const matched = findProviderByCredentials(baseUrl, apiKeyEnvKey);
  if (matched && resolveMetadataKey(matched)) {
    return matched.label;
  }

  switch (authType) {
    case AuthType.QWEN_OAUTH:
      return AuthDisplayType.QWEN_OAUTH;
    default:
      return AuthDisplayType.API_KEY;
  }
}

// Project name shown on the home screen: the last path segment of the
// working directory, which is what a `cd`-scoped CLI's "project" concept
// resolves to (there is no separate project registry to consult here).
function projectNameFromDir(targetDir: string): string {
  const parts = targetDir.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : targetDir;
}

export const AppHeader = ({ version, compact = false }: AppHeaderProps) => {
  const settings = useSettings();
  const config = useConfig();
  const uiState = useUIState();
  const contentGeneratorConfig = config.getContentGeneratorConfig();
  const authType = contentGeneratorConfig?.authType;
  const model = config.getModelDisplayName();
  const targetDir = config.getTargetDir();
  const showBanner =
    !compact && !config.getScreenReader() && !settings.merged.ui?.hideBanner;
  const showTips = !(
    compact ||
    settings.merged.ui?.hideTips ||
    config.getScreenReader()
  );
  const projectName = projectNameFromDir(targetDir);
  const reasoningEffort = config.getReasoningEffort?.();
  const branchName = uiState.branchName;

  const authDisplayType = getAuthDisplayType(
    authType,
    contentGeneratorConfig?.baseUrl,
    contentGeneratorConfig?.apiKeyEnvKey,
  );

  // Resolve once per (settings identity) — file reads and sanitization are
  // not free, and the merged settings reference is stable across renders
  // until a settings hot-reload swaps it.
  const resolvedBanner = useMemo(
    () => (showBanner ? resolveCustomBanner(settings) : undefined),
    [showBanner, settings],
  );

  return (
    <Box flexDirection="column">
      {showBanner && (
        <Header
          version={version}
          authDisplayType={authDisplayType}
          model={model}
          workingDirectory={targetDir}
          customAsciiArt={resolvedBanner?.asciiArt}
          customBannerTitle={resolvedBanner?.title}
          customBannerSubtitle={resolvedBanner?.subtitle}
        />
      )}
      {showBanner && (
        <Box marginLeft={2} marginRight={2} flexDirection="column">
          <Text color={theme.text.secondary}>
            {projectName}
            {branchName ? ` (${branchName})` : ''}
            {reasoningEffort ? `  ·  ${t('effort')}: ${reasoningEffort}` : ''}
          </Text>
          <Text color={theme.text.secondary}>
            {t('Shortcuts')}: /model /mode /effort /status /help
          </Text>
        </Box>
      )}
      {showTips && <Tips />}
      {compact && (
        // One line, so the transcript keeps the rows. Identity stays visible
        // (project, branch, model) per the standing rule that LAL is never a
        // black box — the full banner is one /clear away.
        <Box marginLeft={2} marginRight={2}>
          <Text color={theme.text.secondary}>
            {projectName}
            {branchName ? ` (${branchName})` : ''}
            {`  ·  ${model}`}
            {reasoningEffort ? `  ·  ${t('effort')}: ${reasoningEffort}` : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
};
