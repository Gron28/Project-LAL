/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolNames } from '@lal/core';
import type { CommandContext } from './types.js';
import {
  buildNativeHiveToolAction,
  hiveCommand,
  NATIVE_HIVE_CODING_WORKFLOW,
} from './hive-command.js';

const context = {
  services: {
    config: {
      isWorkflowsEnabled: () => true,
      getBareMode: () => false,
      getFolderTrustFeature: () => true,
      getFolderTrust: () => true,
    },
  },
} as unknown as CommandContext;

describe('native /hive coordination recipe', () => {
  it('dispatches a non-empty objective through the native Workflow tool', async () => {
    const result = await hiveCommand.action!(
      context,
      '  repair the parser and prove it with tests  ',
    );

    expect(result).toMatchObject({
      type: 'tool',
      toolName: ToolNames.WORKFLOW,
      toolArgs: {
        args: { objective: 'repair the parser and prove it with tests' },
      },
    });
    expect(
      (result as ReturnType<typeof buildNativeHiveToolAction>).toolArgs[
        'script'
      ],
    ).toBe(NATIVE_HIVE_CODING_WORKFLOW);
  });

  it('keeps the recipe sequential and ordered inspect → implement → check → repair', () => {
    expect(NATIVE_HIVE_CODING_WORKFLOW).not.toContain('parallel(');
    expect(NATIVE_HIVE_CODING_WORKFLOW).not.toContain('pipeline(');
    const phases = ['Inspect', 'Implement', 'Check', 'Repair'].map((phase) =>
      NATIVE_HIVE_CODING_WORKFLOW.indexOf(`phase("${phase}")`),
    );
    expect(phases.every((position) => position >= 0)).toBe(true);
    expect(phases).toEqual([...phases].sort((a, b) => a - b));
    expect(NATIVE_HIVE_CODING_WORKFLOW.match(/await agent\(/g)).toHaveLength(4);
  });

  it('retains the legacy dialog only when no new objective is supplied', async () => {
    await expect(hiveCommand.action!(context, '   ')).resolves.toEqual({
      type: 'dialog',
      dialog: 'hive',
    });
  });

  it('rejects empty direct construction rather than creating a false mission', () => {
    expect(() => buildNativeHiveToolAction('  ')).toThrow(
      /non-empty objective/,
    );
  });

  it('fails visibly when the native Workflow tool is disabled, naming the fix', async () => {
    const disabled = {
      services: { config: { isWorkflowsEnabled: () => false } },
    } as unknown as CommandContext;
    const result = await hiveCommand.action!(disabled, 'repair parser');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
    });
    const content = (result as { content: string }).content;
    // The message must be self-serve: name the exact env var that unblocks
    // the command and point at the /workflows diagnostic command, not just
    // say "enable workflows" with no indication of how.
    expect(content).toContain('QWEN_CODE_ENABLE_WORKFLOWS=1');
    expect(content).toContain('/workflows');
  });

  it('checks workflow enablement before bare-mode or folder-trust gates', async () => {
    // isWorkflowsEnabled is the first gate; a disabled config must short
    // circuit before getBareMode/getFolderTrust are ever consulted.
    const disabled = {
      services: {
        config: {
          isWorkflowsEnabled: () => false,
          getBareMode: () => {
            throw new Error('getBareMode should not be called');
          },
          getFolderTrustFeature: () => {
            throw new Error('getFolderTrustFeature should not be called');
          },
        },
      },
    } as unknown as CommandContext;

    await expect(
      hiveCommand.action!(disabled, 'repair parser'),
    ).resolves.toMatchObject({
      type: 'message',
      messageType: 'error',
    });
  });
});
