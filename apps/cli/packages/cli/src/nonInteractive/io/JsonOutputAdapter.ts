/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type { CLIAssistantMessage, CLIMessage } from '../types.js';
import {
  BaseJsonOutputAdapter,
  type JsonOutputAdapterInterface,
  type ResultOptions,
} from './BaseJsonOutputAdapter.js';

/**
 * JSON output adapter that collects all messages and emits them
 * as a single JSON array at the end of the turn.
 * Supports both main agent and subagent messages through distinct APIs.
 */
export class JsonOutputAdapter
  extends BaseJsonOutputAdapter
  implements JsonOutputAdapterInterface
{
  private readonly messages: CLIMessage[] = [];
  private readonly terminalToolNames = new Map<string, string>();

  constructor(config: Config) {
    super(config);
  }

  /**
   * Emits message to the messages array (batch mode).
   * Tracks the last assistant message for efficient result text extraction.
   */
  protected emitMessageImpl(message: CLIMessage): void {
    this.emitTextModeToolVisibility(message);
    this.messages.push(message);
    // Track assistant messages for result generation
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'assistant'
    ) {
      this.updateLastAssistantMessage(message as CLIAssistantMessage);
    }
  }

  /**
   * Text-mode headless runs historically printed only the model's final prose,
   * making an active tool-driven run indistinguishable from a hung process.
   * Mirror every tool boundary to stderr in real time while keeping stdout's
   * final-answer contract intact. JSON modes already expose these blocks.
   */
  private emitTextModeToolVisibility(message: CLIMessage): void {
    if (this.config.getOutputFormat() !== 'text') return;
    if (message.type !== 'assistant' && message.type !== 'user') return;
    if (!Array.isArray(message.message.content)) return;

    for (const block of message.message.content) {
      if (block.type === 'tool_use') {
        this.terminalToolNames.set(block.id, block.name);
        process.stderr.write(
          `[tool call] ${block.name} (${block.id})\nargs:\n${terminalValue(block.input)}\n`,
        );
      } else if (block.type === 'tool_result') {
        const name = this.terminalToolNames.get(block.tool_use_id) ?? 'unknown';
        const status = block.is_error ? 'error' : 'success';
        process.stderr.write(
          `[tool ${status}] ${name} (${block.tool_use_id})\nresult:\n${terminalValue(block.content ?? '')}\n`,
        );
      }
    }
  }

  /**
   * JSON mode does not emit stream events.
   */
  protected shouldEmitStreamEvents(): boolean {
    return false;
  }

  finalizeAssistantMessage(): CLIAssistantMessage {
    return this.finalizeAssistantMessageInternal(
      this.mainAgentMessageState,
      null,
    );
  }

  emitResult(options: ResultOptions): void {
    const resultMessage = this.buildResultMessage(
      options,
      this.lastAssistantMessage,
    );
    this.messages.push(resultMessage);

    if (this.config.getOutputFormat() === 'text') {
      if (resultMessage.is_error) {
        process.stderr.write(`${resultMessage.error?.message || ''}\n`);
      } else {
        process.stdout.write(`${resultMessage.result}\n`);
      }
    } else {
      // Emit the entire messages array as JSON (includes all main agent + subagent messages)
      const json = JSON.stringify(this.messages);
      process.stdout.write(`${json}\n`);
    }
  }

  emitMessage(message: CLIMessage): void {
    // In JSON mode, messages are collected in the messages array
    // This is called by the base class's finalizeAssistantMessageInternal
    // but can also be called directly for user/tool/system messages
    this.messages.push(message);
  }
}

function terminalValue(value: unknown): string {
  let rendered: string;
  if (typeof value === 'string') {
    rendered = value;
  } else {
    try {
      rendered = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      rendered = String(value);
    }
  }
  // Preserve the complete payload while preventing tool output from injecting
  // terminal control sequences. Newlines and tabs remain readable.
  return rendered
    .replace(/\u001b/g, '\\u001b')
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}
