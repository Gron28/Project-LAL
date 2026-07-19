/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import {
  GeminiEventType,
  type ServerGeminiStreamEvent,
} from '@qwen-code/qwen-code-core';
import type { CLIAssistantMessage, CLIMessage } from '../types.js';
import {
  BaseJsonOutputAdapter,
  type JsonOutputAdapterInterface,
  type ResultOptions,
} from './BaseJsonOutputAdapter.js';

/** Seconds of total event silence between heartbeat lines. */
const LIVE_HEARTBEAT_INTERVAL_MS = 15_000;

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
  // Live text-mode streaming state: which channel is currently mirrored to
  // stderr, whether the last write ended a line, and the silence heartbeat.
  private liveChannel: 'none' | 'thinking' | 'response' = 'none';
  private liveAtLineStart = true;
  private liveHeartbeat: NodeJS.Timeout | undefined;
  private liveSawEvent = false;
  private liveSilentSeconds = 0;

  constructor(config: Config) {
    super(config);
  }

  /**
   * Text-mode headless runs used to be silent from prompt submission until
   * the final answer — a 2-3 minute reasoning stretch was indistinguishable
   * from a hang (observed 2026-07-18: a 5k-token think ran ~2.7 minutes with
   * zero output and users killed the CLI). Mirror thinking and response
   * deltas to stderr as they stream, plus a heartbeat while the model is
   * completely silent (prefill). stdout still carries only the final answer.
   * Set LAL_HEADLESS_LIVE=0 to restore the quiet behavior.
   */
  private liveTextEnabled(): boolean {
    return (
      this.config.getOutputFormat() === 'text' &&
      process.env['LAL_HEADLESS_LIVE'] !== '0'
    );
  }

  private liveWrite(text: string): void {
    if (text.length === 0) return;
    process.stderr.write(text);
    this.liveAtLineStart = text.endsWith('\n');
  }

  private liveSwitchChannel(channel: 'thinking' | 'response'): void {
    if (this.liveChannel === channel) return;
    this.liveChannel = channel;
    if (!this.liveAtLineStart) this.liveWrite('\n');
    this.liveWrite(channel === 'thinking' ? '[thinking]\n' : '[response]\n');
  }

  private liveEndTurn(): void {
    if (this.liveHeartbeat) {
      clearInterval(this.liveHeartbeat);
      this.liveHeartbeat = undefined;
    }
    if (!this.liveAtLineStart) this.liveWrite('\n');
    this.liveChannel = 'none';
  }

  override startAssistantMessage(): void {
    super.startAssistantMessage();
    if (!this.liveTextEnabled()) return;
    this.liveChannel = 'none';
    this.liveSawEvent = false;
    this.liveSilentSeconds = 0;
    if (this.liveHeartbeat) clearInterval(this.liveHeartbeat);
    this.liveHeartbeat = setInterval(() => {
      if (this.liveSawEvent) {
        this.liveSawEvent = false;
        this.liveSilentSeconds = 0;
        return;
      }
      this.liveSilentSeconds += LIVE_HEARTBEAT_INTERVAL_MS / 1000;
      if (!this.liveAtLineStart) this.liveWrite('\n');
      this.liveWrite(`[waiting for model… ${this.liveSilentSeconds}s silent]\n`);
    }, LIVE_HEARTBEAT_INTERVAL_MS);
    // Never keep the process alive just for the heartbeat.
    this.liveHeartbeat.unref?.();
  }

  override processEvent(event: ServerGeminiStreamEvent): void {
    if (this.liveTextEnabled()) {
      this.liveSawEvent = true;
      if (event.type === GeminiEventType.Thought) {
        this.liveSwitchChannel('thinking');
        this.liveWrite(
          liveSanitize(event.value.description || event.value.subject || ''),
        );
      } else if (
        event.type === GeminiEventType.Content &&
        typeof event.value === 'string'
      ) {
        this.liveSwitchChannel('response');
        this.liveWrite(liveSanitize(event.value));
      }
    }
    super.processEvent(event);
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
    if (this.liveTextEnabled()) this.liveEndTurn();
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

/**
 * Same control-sequence defense as terminalValue, but keeps the text inline
 * (no truncation, no JSON rendering) since it mirrors live prose deltas.
 */
function liveSanitize(text: string): string {
  return text
    .replace(/\u001b/g, '\\u001b')
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
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
