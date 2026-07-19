/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentEventType,
  type AgentEventEmitter,
  type AgentApprovalRequestEvent,
  type AgentToolCallEvent,
  type AgentToolOutputUpdateEvent,
  type AgentToolResultEvent,
  type AgentUsageEvent,
} from '@qwen-code/qwen-code-core';
import {
  GatewayClient,
  type ClientRunCommand,
  type ClientRunEvent,
  type ClientRunInit,
} from '../attach/gateway-client.js';

const MAX_TOOL_OUTPUT = 4_000;
const MAX_BATCH_SIZE = 32;

export interface RemoteRunMirrorOptions extends ClientRunInit {
  client?: GatewayClient;
  emitter: AgentEventEmitter;
  heartbeatMs?: number;
  /** Optional bridge to the TUI's normal prompt submission path. The server
   * only leases `{type:'submit'}` commands; it cannot request tools/approvals. */
  onCommand?: (command: ClientRunCommand) => Promise<boolean> | boolean;
  /** Context size requested from the managed LAL host for this native run. */
  contextWindow?: number;
  /** Abort the owning native session when the gateway requests cancellation. */
  onCancel?: () => void;
}

export interface RemoteRunMirrorStatus {
  state: 'starting' | 'active' | 'stopped' | 'error';
  runId?: string;
  conversationId?: string;
  controlToken?: string;
  queuedEvents: number;
  lastError?: string;
}

