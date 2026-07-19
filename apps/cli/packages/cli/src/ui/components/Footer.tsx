/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { ContextUsageDisplay } from './ContextUsageDisplay.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { AutoAcceptIndicator } from './AutoAcceptIndicator.js';
import { ShellModeIndicator } from './ShellModeIndicator.js';
import { BackgroundTasksPill } from './background-view/BackgroundTasksPill.js';
import { MCPHealthPill } from './mcp/MCPHealthPill.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';

import { MAX_STATUS_LINES, useStatusLine } from '../hooks/useStatusLine.js';
import { useConfigInitMessage } from '../hooks/useConfigInitMessage.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useVimModeState } from '../contexts/VimModeContext.js';
import { GeminiSpinner } from './GeminiRespondingSpinner.js';
import { GoalPill, useFooterGoalState } from './GoalPill.js';
import { CronPill, useFooterCronTaskCount } from './CronPill.js';
import { useGatewayStats } from '../hooks/useGatewayStats.js';
import { t } from '../../i18n/index.js';

// Eight-level bar so the wave reads as a smooth line at full terminal width
// instead of the old three-height strip. Inverted on purpose: a confident
// token is a calm, low bar; a hesitant one spikes — the shape a reader scans
// for is "where did it spike", not "where was it tall".
const CERTAINTY_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

function certaintyGlyph(value: number): string {
  const clamped = Math.max(0, Math.min(1, value));
  const level = Math.min(
    CERTAINTY_GLYPHS.length - 1,
    Math.floor((1 - clamped) * CERTAINTY_GLYPHS.length),
  );
  return CERTAINTY_GLYPHS[level];
}

function certaintyColor(value: number): string {
  if (value >= 0.8) return theme.status.success;
  if (value >= 0.55) return theme.status.warning;
  return theme.status.error;
}

