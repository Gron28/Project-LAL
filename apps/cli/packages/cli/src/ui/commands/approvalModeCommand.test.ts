/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { approvalModeCommand } from './approvalModeCommand.js';
import {
  type CommandContext,
  CommandKind,
  type OpenDialogActionReturn,
  type MessageActionReturn,
} from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('approvalModeCommand', () => {
  let mockContext: CommandContext;
  let mockSetApprovalMode: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSetApprovalMode = vi.fn();
    mockContext = createMockCommandContext({
      services: {
        config: {
          getApprovalMode: () => 'default',
          setApprovalMode: mockSetApprovalMode,
        },
      },
    });
  });

  it('should have correct metadata', () => {
    expect(approvalModeCommand.name).toBe('approval-mode');
    expect(approvalModeCommand.description).toContain(
      'View or change the approval mode for tool usage',
    );
    expect(approvalModeCommand.kind).toBe(CommandKind.BUILT_IN);
  });

  it('should open approval mode dialog when invoked without arguments', async () => {
    const result = (await approvalModeCommand.action?.(
      mockContext,
      '',
    )) as OpenDialogActionReturn;

    expect(result.type).toBe('dialog');
    expect(result.dialog).toBe('approval-mode');
  });

  it('should open approval mode dialog when invoked with whitespace only', async () => {
    const result = (await approvalModeCommand.action?.(
      mockContext,
      '   ',
    )) as OpenDialogActionReturn;

    expect(result.type).toBe('dialog');
    expect(result.dialog).toBe('approval-mode');
  });

  describe('direct mode setting (session-only)', () => {
    it('should set approval mode to "plan" when argument is "plan"', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        'plan',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toContain('plan');
      expect(mockSetApprovalMode).toHaveBeenCalledWith('plan');
    });

    it('should set approval mode to "yolo" when argument is "yolo"', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        'yolo',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toContain('YOLO');
      expect(mockSetApprovalMode).toHaveBeenCalledWith('yolo');
    });

    it('should set approval mode to "auto-edit" when argument is "auto-edit"', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        'auto-edit',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toContain('auto-accept edits');
      expect(mockSetApprovalMode).toHaveBeenCalledWith('auto-edit');
    });

    it('should set approval mode to "default" when argument is "default"', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        'default',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      // "default" is displayed using its formatted name, not the raw enum value.
      expect(result.content).toContain('Ask permissions');
      expect(mockSetApprovalMode).toHaveBeenCalledWith('default');
    });

    it('should be case-insensitive for mode argument', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        'YOLO',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(mockSetApprovalMode).toHaveBeenCalledWith('yolo');
    });

    it('should handle argument with leading/trailing whitespace', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        '  plan  ',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(mockSetApprovalMode).toHaveBeenCalledWith('plan');
    });
  });

  describe('invalid mode argument', () => {
    it('should return error for invalid mode', async () => {
      const result = (await approvalModeCommand.action?.(
        mockContext,
        'invalid-mode',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('error');
      expect(result.content).toContain('invalid-mode');
      expect(result.content).toContain('plan');
      expect(result.content).toContain('yolo');
      expect(mockSetApprovalMode).not.toHaveBeenCalled();
    });
  });

  describe('untrusted folder handling', () => {
    it('should return error when setApprovalMode throws (e.g., untrusted folder)', async () => {
      const errorMessage =
        'Cannot enable privileged approval modes in an untrusted folder.';
      mockSetApprovalMode.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      const result = (await approvalModeCommand.action?.(
        mockContext,
        'yolo',
      )) as MessageActionReturn;

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('error');
      expect(result.content).toBe(errorMessage);
    });
  });

  it('should not have subcommands', () => {
    expect(approvalModeCommand.subCommands).toBeUndefined();
  });

  it('should not have completion function', () => {
    expect(approvalModeCommand.completion).toBeUndefined();
  });
});

describe('phone-reachable aliases (2026-07-25)', () => {
  // Shift+Tab does not exist on a phone keyboard. Reported from Termux over ssh:
  // "no way to set permissions as auto or Yolo from the phone without access to
  // tab".
  let setApprovalMode: ReturnType<typeof vi.fn>;
  const contextFor = (raw: string, args = '') => {
    setApprovalMode = vi.fn();
    return createMockCommandContext({
      services: {
        config: {
          getApprovalMode: () => 'default',
          setApprovalMode,
        },
      },
      invocation: { raw, name: 'approval-mode', args },
    });
  };

  it('exposes typing-only aliases', () => {
    expect(approvalModeCommand.altNames).toContain('yolo');
    expect(approvalModeCommand.altNames).toContain('auto-edit');
    expect(approvalModeCommand.description).toContain('without Shift+Tab');
  });

  it('/yolo sets yolo directly instead of opening a dialog', async () => {
    const result = await approvalModeCommand.action!(contextFor('/yolo'), '');
    expect(result).toMatchObject({ type: 'message' });
    expect(setApprovalMode).toHaveBeenCalledWith('yolo');
  });

  it('/auto-edit sets auto-edit directly', async () => {
    await approvalModeCommand.action!(contextFor('/auto-edit'), '');
    expect(setApprovalMode).toHaveBeenCalledWith('auto-edit');
  });

  it('a non-mode alias still opens the picker', async () => {
    const result = await approvalModeCommand.action!(contextFor('/approval'), '');
    expect(result).toMatchObject({ type: 'dialog', dialog: 'approval-mode' });
  });

  it('an explicit argument still wins over the alias', async () => {
    await approvalModeCommand.action!(contextFor('/yolo plan', 'plan'), 'plan');
    expect(setApprovalMode).toHaveBeenCalledWith('plan');
  });
});
