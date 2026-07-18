/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mapToDisplay, type TrackedToolCall } from './useReactToolScheduler.js';

// Build a minimal successful tracked tool call with the fields mapToDisplay's
// success branch reads. `displayName` drives the collapsible gate.
const makeSuccess = (displayName: string): TrackedToolCall =>
  ({
    status: 'success',
    request: { callId: 'call-1', name: 'read_file', args: {} },
    tool: { displayName, isOutputMarkdown: false },
    invocation: { getDescription: () => 'reading' },
    response: {
      resultDisplay: 'Read 1 file',
      responseParts: [
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
            response: { output: 'FULL FILE CONTENT' },
          },
        },
      ],
    },
  }) as unknown as TrackedToolCall;

describe('mapToDisplay — detailedDisplay (§4.9 live path)', () => {
  it('extracts detailedDisplay for a collapsible (read/search/list) tool', () => {
    const group = mapToDisplay(makeSuccess('Read File'));
    const tool = group.tools[0];
    // Summary stays the compact resultDisplay; full detail is derived from the
    // persisted functionResponse for the Ctrl+O transcript.
    expect(tool.resultDisplay).toBe('Read 1 file');
    expect(tool.detailedDisplay).toBe('FULL FILE CONTENT');
  });

  it('extracts detailedDisplay for non-collapsible tools too', () => {
    // Every tool stores its exact functionResponse text so the Ctrl+O
    // transcript can show precisely what the model received — the primary
    // debugging surface for small local models.
    const group = mapToDisplay(makeSuccess('Edit'));
    expect(group.tools[0].detailedDisplay).toBe('FULL FILE CONTENT');
  });
});
