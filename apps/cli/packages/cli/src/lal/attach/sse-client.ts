/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

// Resumable SSE reader for the LAL gateway's run stream
// (`GET /api/agent/runs/{id}/stream` — see
// web/src/app/api/agent/runs/[id]/stream/route.ts). Node has no native
// EventSource, so this parses `text/event-stream` by hand over a
// `fetch()` `ReadableStream`, matching exactly the wire format that route
// emits:
//   - per-event `id: <seq>\n` line (only present on real ledger events —
//     the synthesized `protocol`/`run` preamble frames the route sends on
//     every connect carry no id, by design, since they are re-derived on
//     each attach rather than replayed from the log)
//   - `data: <json>\n\n` frame body, one JSON object per line
//   - `: ping\n\n` heartbeat comments every 15s (ignored)
//   - a terminal `status` event (`done|error|stopped|interrupted`) is always
//     the run's last line
//
// Reconnect uses `Last-Event-ID` (mirrors the browser's native EventSource
// behavior that web/src/app/agent/agent-chat.tsx's `attachChatRun` relies
// on) plus a redundant `?after=` query param, since the route accepts
// either. Reconnecting stops permanently once a terminal status event has
// been seen — there is nothing left to tail.
//
// Rapid token-delta events (`text`/`think`) are buffered and flushed on a
// fixed ~150ms clock (matching the 150ms UI-repaint throttle already used
// elsewhere in the web app, e.g. web/src/app/hive/page.tsx's `liveDirtyRef`
// pattern) so a caller isn't invoked once per token — every other event
// kind flushes the pending batch first, then delivers immediately in its
// own batch, so ordering is always preserved.

export interface AttachEventEnvelope {
  event: Record<string, unknown> & { k: string };
  seq?: number;
}

export type AttachEventBatch = AttachEventEnvelope[];

const DELTA_KINDS = new Set(['text', 'think']);
const TERMINAL_STATUSES = new Set(['done', 'error', 'stopped', 'interrupted']);

export interface ResumableSseOptions {
  /** Extra headers sent on every (re)connect — e.g. bearer + device headers. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Flush clock for buffered text/think deltas. Default 150ms. */
  flushIntervalMs?: number;
  /** Cap on exponential reconnect backoff. Default 10s. */
  maxReconnectDelayMs?: number;
  signal?: AbortSignal;
  /** Called with a batch of one or more events, in stream order. Delta kinds
   * (text/think) may be coalesced into a multi-item batch; every other kind
   * always arrives alone, immediately (after flushing any pending deltas). */
  onBatch: (batch: AttachEventBatch) => void;
  /** Fired before each reconnect attempt (not on the very first connect). */
  onReconnecting?: (info: { attempt: number; delayMs: number }) => void;
  /** A terminal `status` event was observed — no more reconnects will happen. */
  onTerminal?: (status: string, error?: string) => void;
  /** A connect/parse error that will be retried (not fatal). Purely informational. */
  onConnectError?: (err: unknown) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Splits raw SSE text into complete frames (separated by a blank line) plus
 * the unconsumed tail. CRLF is normalized to LF before this is called — see
 * the caller — because the gateway's own frames are LF-only and JSON never
 * contains a literal raw CR/LF inside a string (JSON.stringify escapes
 * control characters), so this normalization can't corrupt event payloads. */
function splitFrames(buf: string): { frames: string[]; tail: string } {
  const frames = buf.split('\n\n');
  const tail = frames.pop() ?? '';
  return { frames, tail };
}

/** Parses one SSE frame into `{seq?, data?}`. Comment lines (`:` prefix,
 * e.g. heartbeats) and any line that isn't `id:`/`data:` are ignored. A
 * frame with no `data:` line (a pure heartbeat) returns `data: undefined`. */
function parseFrame(raw: string): { seq?: number; data?: string } {
  let seq: number | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('id:')) {
      const n = Number(line.slice(3).trim());
      if (Number.isFinite(n)) seq = n;
    } else if (line.startsWith('data:')) {
      const rest = line.slice(5);
      dataLines.push(rest.startsWith(' ') ? rest.slice(1) : rest);
    }
    // comment lines (`:` prefix) and anything else are ignored on purpose.
  }
  if (dataLines.length === 0) return { seq };
  return { seq, data: dataLines.join('\n') };
}

