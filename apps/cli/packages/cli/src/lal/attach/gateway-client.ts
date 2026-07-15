/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

// LAL gateway client — resolves the gateway origin + device token, and exposes
// typed fetch helpers for the run-stream attach engine (see
// docs/design/lal-cli-product-plan.md, "Step 3 — run-stream attach engine").
//
// Auth reality (verified 2026-07-14 by reading the gateway route handlers
// directly, not assumed from the product plan): `/api/agent/*` routes
// (runs, chat, deliberate, conversations, ...) have NO bearer-token gate —
// they are reachable exactly like the browser reaches them, because the
// whole app trusts tailnet-only access with no login system. Only
// `/api/lal/*` (this module's `fetchClientSettings`) and `/api/llm/v1/*`
// require `Authorization: Bearer <device token>` (see the gateway's
// web/src/lib/lal-cli.ts `cliAuthorized`). So every helper here sends the
// bearer header + device headers OPPORTUNISTICALLY (forward-compatible with
// a future gate) but never refuses to call `/api/agent/*` just because no
// token is configured.
import { PROTOCOL_VERSION } from '@qwen-code/qwen-code-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Default origin for the gateway when nothing else is configured — the box
 * this fork is developed against runs the Next.js app on :8770 (see
 * HANDOFF/memory notes: "app is port 8770 not 3000"). */
export const DEFAULT_GATEWAY_ORIGIN = 'http://localhost:8770';

export const CLI_CLIENT_VERSION = '0.1.0-lal.17';

export interface GatewayRunMeta {
  id: string;
  kind: 'code' | 'chat' | 'deliberate' | 'hive';
  conversationId: string;
  project?: string;
  model: string;
  mode?: string;
  status: 'running' | 'done' | 'error' | 'stopped' | 'interrupted';
  error?: string;
  truncated?: boolean;
  startedAt: number;
  updatedAt: number;
  seq: number;
}

export interface GatewayRunTraceEvent {
  seq: number;
  ts: number;
  k: string;
  detail: string;
}

export interface GatewayRunTrace {
  reasoning: string;
  output: string;
  events: GatewayRunTraceEvent[];
}

export interface GatewayConversationSummary {
  id: string;
  title?: string;
  ts: number;
  project?: string;
  model?: string;
  mode?: string;
  [key: string]: unknown;
}

export interface ClientRunRegistration {
  runId: string;
  conversationId: string;
  writerToken: string;
  controlToken: string;
  heartbeatIntervalMs?: number;
}

export interface ClientRunInit {
  conversationId?: string;
  projectLabel?: string;
  model: string;
  mode?: string;
}

export interface ClientRunEvent {
  clientEventId: string;
  event: Record<string, unknown> & { k: string };
}

export interface ClientRunCommand {
  id: string;
  type: 'submit';
  text: string;
  leaseId: string;
}

/** Resolve the gateway's origin (scheme://host[:port], no trailing slash).
 * `LAL_GATEWAY_URL` is the escape hatch for anyone not on the default dev
 * port; nothing in this fork currently persists a discovered origin to
 * settings.json (Step 2's "managed connection" importer doesn't exist yet —
 * see the audit note in this module's test file), so falling back to the
 * known dev origin is the pragmatic default rather than a guess. */
export function resolveGatewayOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env['LAL_GATEWAY_URL']?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const pairedHost = readLalFile('client-host');
  if (pairedHost) return pairedHost.replace(/\/+$/, '');
  return DEFAULT_GATEWAY_ORIGIN;
}

/** Resolve the device bearer token, if any is configured. `LAL_API_KEY` is
 * the env var name the gateway's own `/api/lal/client-settings` response
 * tells provider configs to use (`envKey: "LAL_API_KEY"`); `LAL_CLI_TOKEN`
 * is accepted as an alias for anyone who's already set that name up for
 * other tooling. Absence is not an error — see the module header. */
