/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useRef } from 'react';
import { Box } from 'ink';
import { MainContent } from '../components/MainContent.js';
import { DialogManager } from '../components/DialogManager.js';
import { Composer } from '../components/Composer.js';
import { ExitWarning } from '../components/ExitWarning.js';
import { StickyTodoList } from '../components/StickyTodoList.js';
import { BtwMessage } from '../components/messages/BtwMessage.js';
import { AgentTabBar } from '../components/agent-view/AgentTabBar.js';
import { AgentChatView } from '../components/agent-view/AgentChatView.js';
import { AgentComposer } from '../components/agent-view/AgentComposer.js';
import { LiveAgentPanel } from '../components/background-view/LiveAgentPanel.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useAgentViewState } from '../contexts/AgentViewContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { StreamingState } from '../types.js';
import { getStickyTodoMaxVisibleItems } from '../utils/todoSnapshot.js';
import { getDialogMaxHeight } from '../utils/layoutUtils.js';

export const DefaultAppLayout: React.FC = () => {
  const uiState = useUIState();
  const { refreshStatic } = useUIActions();
  const { activeView, agents } = useAgentViewState();
  const { columns: terminalWidth } = useTerminalSize();
  const hasAgents = agents.size > 0;
  const isAgentTab = activeView !== 'main' && agents.has(activeView);
  const stickyTodoWidth = Math.min(uiState.mainAreaWidth, 64);
  /**
   * Ceiling on the informational rows above the composer, as a share of the
   * terminal. Three rows minimum so a pinned todo is still legible on a very
   * short terminal; 30% so the transcript keeps the majority of the screen even
   * when the footer has everything showing at once.
   */
  const preComposerMaxHeight = Math.max(
    3,
    Math.floor((uiState.terminalHeight || 24) * 0.3),
  );
  const stickyTodoMaxVisibleItems = getStickyTodoMaxVisibleItems(
    uiState.terminalHeight,
  );
  const dialogMaxHeight = getDialogMaxHeight(
    uiState.terminalHeight,
    uiState.staticExtraHeight,
  );
  const dialogHeight = uiState.constrainHeight ? dialogMaxHeight : undefined;
  const shouldShowStickyTodos =
    uiState.stickyTodos !== null &&
    !uiState.dialogsVisible &&
    !uiState.isFeedbackDialogOpen &&
    uiState.streamingState !== StreamingState.WaitingForConfirmation;

  // Clear terminal on view switch so previous view's <Static> output
  // is removed. refreshStatic clears the terminal and bumps the
  // historyRemountKey so MainContent's <Static> re-renders all items
  // when switching back.
  const prevViewRef = useRef(activeView);
  useEffect(() => {
    if (prevViewRef.current !== activeView) {
      prevViewRef.current = activeView;
      refreshStatic();
    }
  }, [activeView, refreshStatic]);

  return (
    <Box flexDirection="column" width={terminalWidth}>
      {isAgentTab ? (
        <>
          {/* Agent view: chat history + agent-specific composer */}
          <AgentChatView agentId={activeView} />
          <Box flexDirection="column" ref={uiState.mainControlsRef}>
            <AgentComposer key={activeView} agentId={activeView} />
            <ExitWarning />
          </Box>
        </>
      ) : (
        <>
          {/* Main view: conversation history + main composer / dialogs */}
          <MainContent />
          <Box flexDirection="column" ref={uiState.mainControlsRef}>
            {uiState.dialogsVisible ? (
              <Box
                marginX={2}
                flexDirection="column"
                width={uiState.mainAreaWidth}
                height={dialogHeight}
                overflow={uiState.constrainHeight ? 'hidden' : undefined}
              >
                <DialogManager
                  terminalWidth={uiState.terminalWidth}
                  addItem={uiState.historyManager.addItem}
                />
              </Box>
            ) : (
              <>
                {/*
                  Informational rows that sit ABOVE the input, bounded so they
                  can never push the composer down. This is the failure the
                  LiveAgentPanel comment below already describes ("long output
                  could push the composer + panel off-screen"), reached from the
                  other direction: `controlsHeight` is MEASURED from this footer
                  and `availableTerminalHeight` subtracts it with no floor
                  (AppContainer), so an unbounded footer starves the transcript
                  to a strip — the collapse recorded in PLAN 7.4.

                  Capping the region above the composer fixes both ends at once,
                  because `measureElement` reports the CLIPPED height: the
                  footer's claim on the height budget is bounded by the same
                  number, with no separate plumbing.

                  Deliberately NOT a cap on the whole footer: children overflow
                  a column box from the bottom, so clipping the container would
                  eventually clip the composer itself and leave the user typing
                  into an invisible box. Losing a todo row is cosmetic; losing
                  the input is not.
                */}
                <Box
                  flexDirection="column"
                  flexShrink={0}
                  maxHeight={preComposerMaxHeight}
                  overflow="hidden"
                >
                  {shouldShowStickyTodos && (
                    <StickyTodoList
                      todos={uiState.stickyTodos!}
                      width={stickyTodoWidth}
                      maxVisibleItems={stickyTodoMaxVisibleItems}
                    />
                  )}
                  {uiState.btwItem && (
                    <Box marginX={2} width={uiState.mainAreaWidth}>
                      <BtwMessage
                        btw={uiState.btwItem.btw}
                        containerWidth={uiState.mainAreaWidth}
                      />
                    </Box>
                  )}
                </Box>
                <Composer />
              </>
            )}
            <ExitWarning />
            {/*
              LiveAgentPanel — always-on roster of running subagents,
              anchored beneath the input footer (mirrors Claude Code's
              CoordinatorAgentStatus position). Hidden whenever any
              dialog is open (auth / permission / background tasks /
              etc.) so the modal surface doesn't compete with the
              live roster, and the panel's own internal self-hide
              handles the empty-roster case.

              The panel renders INSIDE `mainControlsRef` so its rows
              are picked up by `measureElement` in `AppContainer`'s
              `controlsHeight` useLayoutEffect — `availableTerminalHeight`
              then subtracts the panel's footprint and pending history
              items in MainContent stop racing it for screen real
              estate. (Pre-fix: the panel rendered outside the ref,
              long Read/Bash output could push the composer + panel
              off-screen — a regression vs PR #3768 which suppressed
              the inline frame in the live phase.)

              Panel uses `terminalWidth`, not `mainAreaWidth` —
              `mainAreaWidth` is hard-capped at 100 cols (intended
              for markdown / code blocks where soft-wrap matters);
              live progress lines have nothing to soft-wrap, so the
              panel wants the full terminal width.
            */}
            {!uiState.dialogsVisible && (
              <LiveAgentPanel width={uiState.terminalWidth} />
            )}
          </Box>
        </>
      )}

      {/* Tab bar: visible whenever in-process agents exist and input is active */}
      {hasAgents && !uiState.dialogsVisible && <AgentTabBar />}
    </Box>
  );
};