/** Resumable SSE client for one run's attach stream. Construct with a URL
 * builder (called fresh on every connect attempt so it can embed the
 * current resume cursor), call `start()`, and `stop()` to tear down. */
export class ResumableSseClient {
  private lastSeq = 0;
  private stopped = false;
  private terminal = false;
  private pending: AttachEventBatch = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly urlFor: (afterSeq: number) => string,
    private readonly opts: ResumableSseOptions,
  ) {}

  /** Begin (or resume from) `afterSeq` (0 = full replay from the beginning). */
  start(afterSeq = 0): void {
    this.lastSeq = afterSeq;
    this.stopped = false;
    this.terminal = false;
    this.attempt = 0;
    this.flushTimer = setInterval(
      () => this.flush(),
      this.opts.flushIntervalMs ?? 150,
    );
    this.loopPromise = this.loop();
  }

  /** Stop reconnecting and tear down the flush timer. Any buffered deltas
   * are flushed once more so nothing is silently dropped on manual stop. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /** Resolves once the read loop has exited (terminal status, manual stop,
   * or an aborted signal) — useful in tests / callers that want to await
   * full drain rather than relying purely on callbacks. */
  async whenDone(): Promise<void> {
    await this.loopPromise;
  }

  get seq(): number {
    return this.lastSeq;
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    try {
      this.opts.onBatch(batch);
    } catch {
      // A misbehaving renderer must never take down the stream reader.
    }
  }

  private deliverImmediate(envelope: AttachEventEnvelope): void {
    this.flush();
    try {
      this.opts.onBatch([envelope]);
    } catch {
      // ditto
    }
  }

  private handleEvent(envelope: AttachEventEnvelope): void {
    if (typeof envelope.seq === 'number')
      this.lastSeq = Math.max(this.lastSeq, envelope.seq);
    const k = envelope.event.k;
    if (DELTA_KINDS.has(k)) {
      this.pending.push(envelope);
      return;
    }
    this.deliverImmediate(envelope);
    if (k === 'status') {
      const status = String((envelope.event as { v?: unknown }).v ?? '');
      if (TERMINAL_STATUSES.has(status)) {
        this.terminal = true;
        const error = (envelope.event as { error?: string }).error;
        this.opts.onTerminal?.(status, error);
      }
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped && !this.terminal) {
      try {
        await this.connectOnce();
        this.attempt = 0; // a clean read-to-completion resets backoff
      } catch (err) {
        if (this.opts.signal?.aborted) break;
        this.opts.onConnectError?.(err);
      }
      if (this.stopped || this.terminal || this.opts.signal?.aborted) break;
      this.attempt++;
      const delay = Math.min(
        1000 * 2 ** (this.attempt - 1),
        this.opts.maxReconnectDelayMs ?? 10000,
      );
      this.opts.onReconnecting?.({ attempt: this.attempt, delayMs: delay });
      await sleep(delay, this.opts.signal);
    }
    this.stop();
  }

  private async connectOnce(): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      ...(this.opts.headers ?? {}),
    };
    if (this.lastSeq > 0) headers['last-event-id'] = String(this.lastSeq);
    const res = await fetchImpl(this.urlFor(this.lastSeq), {
      headers,
      signal: this.opts.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`attach stream connect failed: HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        if (this.stopped) {
          try {
            await reader.cancel();
          } catch {
            /* already gone */
          }
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        const { frames, tail } = splitFrames(buf);
        buf = tail;
        for (const raw of frames) {
          if (!raw) continue; // stray blank frame (e.g. leading separator)
          const { seq, data } = parseFrame(raw);
          if (data === undefined) continue; // heartbeat / comment-only frame
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue; // malformed frame — skip rather than crash the reader
          }
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            Array.isArray(parsed)
          )
            continue;
          const k = (parsed as { k?: unknown }).k;
          if (typeof k !== 'string') continue;
          this.handleEvent({
            event: parsed as Record<string, unknown> & { k: string },
            seq,
          });
          if (this.terminal) {
            try {
              await reader.cancel();
            } catch {
              /* already gone */
            }
            return;
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already released/cancelled */
      }
    }
  }
}
