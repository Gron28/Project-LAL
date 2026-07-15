/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

// Kind-keyed dispatch table: renders every event kind the LAL gateway's run
// stream can emit (see packages/core/src/lal/protocol.ts) into plain-text
// lines the CLI can print. Mirrors the *decisions* the web client already
// makes for the same wire events — see web/src/app/agent/agent-chat.tsx's
// `attachChatRun` (chat: text/think/model_loading/model_ready/usage/status),
// web/src/lib/deliberate.ts's `DeliberateEvent` union (phase machine), and
// the tool-loop glyph grammar in
// packages/cli/src/ui/components/messages/ToolMessage.tsx (✔/✖/· status
// glyphs) — without duplicating their React/JSX rendering, since this
// module has to stay usable from both an Ink command and a headless
// context (tests, a future non-interactive `lal attach` subcommand).
//
// Compatibility rule (from protocol.ts, restated here because it governs
// this file's one hard invariant): an event kind this table doesn't
// recognize is NOT an error. It renders as a single dim debug line. This
// dispatch table must never throw on an unrecognized `k`, and it must
// never crash the process on a malformed payload shape either — every
// branch reads its payload defensively.
import { isKnownEventKind } from '@qwen-code/qwen-code-core';

export type RenderSeverity = 'info' | 'success' | 'warning' | 'error' | 'dim';

export interface RenderedLine {
  severity: RenderSeverity;
  text: string;
  /** The event kind that produced this line — lets a caller group/collapse
   * (e.g. a "Thinking…" panel toggled by /thinking) without re-parsing text. */
  kind: string;
  /** True for streaming content (text/think) that continues the previous
   * line of the same kind rather than starting a new one. */
  append?: boolean;
}

export interface AttachRenderEvent {
  k: string;
  v?: unknown;
  error?: string;
  [key: string]: unknown;
}

/** Mutable context threaded through rendering for the handful of kinds that
 * need it (currently just the expected protocol version, for a one-time
 * mismatch warning — everything else in this table is a pure function of
 * the event). Kept as an object rather than a closure so a caller can reuse
 * one renderer across an entire attach session cheaply. */
export interface RenderContext {
  expectedProtocolVersion?: number;
  warnedProtocolMismatch?: boolean;
}

function line(
  severity: RenderSeverity,
  text: string,
  kind: string,
  append?: boolean,
): RenderedLine[] {
  return [{ severity, text, kind, ...(append ? { append: true } : {}) }];
}

