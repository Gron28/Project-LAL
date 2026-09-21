/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildNativeHiveWorkflowParams,
  NATIVE_HIVE_CODING_WORKFLOW,
  ToolNames,
} from '@lal/core';
import type {
  SlashCommand,
  MessageActionReturn,
  OpenDialogActionReturn,
  ToolActionReturn,
} from './types.js';
import { CommandKind } from './types.js';

export function buildNativeHiveToolAction(objective: string): ToolActionReturn {
  return {
    type: 'tool',
    toolName: ToolNames.WORKFLOW,
    toolArgs: buildNativeHiveWorkflowParams(objective),
  };
}

export { NATIVE_HIVE_CODING_WORKFLOW };

/**
 * `/hive <objective>` executes through the native CLI Workflow tool and owns
 * the current project locally. Bare `/hive` keeps the legacy dialog available
 * temporarily for reattaching old host runs and compatibility while the
 * remaining history/read and live-acceptance work migrates.
 */
export const hiveCommand: SlashCommand = {
  name: 'hive',
  altNames: ['hive-mode'],
  description:
    'Run a sequential native coding workflow; omit the objective to open the legacy HIVE dialog.',
  argumentHint: '[coding objective]',
  acceptsInput: true,
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (
    context,
    args,
  ): Promise<
    OpenDialogActionReturn | ToolActionReturn | MessageActionReturn
  > => {
    const objective = (args ?? '').trim();
    if (objective) {
      const config = context.services.config;
      if (!config?.isWorkflowsEnabled?.()) {
        return {
          type: 'message',
          messageType: 'error',
          content:
            'Native HIVE requires the Workflow tool, which is disabled by default. ' +
            'Set QWEN_CODE_ENABLE_WORKFLOWS=1 in your environment and restart `lal`, ' +
            'then run `/hive <objective>` again. Once enabled, `/workflows` shows ' +
            'workflow status and history.',
        };
      }
      if (config.getBareMode?.()) {
        return {
          type: 'message',
          messageType: 'error',
          content:
            'Native HIVE is unavailable in bare mode because it executes project-local tools.',
        };
      }
      if (config.getFolderTrustFeature?.() && !config.getFolderTrust?.()) {
        return {
          type: 'message',
          messageType: 'error',
          content:
            'Trust this project before running a native HIVE coding workflow.',
        };
      }
      return buildNativeHiveToolAction(objective);
    }
    return { type: 'dialog', dialog: 'hive' };
  },
};
