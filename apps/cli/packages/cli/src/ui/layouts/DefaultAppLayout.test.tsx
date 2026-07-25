/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { DefaultAppLayout } from './DefaultAppLayout.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';
import { useAgentViewState } from '../contexts/AgentViewContext.js';
import { StreamingState } from '../types.js';

const dialogManagerMockState = vi.hoisted(() => ({ lineCount: 1 }));

vi.mock('../components/MainContent.js', () => ({
  MainContent: () => <Text>MainContent</Text>,
}));

vi.mock('../components/DialogManager.js', () => ({
  DialogManager: () => (
    <Text>
      {Array.from(
        { length: dialogManagerMockState.lineCount },
        (_, i) => `DialogManager ${i + 1}`,
      ).join('\n')}
    </Text>
  ),
}));

vi.mock('../components/Composer.js', () => ({
  Composer: () => <Text>Composer</Text>,
}));

vi.mock('../components/ExitWarning.js', () => ({
  ExitWarning: () => <Text>ExitWarning</Text>,
}));

vi.mock('../components/messages/BtwMessage.js', () => ({
  BtwMessage: () => <Text>BtwMessage</Text>,
}));

const stickyTodoMockState = vi.hoisted(() => ({ lineCount: 1 }));

vi.mock('../components/StickyTodoList.js', () => ({
  StickyTodoList: () => (
    <Text>
      {Array.from(
        { length: stickyTodoMockState.lineCount },
        (_, i) => `StickyTodoList ${i + 1}`,
      ).join('\n')}
    </Text>
  ),
}));

vi.mock('../components/agent-view/AgentTabBar.js', () => ({
  AgentTabBar: () => <Text>AgentTabBar</Text>,
}));

vi.mock('../components/agent-view/AgentChatView.js', () => ({
  AgentChatView: () => <Text>AgentChatView</Text>,
}));

vi.mock('../components/agent-view/AgentComposer.js', () => ({
  AgentComposer: () => <Text>AgentComposer</Text>,
}));

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80 }),
}));

vi.mock('../contexts/AgentViewContext.js', () => ({
  useAgentViewState: vi.fn(),
}));

const mockedUseAgentViewState = useAgentViewState as Mock;

const mockUIActions = {
  refreshStatic: vi.fn(),
} as unknown as UIActions;

const baseUIState: Partial<UIState> = {
  dialogsVisible: false,
  isFeedbackDialogOpen: false,
  mainControlsRef: { current: null },
  mainAreaWidth: 80,
  terminalWidth: 80,
  terminalHeight: 24,
  staticExtraHeight: 0,
  constrainHeight: true,
  streamingState: StreamingState.Idle,
  historyManager: {
    addItem: vi.fn(),
    history: [],
    updateItem: vi.fn(),
    clearItems: vi.fn(),
    loadHistory: vi.fn(),
    truncateToItem: vi.fn(),
    compactOldItems: vi.fn(),
  },
  stickyTodos: [
    {
      id: 'todo-1',
      content: 'Pinned task',
      status: 'pending',
    },
  ],
  btwItem: null,
};

const renderLayout = (uiState: Partial<UIState>) =>
  render(
    <UIActionsContext.Provider value={mockUIActions}>
      <UIStateContext.Provider value={uiState as UIState}>
        <DefaultAppLayout />
      </UIStateContext.Provider>
    </UIActionsContext.Provider>,
  );

function frameHeight(frame: string): number {
  return frame.length === 0 ? 0 : frame.split('\n').length;
}