export const Footer: React.FC = () => {
  const uiState = useUIState();
  const config = useConfig();
  const settings = useSettings();
  const { vimEnabled, vimMode } = useVimModeState();
  const {
    lines: statusLineLines,
    useThemeColors,
    respectUserColors,
    hideContextIndicator,
  } = useStatusLine();
  const configInitMessage = useConfigInitMessage(uiState.isConfigInitialized);

  const { promptTokenCount, showAutoAcceptIndicator } = {
    promptTokenCount: uiState.sessionStats.lastPromptTokenCount,
    showAutoAcceptIndicator: uiState.showAutoAcceptIndicator,
  };

  const { columns: terminalWidth } = useTerminalSize();
  const isNarrow = isNarrowWidth(terminalWidth);
  const certainty = uiState.certaintyWave;
  const certaintyAverage = certainty.length
    ? certainty.reduce((sum, value) => sum + value, 0) / certainty.length
    : null;
  const showCertaintyWave =
    certainty.length > 0 || uiState.streamingState !== 'idle';
  const certaintyPrefix = 'J-space ';
  const certaintySuffix =
    certaintyAverage == null
      ? ' n/a (backend sent no token probabilities)'
      : ` ${Math.round(certaintyAverage * 100)}%`;
  // Bar spans the full row: terminal width minus the Box's paddingX={2} (2
  // columns each side) and the label/percentage text either side of it.
  const certaintyBarWidth = Math.max(
    1,
    terminalWidth - 4 - certaintyPrefix.length - certaintySuffix.length,
  );
  const certaintyValues = certainty.slice(-certaintyBarWidth);
  // Left-pad with a dim placeholder so the wave visibly sweeps in from the
  // right at the start of a turn instead of jumping straight to full width.
  const certaintyPadCount = certaintyBarWidth - certaintyValues.length;

  // Determine sandbox info from environment
  const sandboxEnv = process.env['SANDBOX'];
  const sandboxInfo = sandboxEnv
    ? sandboxEnv === 'sandbox-exec'
      ? 'seatbelt'
      : sandboxEnv.startsWith('qwen-code')
        ? 'docker'
        : sandboxEnv
    : null;

  // Check if debug mode is enabled
  const debugMode = config.getDebugMode();

  const contextWindowSize =
    config.getContentGeneratorConfig()?.contextWindowSize;

  // Hide "? for shortcuts" when a custom status line is active (it already
  // occupies the footer, so the hint is redundant). Matches upstream behavior.
  const suppressHint = statusLineLines.length > 0;

  // MCP init progress lives in this row (not a standalone component above the
  // input) so the live area's height is constant in the default case, avoiding
  // the residual-blank-line artifact left behind when a separate block unmounts.
  // When a custom status line is active, the row shrinks by 1 on transition to
  // ready — a one-time, small regression preferred over hiding init progress.
  //
  // `configInitMessage` is placed ahead of `showAutoAcceptIndicator` so users
  // launched with YOLO / auto-accept-edits still see the ~1s startup progress;
  // the approval-mode indicator takes over as soon as init finishes.
  const leftBottomContent = uiState.ctrlCPressedOnce ? (
    <Text color={theme.status.warning}>{t('Press Ctrl+C again to exit.')}</Text>
  ) : uiState.ctrlDPressedOnce ? (
    <Text color={theme.status.warning}>{t('Press Ctrl+D again to exit.')}</Text>
  ) : uiState.showEscapePrompt ? (
    <Text color={theme.text.secondary}>{t('Press Esc again to clear.')}</Text>
  ) : uiState.rewindEscPending ? (
    <Text color={theme.text.secondary}>
      {t('Press Esc again to rewind conversation.')}
    </Text>
  ) : vimEnabled && vimMode === 'INSERT' ? (
    <Text color={theme.text.secondary}>-- INSERT --</Text>
  ) : vimEnabled && vimMode === 'NORMAL' ? (
    <Text color={theme.text.secondary}>-- NORMAL --</Text>
  ) : uiState.shellModeActive ? (
    <ShellModeIndicator />
  ) : configInitMessage ? (
    <Text color={theme.text.secondary}>
      <GeminiSpinner /> {configInitMessage}
    </Text>
  ) : uiState.startupIdeConnectionStatus.state === 'connecting' ? (
    <Text color={theme.text.secondary}>
      <GeminiSpinner /> {t('IDE connecting... context may be unavailable')}
    </Text>
  ) : uiState.startupIdeConnectionStatus.state === 'failed' ? (
    <Text color={theme.status.warning}>
      {t('IDE connection unavailable: {{message}}', {
        message: uiState.startupIdeConnectionStatus.message,
      })}
    </Text>
  ) : showAutoAcceptIndicator !== undefined ? (
    <AutoAcceptIndicator approvalMode={showAutoAcceptIndicator} />
  ) : suppressHint ? null : (
    <Text color={theme.text.secondary}>{t('? for shortcuts')}</Text>
  );

  const gatewayStats = useGatewayStats();
  // Either source can be ahead of the other by one polling interval. Treat a
  // live local turn or a gateway-owned run as alive; neither implies that the
  // requested work has passed acceptance.
  const isRunning =
    uiState.streamingState !== 'idle' || gatewayStats?.runAlive === true;
  const configuredModel = config.getModel();
  const sessionId = config.getSessionId();
  const toolCallCount = uiState.sessionStats.metrics.tools.totalCalls;
  let lastLoopType: string | null = null;
  try {
    lastLoopType = config
      .getGeminiClient()
      .getLoopDetectionService()
      .getLastLoopType();
  } catch {
    // The footer can render during startup before the client is initialized.
  }
  // Host truth beats client assumption: flag when the gateway is serving a
  // different model than the one this session is configured for.
  const modelMismatch =
    gatewayStats?.servingModel &&
    configuredModel &&
    gatewayStats.servingModel !== configuredModel;

  const rightItems: Array<{ key: string; node: React.ReactNode }> = [];
  // Always-visible model + run-state: `▶` while a turn is running, `●` when
  // the model is resident on the host GPU, `○` when the GPU is cold.
  if (configuredModel) {
    const stateGlyph = isRunning
      ? '▶'
      : gatewayStats?.servingModel === configuredModel
        ? '●'
        : '○';
    rightItems.push({
      key: 'model',
      node: (
        <Text
          color={isRunning ? theme.status.success : theme.text.secondary}
          wrap="truncate"
        >
          {`${stateGlyph} ${configuredModel}`}
          {modelMismatch ? (
            <Text color={theme.status.warning}>
              {` (host: ${gatewayStats!.servingModel})`}
            </Text>
          ) : null}
        </Text>
      ),
    });
  }
  rightItems.push({
    key: 'run',
    node: (
      <Text color={isRunning ? theme.status.success : theme.text.secondary}>
        {isRunning ? 'run alive' : 'run idle'}
      </Text>
    ),
  });
  rightItems.push({
    key: 'session',
    node: (
      <Text
        color={theme.text.secondary}
      >{`sid ${sessionId.slice(0, 8)}`}</Text>
    ),
  });
  rightItems.push({
    key: 'tools',
    node: <Text color={theme.text.secondary}>{`tools ${toolCallCount}`}</Text>,
  });
  if (gatewayStats?.backend) {
    rightItems.push({
      key: 'backend',
      node: (
        <Text color={theme.text.secondary}>
          {`${gatewayStats.backend}${gatewayStats.gpuOffload ? ` ${gatewayStats.gpuOffload}` : ''}${gatewayStats.activeContext ? ` ${Math.round(gatewayStats.activeContext / 1024)}k` : ''}`}
        </Text>
      ),
    });
  }
  if (lastLoopType) {
    rightItems.push({
      key: 'loop',
      node: <Text color={theme.status.warning}>{`loop ${lastLoopType}`}</Text>,
    });
  }
  if (gatewayStats && gatewayStats.vramUsedGb != null) {
    const vramHot = (gatewayStats.vramPct ?? 0) >= 90;
    rightItems.push({
      key: 'gpu',
      node: (
        <Text color={vramHot ? theme.status.warning : theme.text.secondary}>
          {`GPU ${gatewayStats.gpuPct ?? 0}% · ${gatewayStats.vramUsedGb}/${gatewayStats.vramTotalGb ?? '?'}G`}
        </Text>
      ),
    });
  }
  if (sandboxInfo) {
    rightItems.push({
      key: 'sandbox',
      node: <Text color={theme.status.success}>{sandboxInfo}</Text>,
    });
  }
  if (config.isSafeMode()) {
    rightItems.push({
      key: 'safe-mode',
      node: <Text color={theme.status.warning}>⚠ Safe Mode</Text>,
    });
  }
  if (debugMode) {
    rightItems.push({
      key: 'debug',
      node: <Text color={theme.status.warning}>Debug Mode</Text>,
    });
  }
  // Dream tasks now surface via the BackgroundTasksPill (e.g. "1 dream")
  // alongside the other background-task kinds. The previous `◆ dreaming`
  // right-column indicator was removed to avoid two simultaneous signals
  // for the same underlying state.
  if (promptTokenCount > 0 && contextWindowSize && !hideContextIndicator) {
    rightItems.push({
      key: 'context',
      node: (
        <Text color={theme.text.accent}>
          <ContextUsageDisplay
            promptTokenCount={promptTokenCount}
            terminalWidth={terminalWidth}
            contextWindowSize={contextWindowSize}
          />
        </Text>
      ),
    });
  }
  // Goal pill: only present in `rightItems` when a goal is active so the
  // divider chain stays tight; the pill itself does the live elapsed-time
  // refresh internally.
  const goalActive = useFooterGoalState() !== undefined;
  if (goalActive) {
    rightItems.push({ key: 'goal', node: <GoalPill /> });
  }
  const cronTaskCount = useFooterCronTaskCount();
  if (cronTaskCount > 0) {
    rightItems.push({ key: 'cron', node: <CronPill count={cronTaskCount} /> });
  }

  // Layout matches upstream: left column has status line (top) + hints/mode
  // (bottom), right section has indicators. Status line and hints coexist.
  // J-space renders as its own full-width row below both columns — it used
  // to live inside the constrained left column and shared space with the
  // right-column indicators, capping it at a fraction of the terminal.
  return (
    <>
    <Box
      flexDirection={isNarrow ? 'column' : 'row'}
      justifyContent={isNarrow ? 'flex-start' : 'space-between'}
      width="100%"
      paddingX={2}
      gap={isNarrow ? 0 : 1}
    >
      {/* Left column — status line on top, hints/mode on bottom */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={isNarrow ? 0 : 1}
        minWidth={0}
      >
        {statusLineLines.length > 0 &&
          !uiState.ctrlCPressedOnce &&
          !uiState.ctrlDPressedOnce && (
            <Box
              flexDirection="column"
              maxHeight={MAX_STATUS_LINES}
              overflow="hidden"
              width="100%"
            >
              <Text
                color={
                  respectUserColors
                    ? undefined
                    : useThemeColors
                      ? theme.text.accent
                      : undefined
                }
                dimColor={respectUserColors ? false : !useThemeColors}
                wrap="wrap"
              >
                {statusLineLines.join('\n')}
              </Text>
            </Box>
          )}
        {/* Built-in worktree indicator. Shown by default whenever a
            worktree is active so the user always has a UI affordance,
            even when a custom statusline is configured — their script
            may not render `payload.worktree` (written before Phase C,
            ignored by choice, or only rendering some fields), and
            silently hiding the indicator could let the user operate
            in the wrong cwd. Users who want the suppression behaviour
            (e.g. their statusline already renders worktree) can opt
            in via the `ui.hideBuiltinWorktreeIndicator` setting.
            Hidden during ctrl-quit warnings so they take precedence.
            (PR #4174 review #3256241831.) */}
        {uiState.activeWorktree &&
          !settings.merged.ui?.hideBuiltinWorktreeIndicator &&
          !uiState.ctrlCPressedOnce &&
          !uiState.ctrlDPressedOnce && (
            <Text dimColor wrap="truncate">
              {`⎇ ${uiState.activeWorktree.branch} (${uiState.activeWorktree.slug})`}
            </Text>
          )}
        {/* P7-trigger: the current turn was steered toward the Workflow tool
            by the `workflow` keyword. Hidden during ctrl-quit warnings so they
            take precedence (matches the worktree indicator above). */}
        {uiState.workflowKeywordActive &&
          !uiState.ctrlCPressedOnce &&
          !uiState.ctrlDPressedOnce && (
            <Text color={theme.text.accent} wrap="truncate">
              {`▷ ${t('workflow active')}`}
            </Text>
          )}
        <Box flexDirection="row" flexShrink={1}>
          <Text wrap="truncate">{leftBottomContent}</Text>
          <BackgroundTasksPill />
          <MCPHealthPill />
          {!uiState.isSkillReviewDialogOpen &&
            (uiState.skillReviewPending?.skills.length ?? 0) > 0 && (
              <Text color={theme.status.warning}>
                {` ⚠ ${t('{{count}} skill(s) pending review', {
                  count: String(uiState.skillReviewPending!.skills.length),
                })}`}
              </Text>
            )}
        </Box>
      </Box>

      {/* Right Section — never compressed, aligns to top so multi-line
          status lines on the left don't push the indicators to the center. */}
      <Box flexShrink={0} gap={1} alignItems="flex-start">
        {rightItems.map(({ key, node }, index) => (
          <Box key={key} alignItems="center">
            {index > 0 && <Text color={theme.text.secondary}> | </Text>}
            {node}
          </Box>
        ))}
      </Box>
    </Box>
    {showCertaintyWave && (
      <Box width="100%" paddingX={2}>
        <Text wrap="truncate">
          <Text color={theme.text.secondary}>{certaintyPrefix}</Text>
          {/* Honest gap label: the LAL gateway requests token probabilities
              from llama.cpp for every streamed turn (native n_probs bypasses
              the OAI logprobs+tools+stream 400), but Ollama-served models
              and remote providers may send none — say so instead of
              "waiting" forever. */}
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
          <Text color={theme.text.secondary}>{certaintySuffix}</Text>
        </Text>
      </Box>
    )}
    </>
  );
};
