/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolDisplayNames, ToolNames } from '@qwen-code/qwen-code-core';

/**
 * Internal-tool-name → user-facing display-name lookup
 * (`run_shell_command` → `Shell`, `glob` → `Glob`, …). Shared by every
 * surface that renders subagent tool activity (LiveAgentPanel,
 * BackgroundTasksDialog, InlineParallelAgentsDisplay, ToolMessage's
 * approval context) so the vocabulary can't drift between them.
 */
export const TOOL_DISPLAY_BY_NAME: Record<string, string> = Object.fromEntries(
  (Object.keys(ToolNames) as Array<keyof typeof ToolNames>).map((key) => [
    ToolNames[key],
    ToolDisplayNames[key],
  ]),
);

/**
 * Per-tool glyphs so scanning a run's scrollback reads by shape, not by
 * name. Keyed by BOTH the internal tool name and its display name (call
 * sites hold one or the other). Single-width unicode only — emoji render
 * double-width in most terminals and break Ink column math.
 */
const TOOL_ICON_ENTRIES: Array<[keyof typeof ToolNames, string]> = [
  ['EDIT', '✎'],
  ['WRITE_FILE', '✎'],
  ['READ_FILE', '☰'],
  ['GREP', '⌕'],
  ['GLOB', '⌕'],
  ['SHELL', '❯'],
  ['TODO_WRITE', '☑'],
  ['MEMORY', '◆'],
  ['AGENT', '⚇'],
  ['SKILL', '★'],
  ['EXIT_PLAN_MODE', '▤'],
  ['ENTER_PLAN_MODE', '▤'],
  ['WEB_FETCH', '↓'],
  ['WEB_SEARCH', '⌕'],
  ['LS', '☰'],
  ['ASK_USER_QUESTION', '?'],
  ['TASK_CREATE', '☑'],
  ['TASK_UPDATE', '☑'],
  ['TASK_LIST', '☑'],
  ['SEND_MESSAGE', '➤'],
  ['TOOL_SEARCH', '⌕'],
];

export const TOOL_ICON_BY_NAME: Record<string, string> = Object.fromEntries(
  TOOL_ICON_ENTRIES.flatMap(([key, icon]) => [
    [ToolNames[key], icon],
    [ToolDisplayNames[key], icon],
  ]),
);

const DEFAULT_TOOL_ICON = '⚙';

/** Glyph for a tool, by internal or display name; MCP/unknown get a gear. */
export function getToolIcon(name: string): string {
  return TOOL_ICON_BY_NAME[name] ?? DEFAULT_TOOL_ICON;
}