function truncate(s: string, max = 220): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function fmtArgs(args: unknown): string {
  try {
    return truncate(JSON.stringify(args));
  } catch {
    return String(args);
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function statusGlyph(ok: boolean | undefined): string {
  return ok === undefined ? '·' : ok ? '✔' : '✖';
}

type Handler = (
  event: AttachRenderEvent,
  seq: number | undefined,
  ctx: RenderContext,
) => RenderedLine[];

// One entry per kind in KNOWN_EVENT_KINDS (protocol.ts). Keep this table
// exhaustive on purpose — a missing entry silently falls through to the
// "unknown kind" debug line below, which is a compatibility feature for
// kinds this build predates, not something to rely on for kinds we already
// know about.
const HANDLERS: Record<string, Handler> = {
  protocol: (e, _seq, ctx) => {
    const v = Number(e.v);
    if (
      ctx.expectedProtocolVersion !== undefined &&
      v !== ctx.expectedProtocolVersion &&
      !ctx.warnedProtocolMismatch
    ) {
      ctx.warnedProtocolMismatch = true;
      return line(
        'warning',
        `gateway protocol v${v} (this build expects v${ctx.expectedProtocolVersion}) — unknown kinds will render as debug lines`,
        'protocol',
      );
    }
    return [];
  },
  run: (e) => {
    const v = asRecord(e.v);
    const parts = [
      String(v['kind'] ?? ''),
      String(v['model'] ?? ''),
      `status=${String(v['status'] ?? '?')}`,
    ].filter(Boolean);
    return line('dim', `run · ${parts.join(' · ')}`, 'run');
  },
  turn: () => line('dim', '— new turn —', 'turn'),
  status: (e) => {
    const v = String(e.v ?? '');
    if (v === 'done') return line('success', 'run finished', 'status');
    if (v === 'error')
      return line(
        'error',
        `run failed${e.error ? `: ${e.error}` : ''}`,
        'status',
      );
    if (v === 'stopped') return line('warning', 'run stopped', 'status');
    if (v === 'interrupted')
      return line(
        'warning',
        `run interrupted${e.error ? `: ${e.error}` : ''}`,
        'status',
      );
    return line('info', `run status: ${v}`, 'status');
  },
  approval_needed: (e) => {
    const v = asRecord(e.v);
    return line(
      'warning',
      `approval needed — ${String(v['name'] ?? '?')} ${fmtArgs(v['args'])}`,
      'approval_needed',
    );
  },
  approval_result: (e) => {
    const v = asRecord(e.v);
    if (v['timeout'])
      return line('warning', 'approval timed out — denied', 'approval_result');
    return line(
      v['allow'] ? 'success' : 'warning',
      v['allow'] ? 'approved' : 'denied',
      'approval_result',
    );
  },
  text: (e) => line('info', String(e.v ?? ''), 'text', true),
  think: (e) => line('dim', String(e.v ?? ''), 'think', true),
  tool_request: (e) => {
    const v = asRecord(e.v);
    return line(
      'info',
      `▶ ${String(v['name'] ?? '?')} ${fmtArgs(v['args'])}`,
      'tool_request',
    );
  },
  tool_progress: (e) => {
    const v = asRecord(e.v);
    return line(
      'dim',
      `… ${String(v['name'] ?? '?')} (${String(v['chars'] ?? 0)} chars) ${truncate(String(v['preview'] ?? ''), 80)}`,
      'tool_progress',
    );
  },
  tool_result: (e) => {
    const v = asRecord(e.v);
    const ok = typeof v['ok'] === 'boolean' ? (v['ok'] as boolean) : undefined;
    return line(
      ok === false ? 'error' : 'success',
      `${statusGlyph(ok)} ${String(v['name'] ?? '?')} ${truncate(String(v['output'] ?? ''), 200)}`,
      'tool_result',
    );
  },
  round: () => line('dim', '— round —', 'round'),
  max_rounds: (e) =>
    line('dim', `max rounds: ${String(e.v ?? '')}`, 'max_rounds'),
  act_nudge: () => line('dim', 'nudge: act', 'act_nudge'),
  model_swap: (e) => {
    const v = asRecord(e.v);
    return line(
      'info',
      `model swapped: ${String(v['from'] ?? '(none)')} → ${String(v['to'] ?? '?')}`,
      'model_swap',
    );
  },
  think_recovered: (e) =>
    line(
      'dim',
      `recovered ${String(asRecord(e.v)['count'] ?? 0)} think block(s)`,
      'think_recovered',
    ),
  forced_verify: () => line('dim', 'nudge: forced verify', 'forced_verify'),
  mutation_required_nudge: (e) =>
    line(
      'dim',
      `nudge: mutation required (${String(asRecord(e.v)['count'] ?? 0)})`,
      'mutation_required_nudge',
    ),
  stall_nudge: () => line('dim', 'nudge: stall detected', 'stall_nudge'),
  research_depth_nudge: (e) => {
    const v = asRecord(e.v);
    return line(
      'dim',
      `nudge: research depth (${String(v['count'] ?? 0)}/${String(v['min'] ?? 0)})`,
      'research_depth_nudge',
    );
  },
  usage: (e) => {
    const v = asRecord(e.v);
    const conf = asRecord(v['conf']);
    const confPart =
      typeof conf['avg'] === 'number'
        ? ` · conf ${(Number(conf['avg']) * 100).toFixed(0)}%`
        : '';
    const tps = v['tokPerSec'] != null ? ` · ${v['tokPerSec']} tok/s` : '';
    return line(
      'dim',
      `ctx ${String(v['totalTokens'] ?? 0)}/${String(v['ctx'] ?? 0)}${tps}${confPart}`,
      'usage',
    );
  },
  truncated: () =>
    line(
      'warning',
      'reply truncated by the token cap — continue to resume it',
      'truncated',
    ),
  context_limit: (e) => {
    const v = asRecord(e.v);
    return line(
      'error',
      `context limit reached (~${String(v['estimatedTokens'] ?? '?')} + ${String(v['reserveTokens'] ?? '?')} reserved > ${String(v['ctx'] ?? '?')})`,
      'context_limit',
    );
  },
  context_compacted: (e) =>
    line(
      'dim',
      `older tool output trimmed (${String(asRecord(e.v)['trimmed'] ?? 0)})`,
      'context_compacted',
    ),
  phase: (e) =>
    line('info', `phase: ${String(asRecord(e.v)['name'] ?? '?')}`, 'phase'),
  roles: (e) => {
    const roles = asRecord(e.v)['roles'];
    const names = Array.isArray(roles)
      ? roles.map((r) =>
          r && typeof r === 'object'
            ? String((r as Record<string, unknown>)['name'] ?? '?')
            : String(r),
        )
      : [];
    return line('dim', `roles: ${names.join(', ')}`, 'roles');
  },
  role_progress: (e) => {
    const v = asRecord(e.v);
    return line(
      'dim',
      `${String(v['role'] ?? '?')}: ${String(v['stage'] ?? '?')}`,
      'role_progress',
    );
  },
  debate_turn: (e) => {
    const v = asRecord(e.v);
    return line(
      'info',
      `[round ${String(v['round'] ?? '?')}] ${String(v['role'] ?? '?')}: ${truncate(String(v['text'] ?? ''), 400)}`,
      'debate_turn',
    );
  },
  convergence: (e) => {
    const v = asRecord(e.v);
    const verdict = String(v['verdict'] ?? '?');
    const sev: RenderSeverity =
      verdict === 'converged'
        ? 'success'
        : verdict === 'unresolved'
          ? 'warning'
          : 'info';
    return line(
      sev,
      `convergence (round ${String(v['round'] ?? '?')}): ${verdict}`,
      'convergence',
    );
  },
  artifact: (e) =>
    line(
      'dim',
      `artifact: ${String(asRecord(e.v)['path'] ?? '?')}`,
      'artifact',
    ),
  inner: (e, seq, ctx) => {
    const v = asRecord(e.v);
    const phase = v['phase'] ? `${String(v['phase'])}` : '';
    const role = v['role'] ? `/${String(v['role'])}` : '';
    const inner = v['event'];
    if (
      !inner ||
      typeof inner !== 'object' ||
      typeof (inner as Record<string, unknown>)['k'] !== 'string'
    ) {
      return line(
        'dim',
        `[inner ${phase}${role}] (unrenderable payload)`,
        'inner',
      );
    }
    const rendered = renderEvent(inner as AttachRenderEvent, seq, ctx);
    const prefix = phase || role ? `[${phase}${role}] ` : '';
    return rendered.map((r) => ({
      ...r,
      text: prefix + r.text,
      kind: 'inner',
    }));
  },
  error: (e) =>
    line('error', truncate(String(e.v ?? 'unknown error'), 400), 'error'),
  workflow_routing: () =>
    line('dim', 'hive: routing update', 'workflow_routing'),
  stage_trace: (e) => {
    const v = asRecord(e.v);
    return line(
      'dim',
      `[${String(e['role'] ?? '?')}] ${String(v['kind'] ?? '?')}: ${truncate(String(v['text'] ?? ''), 200)}`,
      'stage_trace',
    );
  },
  workflow_started: (e) =>
    line(
      'info',
      `hive workflow started: ${String(e['workflowId'] ?? '?')}`,
      'workflow_started',
    ),
  workflow_node: (e) => {
    const v = asRecord(e.v);
    return line(
      'info',
      `[${String(e['role'] ?? '?')}] node ${String(e['nodeId'] ?? '?')}: ${String(v['status'] ?? '?')}`,
      'workflow_node',
    );
  },
  workflow_finished: (e) => {
    const v = asRecord(e.v);
    return line(
      String(v['status']) === 'error' ? 'error' : 'success',
      `hive workflow finished: ${String(v['status'] ?? '?')}`,
      'workflow_finished',
    );
  },
  model_loading: (e) => {
    const v = asRecord(e.v);
    return line(
      'info',
      `loading ${String(v['model'] ?? '?')} (ctx ${String(v['ctx'] ?? '?')})…`,
      'model_loading',
    );
  },
  model_ready: (e) => {
    const v = asRecord(e.v);
    return line(
      'success',
      `${String(v['model'] ?? 'model')} ready${v['backend'] ? ` (${String(v['backend'])})` : ''}`,
      'model_ready',
    );
  },
  model: (e) => line('dim', `answered via: ${String(e.v ?? '?')}`, 'model'),
  project: (e) =>
    line(
      'dim',
      `project root: ${String(asRecord(e.v)['root'] ?? '?')}`,
      'project',
    ),
  done: (e) => {
    const v = asRecord(e.v);
    const bits = [
      v['conversationId'] ? `conversation ${String(v['conversationId'])}` : '',
      v['dir'] ? `artifacts in ${String(v['dir'])}` : '',
    ].filter(Boolean);
    return line(
      'success',
      bits.length ? `done — ${bits.join(', ')}` : 'done',
      'done',
    );
  },
  query: (e) => {
    const v = asRecord(e.v);
    return line(
      'dim',
      `query: "${truncate(String(v['query'] ?? ''), 120)}" (${String(v['model'] ?? '?')})`,
      'query',
    );
  },
  transcript: (e) => line('dim', `(heard): ${String(e.v ?? '')}`, 'transcript'),
};

/** Render one event to zero or more display lines. Never throws: an
 * unrecognized kind (or a kind whose handler blows up on a malformed
 * payload) degrades to a single dim debug line instead of crashing the
 * attach session — this is the hard compatibility rule from protocol.ts. */
export function renderEvent(
  event: AttachRenderEvent,
  seq: number | undefined,
  ctx: RenderContext = {},
): RenderedLine[] {
  const handler = HANDLERS[event.k];
  if (!handler) {
    return line(
      'dim',
      `[unrecognized event kind "${event.k}"]${isKnownEventKind(event.k) ? '' : ' (not in protocol.ts either — future/unmirrored kind)'}`,
      event.k,
    );
  }
  try {
    return handler(event, seq, ctx);
  } catch (err) {
    return line(
      'dim',
      `[event "${event.k}" failed to render: ${err instanceof Error ? err.message : String(err)}]`,
      event.k,
    );
  }
}

/** Every kind this table has an explicit handler for — exported mainly for
 * tests asserting the table stays exhaustive against protocol.ts's
 * KNOWN_EVENT_KINDS. */
export const RENDERED_KINDS = new Set(Object.keys(HANDLERS));