export function resolveGatewayToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    env['LAL_API_KEY']?.trim() ||
    env['LAL_CLI_TOKEN']?.trim() ||
    readLalEnvToken() ||
    undefined
  );
}

/** The Windows installer persists the paired host and token in ~/.lal so a
 * newly opened terminal works without manually exporting environment values.
 * Environment variables remain the explicit override for development and
 * recovery. */
function readLalFile(name: string): string | undefined {
  try {
    const value = fs
      .readFileSync(path.join(os.homedir(), '.lal', name), 'utf8')
      .trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readLalEnvToken(): string | undefined {
  const contents = readLalFile('.env');
  if (!contents) return undefined;
  const line = contents
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('LAL_API_KEY='));
  const token = line?.slice('LAL_API_KEY='.length).trim();
  return token || undefined;
}

let cachedDeviceId: string | undefined;

/** A stable-per-process device id. Not persisted across runs (no on-disk
 * device identity store exists in this fork yet); good enough for the
 * device-registry heuristics the gateway already applies (IP-based fallback
 * grouping) and harmless to regenerate on every launch. */
function deviceId(): string {
  if (!cachedDeviceId) {
    cachedDeviceId = `cli-${os
      .hostname()
      .replace(/[^A-Za-z0-9._:-]/g, '-')
      .slice(0, 40)}-${process.pid}`;
  }
  return cachedDeviceId;
}

export function buildDeviceHeaders(): Record<string, string> {
  return {
    'x-lal-device-id': deviceId(),
    'x-lal-device-name': os.hostname(),
    'x-lal-platform': `${os.platform()}/${os.release()}`,
    'x-lal-client-version': CLI_CLIENT_VERSION,
  };
}

export interface GatewayClientOptions {
  origin?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** Thin typed wrapper over the gateway's `/api/agent/*` and `/api/lal/*`
 * routes. Every method throws `GatewayError` on a non-2xx response except
 * where noted; callers decide whether that's fatal (attach command surfaces
 * it as an error line, it never crashes the process). */
export class GatewayClient {
  readonly origin: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GatewayClientOptions = {}) {
    const env = opts.env ?? process.env;
    this.origin = opts.origin ?? resolveGatewayOrigin(env);
    this.token = opts.token ?? resolveGatewayToken(env);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Bearer + device headers, sent opportunistically on every request (see
   * module header — `/api/agent/*` doesn't require them today). */
  authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...buildDeviceHeaders() };
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    return headers;
  }

  private url(
    pathname: string,
    query?: Record<string, string | number | undefined>,
  ): string {
    const u = new URL(pathname, this.origin);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private async json<T>(
    pathname: string,
    init?: RequestInit,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const res = await this.fetchImpl(this.url(pathname, query), {
      ...init,
      headers: {
        ...this.authHeaders(),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new GatewayError(
        `${init?.method ?? 'GET'} ${pathname} -> HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
    return res.json() as Promise<T>;
  }

  /** `GET /api/lal/client-settings` — bearer-gated. Used opportunistically to
   * confirm the pairing token works and to pick up any forward-compat custom
   * headers; a failure here (401, network) is NOT fatal to attaching, since
   * `/api/agent/*` doesn't need it (see module header). Returns null on any
   * failure instead of throwing, precisely because callers should treat this
   * as "nice to have," never "required." */
  async fetchClientSettings(): Promise<Record<string, unknown> | null> {
    try {
      return await this.json<Record<string, unknown>>(
        '/api/lal/client-settings',
      );
    } catch {
      return null;
    }
  }

  /** `GET /api/agent/runs` — list runs, most recently updated / live first. */
  async listRuns(limit = 50): Promise<GatewayRunMeta[]> {
    return this.json<GatewayRunMeta[]>('/api/agent/runs', undefined, { limit });
  }

  /** `GET /api/agent/runs/{id}` (optionally `?trace=1` for a bounded replay +
   * autopsy diagnosis alongside the meta). */
  async getRun(
    id: string,
    opts: { trace?: boolean } = {},
  ): Promise<
    | GatewayRunMeta
    | { run: GatewayRunMeta; trace: GatewayRunTrace; diagnosis: unknown }
  > {
    return this.json(
      `/api/agent/runs/${encodeURIComponent(id)}`,
      undefined,
      opts.trace ? { trace: 1 } : undefined,
    );
  }

  /** `POST /api/agent/runs/{id}/stop`. */
  async stopRun(id: string): Promise<{
    ok: boolean;
    stopping?: boolean;
    status?: string;
    error?: string;
  }> {
    return this.json(`/api/agent/runs/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    });
  }

  /** `GET /api/agent/conversations?kind=chat|code`. */
  async listConversations(
    kind?: 'chat' | 'code',
  ): Promise<GatewayConversationSummary[]> {
    return this.json<GatewayConversationSummary[]>(
      '/api/agent/conversations',
      undefined,
      kind ? { kind } : undefined,
    );
  }

  /** `POST /api/agent/chat` — starts (or continues) a chat run; returns
   * immediately with `{runId, conversationId}`, the generation continues
   * server-side regardless of what this process does next. */
  async startChat(
    body: Record<string, unknown>,
  ): Promise<{ runId: string; conversationId: string }> {
    return this.json('/api/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** `POST /api/agent/deliberate` — starts a deliberate-research run. */
  async startDeliberate(
    body: Record<string, unknown>,
  ): Promise<{ runId: string; conversationId: string }> {
    return this.json('/api/agent/deliberate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** The URL a client should open an SSE connection against to attach to a
   * run's stream, replaying from `afterSeq` (0 = full replay). */
  streamUrl(runId: string, afterSeq = 0): string {
    return this.url(`/api/agent/runs/${encodeURIComponent(runId)}/stream`, {
      after: afterSeq,
    });
  }

  /** Register a client-owned native terminal run. The host contract is
   * deliberately separate from `/api/agent/*`: the terminal owns execution;
   * the gateway only durably records and relays its observable events. */
  async registerClientRun(init: ClientRunInit): Promise<ClientRunRegistration> {
    const response = await this.json<{
      run: { id: string; conversationId: string };
      ingestToken: string;
      controlToken: string;
      heartbeatIntervalMs?: number;
    }>('/api/lal/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'code', ...init }),
    });
    return {
      runId: response.run.id,
      conversationId: response.run.conversationId,
      writerToken: response.ingestToken,
      controlToken: response.controlToken,
      heartbeatIntervalMs: response.heartbeatIntervalMs,
    };
  }

  async appendClientRunEvents(
    runId: string,
    writerToken: string,
    events: ClientRunEvent[],
  ): Promise<void> {
    await this.json(`/api/lal/runs/${encodeURIComponent(runId)}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lal-run-token': writerToken,
      },
      body: JSON.stringify({ events }),
    });
  }

  async heartbeatClientRun(
    runId: string,
    writerToken: string,
    ackCommand?: { id: string; leaseId: string },
  ): Promise<{ command?: ClientRunCommand }> {
    return this.json(`/api/lal/runs/${encodeURIComponent(runId)}/heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lal-run-token': writerToken,
      },
      body: JSON.stringify(ackCommand ? { ackCommand } : {}),
    });
  }

  async settleClientRun(
    runId: string,
    writerToken: string,
    status: 'done' | 'error' | 'stopped',
    error?: string,
  ): Promise<void> {
    await this.json(`/api/lal/runs/${encodeURIComponent(runId)}/finish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lal-run-token': writerToken,
      },
      body: JSON.stringify({ status, ...(error ? { error } : {}) }),
    });
  }
}

/** The protocol version this build of the CLI was written against — used to
 * log a mismatch warning (never a hard failure; see protocol.ts's
 * compatibility rule: unknown/newer kinds must degrade gracefully, not
 * refuse to attach). */
export const CLI_PROTOCOL_VERSION = PROTOCOL_VERSION;