function text(value: unknown, limit = MAX_TOOL_OUTPUT): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}\n[truncated]`;
}

function toolOutput(event: AgentToolResultEvent): string {
  if (event.error) return text(event.error);
  const display = event.resultDisplay;
  if (typeof display === 'string') return text(display);
  try {
    return text(JSON.stringify(display));
  } catch {
    return '[tool result unavailable]';
  }
}

/** Mirrors observable native-agent events into a client-owned gateway run.
 * It never changes local execution, permissions, or prompt routing. */
export class RemoteRunMirror {
  private readonly client: GatewayClient;
  private readonly emitter: AgentEventEmitter;
  private readonly init: ClientRunInit;
  private readonly heartbeatMs: number;
  private readonly onCommand:
    | ((command: ClientRunCommand) => Promise<boolean> | boolean)
    | undefined;
  private readonly contextWindow: number;
  private readonly onCancel: (() => void) | undefined;
  private readonly queued: ClientRunEvent[] = [];
  private runId: string | undefined;
  private conversationId: string | undefined;
  private writerToken: string | undefined;
  private controlToken: string | undefined;
  private nextSeq = 1;
  private flushing: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastError: string | undefined;
  private streamedText = '';
  private streamedThought = '';
  private readonly toolArguments = new Map<string, Record<string, unknown>>();
  private readonly toolNames = new Map<string, string>();

  private readonly onStreamText = (event: {
    text: string;
    thought?: boolean;
    p?: number;
    alts?: [string, number][];
  }) => {
    const next = event.thought
      ? this.streamDelta(event.text, 'thought')
      : this.streamDelta(event.text, 'text');
    if (next)
      this.enqueue({
        k: event.thought ? 'think' : 'text',
        v: next,
        ...(typeof event.p === 'number' ? { p: event.p } : {}),
        ...(!event.thought && event.alts?.length ? { alts: event.alts } : {}),
      });
  };
  private readonly onRoundText = (event: {
    text: string;
    thoughtText: string;
  }) => {
    const thought =
      event.thoughtText && this.streamDelta(event.thoughtText, 'thought');
    const output = event.text && this.streamDelta(event.text, 'text');
    if (thought) this.enqueue({ k: 'think', v: thought });
    if (output) this.enqueue({ k: 'text', v: output });
  };
  private readonly onToolCall = (event: AgentToolCallEvent) => {
    this.toolArguments.set(event.callId, event.args);
    this.toolNames.set(event.callId, event.name);
    this.enqueue({
      k: 'tool_request',
      v: { id: event.callId, name: event.name, args: event.args },
    });
  };
  private readonly onToolOutput = (event: AgentToolOutputUpdateEvent) =>
    this.enqueue({
      k: 'tool_progress',
      v: {
        id: event.callId,
        name: this.toolNames.get(event.callId) ?? 'tool',
        chars: text(event.outputChunk).length,
        preview: text(event.outputChunk, 500),
      },
    });
  private readonly onToolResult = (event: AgentToolResultEvent) => {
    this.enqueue({
      k: 'tool_result',
      v: {
        id: event.callId,
        name: event.name,
        ok: event.success,
        output: toolOutput(event),
      },
    });
    const args = this.toolArguments.get(event.callId) ?? {};
    this.toolArguments.delete(event.callId);
    this.toolNames.delete(event.callId);
    if (
      event.success &&
      (event.name === 'edit' || event.name === 'write_file')
    ) {
      const file = args['file_path'] ?? args['path'];
      if (typeof file === 'string' && file) {
        this.enqueue({
          k: 'artifact',
          v: { path: text(file, 2_000), kind: 'file_change' },
        });
      }
    }
    if (event.name === 'run_shell_command') {
      const command = args['command'];
      if (
        typeof command === 'string' &&
        /(?:^|\s)(?:test|check|lint|build|pytest|vitest|jest)(?:\s|$)|cargo\s+test|go\s+test/i.test(
          command,
        )
      ) {
        this.enqueue({
          k: 'phase',
          v: {
            name: `${event.success ? 'check passed' : 'check failed'}: ${text(command, 180)}`,
          },
        });
      }
    }
  };
  private readonly onApproval = (event: AgentApprovalRequestEvent) =>
    this.enqueue({
      k: 'approval_needed',
      v: { id: event.callId, name: event.name, args: event.args },
    });
  private readonly onRoundEnd = () => this.enqueue({ k: 'round' });
  private readonly onUsage = (event: AgentUsageEvent) => {
    const usage = event.usage;
    const promptTokens = usage.promptTokenCount ?? 0;
    const completionTokens = usage.candidatesTokenCount ?? 0;
    this.enqueue({
      k: 'usage',
      v: {
        promptTokens,
        completionTokens,
        totalTokens: usage.totalTokenCount ?? promptTokens + completionTokens,
        tokPerSec: null,
        // The server-side proxy later supplies measured throughput; do not
        // regress the HUD to an unknown context size when this native summary
        // arrives after the proxy's final usage frame.
        ctx: this.contextWindow,
      },
    });
  };
  // FINISH is emitted for each model reply, not when the interactive terminal
  // session closes. Keeping the client run active is what lets /rc mirror the
  // next prompt in the same shared conversation. Explicit /rc stop, terminal
  // shutdown, or server expiry settle the run instead.
  private readonly onFinish = () => {};
  private readonly onError = (event: { error: string }) => {
    void this.stop('error', event.error);
  };

  constructor(options: RemoteRunMirrorOptions) {
    this.client = options.client ?? new GatewayClient();
    this.emitter = options.emitter;
    this.init = {
      conversationId: options.conversationId,
      projectLabel: options.projectLabel,
      model: options.model,
      mode: options.mode,
    };
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.onCommand = options.onCommand;
    this.contextWindow = options.contextWindow ?? 32_768;
    this.onCancel = options.onCancel;
  }

  /** Add an accepted terminal/phone prompt to the durable shared transcript.
   * This is intentionally opt-in through /rc and never uploads prior history. */
  recordPrompt(prompt: string): void {
    const query = prompt.trim();
    if (!query) return;
    this.enqueue({
      k: 'query',
      v: { query: text(query, 16_000), model: this.init.model },
    });
  }

  async start(): Promise<RemoteRunMirrorStatus> {
    if (this.runId) return this.status();
    const registered = await this.client.registerClientRun(this.init);
    this.runId = registered.runId;
    this.conversationId = registered.conversationId;
    this.writerToken = registered.writerToken;
    this.controlToken = registered.controlToken;
    this.emitter.on(AgentEventType.STREAM_TEXT, this.onStreamText);
    this.emitter.on(AgentEventType.ROUND_TEXT, this.onRoundText);
    this.emitter.on(AgentEventType.TOOL_CALL, this.onToolCall);
    this.emitter.on(AgentEventType.TOOL_OUTPUT_UPDATE, this.onToolOutput);
    this.emitter.on(AgentEventType.TOOL_RESULT, this.onToolResult);
    this.emitter.on(AgentEventType.TOOL_WAITING_APPROVAL, this.onApproval);
    this.emitter.on(AgentEventType.ROUND_END, this.onRoundEnd);
    this.emitter.on(AgentEventType.USAGE_METADATA, this.onUsage);
    this.emitter.on(AgentEventType.FINISH, this.onFinish);
    this.emitter.on(AgentEventType.ERROR, this.onError);
    this.heartbeat = setInterval(
      () => void this.sendHeartbeat(),
      registered.heartbeatIntervalMs ?? this.heartbeatMs,
    );
    return this.status();
  }

  status(): RemoteRunMirrorStatus {
    return {
      state: this.lastError
        ? 'error'
        : this.stopped
          ? 'stopped'
          : this.runId
            ? 'active'
            : 'starting',
      runId: this.runId,
      conversationId: this.conversationId,
      controlToken: this.controlToken,
      queuedEvents: this.queued.length,
      lastError: this.lastError,
    };
  }

  async stop(
    status: 'done' | 'error' | 'stopped' = 'stopped',
    error?: string,
  ): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.detach();
    await this.flush();
    if (this.runId && this.writerToken) {
      try {
        await this.client.settleClientRun(
          this.runId,
          this.writerToken,
          status,
          error,
        );
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  private detach(): void {
    this.emitter.off(AgentEventType.STREAM_TEXT, this.onStreamText);
    this.emitter.off(AgentEventType.ROUND_TEXT, this.onRoundText);
    this.emitter.off(AgentEventType.TOOL_CALL, this.onToolCall);
    this.emitter.off(AgentEventType.TOOL_OUTPUT_UPDATE, this.onToolOutput);
    this.emitter.off(AgentEventType.TOOL_RESULT, this.onToolResult);
    this.emitter.off(AgentEventType.TOOL_WAITING_APPROVAL, this.onApproval);
    this.emitter.off(AgentEventType.ROUND_END, this.onRoundEnd);
    this.emitter.off(AgentEventType.USAGE_METADATA, this.onUsage);
    this.emitter.off(AgentEventType.FINISH, this.onFinish);
    this.emitter.off(AgentEventType.ERROR, this.onError);
  }

  private enqueue(event: Record<string, unknown> & { k: string }): void {
    if (this.stopped || !this.runId) return;
    this.queued.push({ clientEventId: `cli-${this.nextSeq++}`, event });
    void this.flush();
  }

  /** The native emitter normally sends deltas, but some providers replay the
   * accumulated buffer. Keep the remote transcript truthful in both cases. */
  private streamDelta(value: string, channel: 'text' | 'thought'): string {
    const previous =
      channel === 'text' ? this.streamedText : this.streamedThought;
    const delta = value.startsWith(previous)
      ? value.slice(previous.length)
      : value;
    if (channel === 'text')
      this.streamedText = value.startsWith(previous) ? value : previous + value;
    else
      this.streamedThought = value.startsWith(previous)
        ? value
        : previous + value;
    return delta;
  }

  private async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.queued.length && this.runId && this.writerToken) {
        const batch = this.queued.splice(0, MAX_BATCH_SIZE);
        try {
          await this.client.appendClientRunEvents(
            this.runId,
            this.writerToken,
            batch,
          );
        } catch (err) {
          this.queued.unshift(...batch);
          this.lastError = err instanceof Error ? err.message : String(err);
          break;
        }
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.stopped || !this.runId || !this.writerToken) return;
    try {
      const response = await this.client.heartbeatClientRun(
        this.runId,
        this.writerToken,
      );
      if (response.cancelRequested) {
        this.onCancel?.();
        await this.stop('stopped');
        return;
      }
      if (response.command && this.onCommand) {
        const accepted = await this.onCommand(response.command);
        if (accepted) {
          await this.client.heartbeatClientRun(this.runId, this.writerToken, {
            id: response.command.id,
            leaseId: response.command.leaseId,
          });
        }
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}
