/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

// `/attach` — the run-stream attach engine's demonstrable entry point (see
// docs/design/lal-cli-product-plan.md, "Step 3 — run-stream attach
// engine"). Attaches this terminal to a LIVE server-side run (chat, code,
// deliberate, or hive) running on the gateway (`main-pc`) and renders its
// event stream, the same stream a phone or the web UI would see for the
// same run — "Cross-device session continuity" is what makes this useful:
// closing this terminal never kills the run, and any device can pick the
// stream back up from where it left off.
//
// This is intentionally a NEW command name (not a rename of `/resume`,
// which is this fork's upstream command for the CLI's own local session
// history/persistence — an unrelated, client-private concept from the
// server-side "runs" this command attaches to).
import type {
  CommandContext,
  MessageActionReturn,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import {
  GatewayClient,
  GatewayError,
  CLI_PROTOCOL_VERSION,
  type GatewayRunMeta,
} from '../../lal/attach/gateway-client.js';
import {
  ResumableSseClient,
  type AttachEventBatch,
} from '../../lal/attach/sse-client.js';
import {
  renderEvent,
  type AttachRenderEvent,
  type RenderContext,
  type RenderedLine,
} from '../../lal/attach/renderer.js';
import { findLiveRun } from '../../lal/attach/reattach.js';

// A single-process "current attach" slot, mirroring the established pattern
// for other long-lived interactive sessions in this fork (e.g. arenaCommand
// keeps its manager on `config.getArenaManager()`). This command's session
// isn't config-scoped state other code needs to reach, so a module-level
// slot is simpler than adding a new Config accessor for one consumer.
let activeSession: { runId: string; sse: ResumableSseClient } | null = null;

// Plain 'info'/'warning'/'error'/'success' literals, not the `MessageType`
// enum — `HistoryItemInfo`/`HistoryItemWarning`/etc.'s `type` field is typed
// as the exact string literal, and a `MessageType` enum member (even though
// its runtime value is that same string) is a nominally distinct type that
// doesn't satisfy it directly.
type HistoryMessageType = 'info' | 'warning' | 'error' | 'success';

function severityToMessageType(
  severity: RenderedLine['severity'],
): HistoryMessageType {
  switch (severity) {
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'info';
  }
}

function relativeAge(ms: number): string {
  const deltaS = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (deltaS < 60) return `${deltaS}s ago`;
  if (deltaS < 3600) return `${Math.round(deltaS / 60)}m ago`;
  if (deltaS < 86400) return `${Math.round(deltaS / 3600)}h ago`;
  return `${Math.round(deltaS / 86400)}d ago`;
}

function formatRunRow(run: GatewayRunMeta): string {
  const bits = [
    run.id,
    run.kind,
    run.status,
    run.model,
    relativeAge(run.updatedAt),
  ];
  if (run.project) bits.push(run.project);
  return bits.join('  ·  ');
}

async function listRunsMessage(
  client: GatewayClient,
  limit: number,
): Promise<MessageActionReturn> {
  try {
    const runs = await client.listRuns(limit);
    if (runs.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'No runs on the gateway yet.',
      };
    }
    const lines = runs.map(formatRunRow);
    return {
      type: 'message',
      messageType: 'info',
      content: [
        `Runs on ${client.origin} (id · kind · status · model · age):`,
        ...lines,
        '',
        'Attach with /attach <id>.',
      ].join('\n'),
    };
  } catch (err) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Could not reach the gateway at ${client.origin}: ${errMsg(err)}`,
    };
  }
}

function errMsg(err: unknown): string {
  if (err instanceof GatewayError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Kicks off a background attach session: connects to the run's SSE stream,
 * renders every event into the interactive history, and resolves only when
 * the stream ends (terminal status, manual stop, or a fatal connect
 * failure). Returns immediately in practice — callers don't await this,
 * matching arenaCommand's fire-and-forget pattern so the Ink UI stays
 * responsive while events arrive over time. */
function attachToRun(
  context: CommandContext,
  client: GatewayClient,
  runId: string,
): void {
  activeSession?.sse.stop();
  activeSession = null;

  const ui = context.ui;
  const renderCtx: RenderContext = {
    expectedProtocolVersion: CLI_PROTOCOL_VERSION,
  };
  let textBuf = '';
  let thinkBuf = '';

  const paintPending = () => {
    if (!textBuf && !thinkBuf) {
      ui.setPendingItem(null);
      return;
    }
    const parts: string[] = [];
    if (thinkBuf) parts.push(`(thinking) ${thinkBuf}`);
    if (textBuf) parts.push(textBuf);
    ui.setPendingItem({ type: 'info', text: parts.join('\n\n') });
  };

  const flushDeltas = () => {
    if (textBuf) {
      ui.addItem({ type: 'info', text: textBuf }, Date.now());
      textBuf = '';
    }
    if (thinkBuf) {
      ui.addItem({ type: 'info', text: `(thinking) ${thinkBuf}` }, Date.now());
      thinkBuf = '';
    }
    ui.setPendingItem(null);
  };

  const onBatch = (batch: AttachEventBatch) => {
    for (const { event, seq } of batch) {
      const rendered = renderEvent(event as AttachRenderEvent, seq, renderCtx);
      for (const r of rendered) {
        if (r.kind === 'text' && r.append) {
          textBuf += r.text;
          continue;
        }
        if (r.kind === 'think' && r.append) {
          thinkBuf += r.text;
          continue;
        }
        flushDeltas();
        if (!r.text) continue;
        ui.addItem(
          { type: severityToMessageType(r.severity), text: r.text },
          Date.now(),
        );
      }
    }
    paintPending();
  };

  const sse = new ResumableSseClient(
    (afterSeq) => client.streamUrl(runId, afterSeq),
    {
      headers: client.authHeaders(),
      onBatch,
      onReconnecting: (info) => {
        ui.addItem(
          {
            type: 'warning',
            text: `attach stream dropped — reconnecting (attempt ${info.attempt}, in ${Math.round(info.delayMs / 1000)}s)…`,
          },
          Date.now(),
        );
      },
      onTerminal: (status) => {
        flushDeltas();
        if (activeSession?.runId === runId) activeSession = null;
        ui.addItem(
          { type: 'info', text: `[attach ${runId} ended: ${status}]` },
          Date.now(),
        );
      },
      onConnectError: (err) => {
        ui.addItem(
          { type: 'error', text: `attach connect error: ${errMsg(err)}` },
          Date.now(),
        );
      },
    },
  );

  activeSession = { runId, sse };
  ui.addItem({ type: 'info', text: `Attaching to run ${runId}…` }, Date.now());
  sse.start(0);
}

function parseArgs(raw: string): {
  sub: 'list' | 'stop' | 'attach';
  arg: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { sub: 'attach', arg: '' };
  const [head, ...rest] = trimmed.split(/\s+/);
  const lower = head.toLowerCase();
  if (lower === 'list' || lower === 'ls')
    return { sub: 'list', arg: rest.join(' ') };
  if (lower === 'stop' || lower === 'detach')
    return { sub: 'stop', arg: rest.join(' ') };
  return { sub: 'attach', arg: trimmed };
}

export const attachCommand: SlashCommand = {
  name: 'attach',
  altNames: ['lal-attach'],
  get description() {
    return 'Attach to a live LAL gateway run (chat/code/deliberate/hive) and stream it here';
  },
  kind: CommandKind.BUILT_IN,
  argumentHint: '[<runId> | list | stop]',
  supportedModes: ['interactive'] as const,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<void | SlashCommandActionReturn> => {
    const executionMode = context.executionMode ?? 'interactive';
    if (executionMode !== 'interactive') {
      return {
        type: 'message',
        messageType: 'error',
        content: '/attach is only available in interactive mode.',
      };
    }

    const client = new GatewayClient();
    const { sub, arg } = parseArgs(args);

    if (sub === 'stop') {
      if (!activeSession) {
        return {
          type: 'message',
          messageType: 'info',
          content: 'No active attach session.',
        };
      }
      const stopping = activeSession;
      activeSession = null;
      stopping.sse.stop();
      return {
        type: 'message',
        messageType: 'info',
        content: `Detached from run ${stopping.runId} (the run itself keeps going server-side — this only stops streaming it here).`,
      };
    }

    if (sub === 'list') {
      return listRunsMessage(client, 20);
    }

    // `/attach <runId>` — attach directly to a specific run.
    if (arg) {
      attachToRun(context, client, arg);
      return;
    }

    // `/attach` with no argument — the cross-device auto-attach behavior:
    // find the most recently updated live run and follow it. Falls back to
    // a run list if nothing is currently live, since there's nothing to
    // "reattach" to.
    try {
      const live = await findLiveRun(client);
      if (!live) {
        const listing = await listRunsMessage(client, 10);
        return {
          type: 'message',
          messageType: 'info',
          content: `No live runs to attach to.\n\n${listing.content}`,
        };
      }
      attachToRun(context, client, live.id);
      return;
    } catch (err) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Could not reach the gateway at ${client.origin}: ${errMsg(err)}`,
      };
    }
  },
};
