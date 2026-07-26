/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  OpenDialogActionReturn,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import type { ApprovalMode } from '@lal/core';
import {
  APPROVAL_MODES,
  ApprovalMode as ApprovalModeEnum,
} from '@lal/core';
import { emitAutoModeEntryNotices } from '../hooks/useAutoAcceptIndicator.js';
import { formatApprovalModeName } from '../utils/approvalModeDisplay.js';

/**
 * Parses the argument string and returns the corresponding ApprovalMode if valid.
 * Returns undefined if the argument is empty or not a valid mode.
 */
function parseApprovalModeArg(arg: string): ApprovalMode | undefined {
  const trimmed = arg.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  // Match against valid approval modes (case-insensitive)
  return APPROVAL_MODES.find((mode) => mode.toLowerCase() === trimmed);
}

export const approvalModeCommand: SlashCommand = {
  name: 'approval-mode',
  // Shift+Tab is the documented way to cycle approval modes and it is
  // UNREACHABLE on a phone keyboard — reported 2026-07-25 from Termux over ssh,
  // where there is no Tab key at all. `/approval-mode yolo` already worked, but
  // nothing told the user it existed. These aliases make the mode reachable by
  // typing, which is the only input a phone reliably has.
  altNames: ['approval', 'permissions-mode', 'yolo', 'auto-edit'],
  get description() {
    return t(
      'View or change the approval mode for tool usage (e.g. /approval-mode yolo) — works without Shift+Tab',
    );
  },
  argumentHint: '<mode>',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<OpenDialogActionReturn | MessageActionReturn> => {
    // `/yolo` and `/auto-edit` name a mode directly, so an empty argument means
    // "set that mode" rather than "open the picker". Typing four characters is a
    // very different cost on a phone than navigating a dialog.
    // `invocation.name` is the command's PRIMARY name, so it reads
    // "approval-mode" even when the user typed "/yolo". The alias the user
    // actually typed is only recoverable from the raw input.
    const invokedAs = context.invocation?.raw
      ?.trim()
      .replace(/^\//, '')
      .split(/\s+/)[0]
      ?.toLowerCase();
    const aliasMode = invokedAs ? parseApprovalModeArg(invokedAs) : undefined;
    const mode = parseApprovalModeArg(args) ?? (args.trim() ? undefined : aliasMode);

    // If no argument provided, open dialog in interactive mode;
    // in non-interactive/ACP, return current state instead
    if (!args.trim() && !aliasMode) {
      return {
        type: 'dialog',
        dialog: 'approval-mode',
      };
    }

    // If invalid argument, return error message with valid options
    if (!mode) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Invalid approval mode "{{arg}}". Valid modes: {{modes}}', {
          arg: args.trim(),
          modes: APPROVAL_MODES.join(', '),
        }),
      };
    }

    // Set the mode for current session only (not persisted)
    const { config, settings } = context.services;
    let priorMode: ApprovalMode | undefined;
    if (config) {
      try {
        priorMode = config.getApprovalMode();
        config.setApprovalMode(mode);
      } catch (e) {
        return {
          type: 'message',
          messageType: 'error',
          content: (e as Error).message,
        };
      }
    }

    // When the user switches INTO AUTO via this command (not just via
    // Shift+Tab), emit the same first-time-acknowledgement + stripped-rules
    // notices as the keyboard handler.
    if (
      mode === ApprovalModeEnum.AUTO &&
      priorMode !== ApprovalModeEnum.AUTO &&
      config
    ) {
      emitAutoModeEntryNotices({
        config,
        settings,
        addItem: context.ui.addItem,
      });
    }

    return {
      type: 'message',
      messageType: 'info',
      content: t('Approval mode set to "{{mode}}"', {
        mode: formatApprovalModeName(mode),
      }),
    };
  },
};