describe('DefaultAppLayout', () => {
  beforeEach(() => {
    dialogManagerMockState.lineCount = 1;
    stickyTodoMockState.lineCount = 1;
  });

  it('renders sticky todo list before the composer in the main view', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });

    const { lastFrame } = renderLayout(baseUIState);
    const output = lastFrame() ?? '';

    expect(output).toContain('StickyTodoList');
    expect(output.indexOf('StickyTodoList')).toBeGreaterThan(
      output.indexOf('MainContent'),
    );
    expect(output.indexOf('StickyTodoList')).toBeLessThan(
      output.indexOf('Composer'),
    );
  });

  it('does not render sticky todo list when dialogs are visible', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });

    const { lastFrame } = renderLayout({
      ...baseUIState,
      dialogsVisible: true,
    });

    const output = lastFrame() ?? '';
    expect(output).not.toContain('StickyTodoList');
    expect(output).toContain('DialogManager 1');
  });

  it('keeps a tall dialog within the terminal frame when it appears', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });
    dialogManagerMockState.lineCount = 20;
    const terminalHeight = 8;

    const { lastFrame } = renderLayout({
      ...baseUIState,
      dialogsVisible: true,
      terminalHeight,
    });

    const output = lastFrame() ?? '';
    expect(frameHeight(output)).toBeLessThanOrEqual(terminalHeight);
    expect(output).toContain('DialogManager 1');
    expect(output).not.toContain('DialogManager 20');
  });

  it('does not cap a tall dialog when height constraints are disabled', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });
    dialogManagerMockState.lineCount = 20;
    const terminalHeight = 8;

    const { lastFrame } = renderLayout({
      ...baseUIState,
      dialogsVisible: true,
      terminalHeight,
      constrainHeight: false,
    });

    const output = lastFrame() ?? '';
    expect(frameHeight(output)).toBeGreaterThan(terminalHeight);
    expect(output).toContain('DialogManager 20');
  });

  it('does not render sticky todo list while waiting for confirmation', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });

    const { lastFrame } = renderLayout({
      ...baseUIState,
      streamingState: StreamingState.WaitingForConfirmation,
    });

    const output = lastFrame() ?? '';
    expect(output).not.toContain('StickyTodoList');
    expect(output).toContain('Composer');
  });

  it('does not render sticky todo list when feedback dialog is open', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });

    const { lastFrame } = renderLayout({
      ...baseUIState,
      isFeedbackDialogOpen: true,
    });

    const output = lastFrame() ?? '';
    expect(output).not.toContain('StickyTodoList');
    expect(output).toContain('Composer');
  });

  it('does not render sticky todo list in an agent tab view', () => {
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'agent-1',
      agents: new Map([['agent-1', {}]]),
    });

    const { lastFrame } = renderLayout(baseUIState);

    const output = lastFrame() ?? '';
    expect(output).not.toContain('StickyTodoList');
    expect(output).toContain('AgentChatView');
    expect(output).toContain('AgentComposer');
  });
});

describe('DefaultAppLayout footer bounding (PLAN 7.4)', () => {
  beforeEach(() => {
    dialogManagerMockState.lineCount = 1;
    stickyTodoMockState.lineCount = 1;
    mockedUseAgentViewState.mockReturnValue({
      activeView: 'main',
      agents: new Map(),
    });
  });

  // NOTE ON WHAT CANNOT BE TESTED HERE. The symptom is "the composer is pushed
  // off a real terminal", but ink-testing-library renders the whole tree to a
  // string without enforcing a viewport, so `expect(output).toContain('Composer')`
  // passes whether or not the cap exists. That assertion was written, observed to
  // pass with the fix REMOVED, and deleted rather than kept as a green tick over
  // an unverified claim. What is verifiable is the clipping behaviour below —
  // that the rows above the composer are the ones bounded — and that is what the
  // fix actually changes. Real-viewport behaviour still needs a human looking at
  // a terminal.

  it('clips the rows above the composer rather than the composer itself', () => {
    stickyTodoMockState.lineCount = 40;

    const { lastFrame } = renderLayout({ ...baseUIState, terminalHeight: 20 });
    const output = lastFrame() ?? '';

    // 30% of 20 rows, so only a handful of the 40 todo lines survive. Losing a
    // todo row is cosmetic; losing the input is not.
    const shownTodoLines = (output.match(/StickyTodoList \d+/g) ?? []).length;
    expect(shownTodoLines).toBeGreaterThan(0);
    expect(shownTodoLines).toBeLessThan(40);
    expect(output.indexOf('Composer')).toBeGreaterThan(
      output.indexOf('StickyTodoList 1'),
    );
  });

  it('does not clip a footer that already fits', () => {
    stickyTodoMockState.lineCount = 2;

    const { lastFrame } = renderLayout({ ...baseUIState, terminalHeight: 40 });
    const output = lastFrame() ?? '';

    expect(output).toContain('StickyTodoList 1');
    expect(output).toContain('StickyTodoList 2');
    expect(output).toContain('Composer');
  });
});
