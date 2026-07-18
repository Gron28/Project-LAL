/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { sanitizeTerminalText } from '../utils/textUtils.js';

export const LIVE_TOOL_ARGS_PANEL_MAX_ROWS = 8;

export interface LiveToolArgsPreview {
  name: string;
  argsChars: number;
  preview: string;
}

/**
 * Live "code as it's written" panel: renders the tail of a streaming tool
 * call's argument buffer while the model is still generating it, so a big
 * write_file/plan reads as code scrolling by instead of a silent spinner.
 * Ephemeral by design — once the call completes, the regular tool card takes
 * over and this panel disappears.
 */
export const LiveToolArgsPanel: React.FC<{
  data: LiveToolArgsPreview;
  terminalWidth: number;
}> = ({ data, terminalWidth }) => {
  const size =
    data.argsChars >= 1000
      ? `${(data.argsChars / 1000).toFixed(1)}k`
      : `${data.argsChars}`;
  const innerWidth = Math.max(20, terminalWidth - 4);
  // The buffer is raw model output: strip control sequences, then keep only
  // the last rows that fit, hard-wrapping long lines to the panel width.
  const rows: string[] = [];
  for (const line of sanitizeTerminalText(data.preview).split('\n')) {
    if (line.length <= innerWidth) {
      rows.push(line);
    } else {
      for (let i = 0; i < line.length; i += innerWidth) {
        rows.push(line.slice(i, i + innerWidth));
      }
    }
  }
  const visible = rows.slice(-LIVE_TOOL_ARGS_PANEL_MAX_ROWS);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      paddingX={1}
      width={terminalWidth}
    >
      <Text color={theme.text.accent}>
        {'✎ '}
        {data.name}
        <Text color={theme.text.secondary}> · {size} chars · writing…</Text>
      </Text>
      {visible.map((row, i) => (
        <Text key={i} color={theme.text.secondary} wrap="truncate">
          {row === '' ? ' ' : row}
        </Text>
      ))}
    </Box>
  );
};
