// Server-side run manager: an agent run lives HERE, not inside the HTTP request
// that started it. Every run appends its events to an on-disk NDJSON log and any
// number of clients can attach/detach/reattach (replay from a sequence number,
// then tail live) — the OpenHands/opencode pattern. This is what makes "close the
// tab, reopen, see it still running" work, and what makes Stop a real server-side
// operation instead of a client-fetch abort that leaves the loop chewing the GPU.
//
// Live state (abort controller, subscribers, pending approvals) sits on a
// globalThis singleton — the same one-Node-process pattern as lab.ts's __lab_srv.
// Durable state is two files per run under .data/runs/:
//   <id>.json    — RunMeta, rewritten on status change (and throttled for seq)
//   <id>.ndjson  — append-only event log, one {seq, ts, ...event} per line
import fs from "node:fs";
import path from "node:path";
import { newId, setIdleHold, touchServing } from "./lab";

const RUNS_DIR = path.join(process.cwd(), ".data", "runs");
fs.mkdirSync(RUNS_DIR, { recursive: true });

export type RunStatus = "running" | "done" | "error" | "stopped" | "interrupted";
export type RunKind = "code" | "chat" | "deliberate" | "hive";
export type RunMeta = {
  id: string;
  kind: RunKind;
  conversationId: string;
  project?: string;
  model: string;
  mode?: string;
  status: RunStatus;
  error?: string;
  truncated?: boolean; // the final answer hit the token cap — offer Continue
  startedAt: number;
  updatedAt: number;
  seq: number; // last event sequence number written to the log
};

export type RunEvent = Record<string, unknown> & { k: string };

// A compact, human-readable replay for the Library. The full NDJSON ledger stays
// on disk for reconnecting streams; this view bounds text and tool output so
// inspecting an old run cannot become another context-sized payload.
export type RunTraceEvent = { seq: number; ts: number; k: string; detail: string };
export type RunTrace = { reasoning: string; output: string; events: RunTraceEvent[] };

type Line = string; // one serialized NDJSON event line (no trailing newline)
type LiveRun = {
  meta: RunMeta;
  abort: AbortController;
  subscribers: Set<(line: Line) => void>;
  approvals: Map<string, (allow: boolean) => void>;
  lastMetaWrite: number;
};

const g = globalThis as unknown as { __lab_runs?: Map<string, LiveRun>; __lab_runs_swept?: boolean };
if (!g.__lab_runs) g.__lab_runs = new Map();
const live = g.__lab_runs;

// The GPU idle reaper (lab.ts) must never unload the model under a live run.
setIdleHold(() => live.size > 0);

const metaPath = (id: string) => path.join(RUNS_DIR, id + ".json");
const logPath = (id: string) => path.join(RUNS_DIR, id + ".ndjson");

function writeMeta(meta: RunMeta) {
  try { fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta)); } catch {}
}

// Runs marked "running" on disk with no live registry entry can only mean the app
// restarted (or crashed) mid-run — the loop is gone. Mark them honestly instead of
// letting a client ever infer "still running" from a stale file. Also prune runs
// old enough that nobody will replay them.
const PRUNE_AFTER_MS = 30 * 24 * 3600e3;
function sweepOnce() {
  if (g.__lab_runs_swept) return;
  g.__lab_runs_swept = true;
  let files: string[] = [];
  try { files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")); } catch { return; }
  for (const f of files) {
    try {
      const meta: RunMeta = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf8"));
      if (Date.now() - (meta.updatedAt || 0) > PRUNE_AFTER_MS) {
        try { fs.unlinkSync(metaPath(meta.id)); } catch {}
        try { fs.unlinkSync(logPath(meta.id)); } catch {}
        continue;
      }
      if (meta.status === "running" && !live.has(meta.id)) {
        meta.status = "interrupted";
        meta.error = "the app restarted while this run was in progress";
        meta.updatedAt = Date.now();
        // meta.seq persists throttled while a run is live, so after a crash it can
        // lag the log — re-derive from the log tail so the interrupted event's seq
        // can't collide with one already written.
        meta.seq = Math.max(meta.seq, lastSeqInLog(meta.id));
        appendLog(meta, { k: "status", v: "interrupted" });
        writeMeta(meta);
      }
    } catch {}
  }
}

function lastSeqInLog(id: string): number {
  try {
    const raw = fs.readFileSync(logPath(id), "utf8");
    const nl = raw.lastIndexOf("\n", raw.length - 2);
    const line = raw.slice(nl + 1).trim();
    return line ? ((JSON.parse(line) as { seq?: number }).seq ?? 0) : 0;
  } catch { return 0; }
}

function appendLog(meta: RunMeta, e: RunEvent): Line {
  meta.seq++;
  const line = JSON.stringify({ seq: meta.seq, ts: Date.now(), ...e });
  try { fs.appendFileSync(logPath(meta.id), line + "\n"); } catch {}
  return line;
}

export type EmitFn = (e: RunEvent) => void;

export function startRun(
  init: { kind: RunKind; conversationId: string; project?: string; model: string; mode?: string },
  work: (emit: EmitFn, signal: AbortSignal) => Promise<void>,
): RunMeta {
  sweepOnce();
  const meta: RunMeta = {
    id: "run-" + newId(),
    kind: init.kind,
    conversationId: init.conversationId,
    ...(init.project ? { project: init.project } : {}),
    model: init.model,
    ...(init.mode ? { mode: init.mode } : {}),
    status: "running",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    seq: 0,
  };
  const lr: LiveRun = { meta, abort: new AbortController(), subscribers: new Set(), approvals: new Map(), lastMetaWrite: 0 };
  live.set(meta.id, lr);
  writeMeta(meta);

  const emit: EmitFn = (e) => {
    touchServing(); // events only flow while a model is working — keep the idle clock honest
    if (e.k === "truncated") meta.truncated = true; // persisted on settle for cross-device Continue
    const line = appendLog(meta, e);
    meta.updatedAt = Date.now();
    // Token-level events arrive tens of times per second — rewriting the meta JSON
    // for each would be pure churn. Status changes always persist immediately
    // (settle() below writes directly); here a light throttle keeps the on-disk
    // seq close enough for reattach math without the per-token write.
    if (meta.updatedAt - lr.lastMetaWrite > 2000) { lr.lastMetaWrite = meta.updatedAt; writeMeta(meta); }
    for (const cb of lr.subscribers) { try { cb(line); } catch {} }
  };

  const settle = (status: RunStatus, error?: string) => {
    meta.status = status;
    if (error) meta.error = error.slice(0, 2000);
    meta.updatedAt = Date.now();
    // deny anything still waiting so no approval promise leaks past the run
    for (const [id, resolve] of lr.approvals) { try { resolve(false); } catch {} lr.approvals.delete(id); }
    emit({ k: "status", v: status, ...(error ? { error: meta.error } : {}) });
    writeMeta(meta);
    live.delete(meta.id);
  };

  // Detached from any request: the promise settles on its own schedule regardless
  // of who is (or isn't) watching.
  work(emit, lr.abort.signal)
    .then(() => settle(lr.abort.signal.aborted ? "stopped" : "done"))
    .catch((e) => {
      if (lr.abort.signal.aborted) settle("stopped");
      else settle("error", (e as Error).message || String(e));
    });

  return meta;
}

export function stopRun(id: string): boolean {
  const lr = live.get(id);
  if (!lr) return false;
  // resolve pending approvals as denied first — a loop parked on an approval
  // promise can't observe the abort signal until that promise settles
  for (const [cid, resolve] of lr.approvals) { try { resolve(false); } catch {} lr.approvals.delete(cid); }
  lr.abort.abort();
  return true;
}

// Emergency brake for the UI. This aborts every live controller owned by this
// server process, including code, chat, and deliberation runs. Individual loops
// observe the same signal before the next model/tool step; pending approvals are
// also denied by stopRun so nothing remains parked in memory waiting for a click.
export function stopAllRuns(): string[] {
  const ids = [...live.keys()];
  for (const id of ids) stopRun(id);
  return ids;
}

export function getRun(id: string): RunMeta | null {
  const lr = live.get(id);
  if (lr) return lr.meta;
  sweepOnce();
  try { return JSON.parse(fs.readFileSync(metaPath(id), "utf8")); } catch { return null; }
}

export function isRunLive(id: string): boolean {
  return live.has(id);
}

export function anyRunLive(): boolean {
  return live.size > 0;
}

export function listRuns(limit = 50): RunMeta[] {
  sweepOnce();
  const out = new Map<string, RunMeta>();
  for (const lr of live.values()) out.set(lr.meta.id, lr.meta);
  let files: string[] = [];
  try { files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")); } catch {}
  for (const f of files) {
    const id = f.slice(0, -5);
    if (out.has(id)) continue;
    try { out.set(id, JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf8"))); } catch {}
  }
  return [...out.values()].sort((a, b) =>
    (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) || b.updatedAt - a.updatedAt,
  ).slice(0, limit);
}

function appendTraceText(previous: string, next: string, max = 16000): string {
  const joined = previous + next;
  return joined.length <= max ? joined : "[earlier output omitted]\n" + joined.slice(-max);
}

function traceDetail(value: unknown): string {
  let text = "";
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value) ?? String(value); } catch { text = String(value); }
  }
  return text.length <= 1600 ? text : text.slice(0, 1600) + "\n[detail truncated]";
}

// This is intentionally a read-only summary. It makes completed and interrupted
// agent work inspectable without exposing a live stream connection or replaying
// every token-level event into the Library UI.
export function getRunTrace(id: string): RunTrace | null {
  if (!getRun(id)) return null;
  const trace: RunTrace = { reasoning: "", output: "", events: [] };
  let raw = "";
  try { raw = fs.readFileSync(logPath(id), "utf8"); } catch { return trace; }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const k = typeof event.k === "string" ? event.k : "unknown";
    if (k === "tool_progress") continue; // transient decode progress — superseded by its tool_request
    if (k === "think") {
      trace.reasoning = appendTraceText(trace.reasoning, traceDetail(event.v));
      continue;
    }
    if (k === "text") {
      trace.output = appendTraceText(trace.output, traceDetail(event.v));
      continue;
    }
    if (trace.events.length < 300) {
      trace.events.push({
        seq: typeof event.seq === "number" ? event.seq : 0,
        ts: typeof event.ts === "number" ? event.ts : 0,
        k,
        detail: traceDetail(event.v),
      });
    }
  }
  return trace;
}

// Terminal run records are Library resources. Removing one deletes only its
// metadata/event ledger; conversations, workspace files, models, and training
// artifacts remain independently owned resources.
export function deleteRun(id: string): { ok: boolean; error?: string } {
  if (live.has(id)) return { ok: false, error: "run is still active — stop it first" };
  const meta = getRun(id);
  if (!meta) return { ok: false, error: "run not found" };
  let removed = false;
  try { fs.unlinkSync(metaPath(id)); removed = true; } catch {}
  try { fs.unlinkSync(logPath(id)); removed = true; } catch {}
  return removed ? { ok: true } : { ok: false, error: "run not found" };
}

// Bulk cleanup for the Library's "delete all" — removes every TERMINAL run's
// meta + ledger in one pass. Live runs are untouched (stop them first); the
// count of skipped-because-live runs is reported so the UI can say so.
export function deleteAllRuns(): { deleted: number; skippedLive: number } {
  let deleted = 0;
  let files: string[] = [];
  try { files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")); } catch {}
  for (const f of files) {
    const id = f.slice(0, -5);
    if (live.has(id)) continue;
    try { fs.unlinkSync(metaPath(id)); deleted++; } catch {}
    try { fs.unlinkSync(logPath(id)); } catch {}
  }
  return { deleted, skippedLive: live.size };
}

// Replay-then-tail with no gap and no duplicates: subscribe FIRST (buffering live
// lines that arrive while we read the file), then stream the file, then flush the
// buffer minus anything the file already contained. Returns an unsubscribe fn.
export function openRunStream(id: string, afterSeq: number, onLine: (line: Line) => void): { close: () => void } {
  const lr = live.get(id);
  const buffered: Line[] = [];
  let replaying = true;
  const sub = (line: Line) => { if (replaying) buffered.push(line); else onLine(line); };
  lr?.subscribers.add(sub);

  let lastSeq = afterSeq;
  try {
    const raw = fs.readFileSync(logPath(id), "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let seq = -1;
      try { seq = (JSON.parse(line) as { seq?: number }).seq ?? -1; } catch { continue; }
      if (seq <= afterSeq) continue;
      lastSeq = Math.max(lastSeq, seq);
      onLine(line);
    }
  } catch { /* no log yet — nothing to replay */ }

  replaying = false;
  for (const line of buffered) {
    try { if (((JSON.parse(line) as { seq?: number }).seq ?? -1) <= lastSeq) continue; } catch { continue; }
    onLine(line);
  }
  buffered.length = 0;

  return { close: () => { lr?.subscribers.delete(sub); } };
}

// ---- approvals, keyed per run ----
// approval_needed goes into the event log like any other event, so a client that
// reattaches mid-wait still sees the pending request; the resolution is logged too
// (approval_result) so replay can tell settled from still-pending. A client
// disconnect no longer denies anything — only an explicit answer, the caller's
// timeout, or the run ending does.
export function requestApproval(
  runId: string,
  emit: EmitFn,
  call: { id: string; name: string; args: Record<string, unknown> },
  timeoutMs = 10 * 60 * 1000,
): Promise<boolean> {
  const lr = live.get(runId);
  if (!lr) return Promise.resolve(false);
  emit({ k: "approval_needed", v: call });
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { lr.approvals.delete(call.id); emit({ k: "approval_result", v: { id: call.id, allow: false, timeout: true } }); resolve(false); }, timeoutMs);
    lr.approvals.set(call.id, (allow) => {
      clearTimeout(timer);
      lr.approvals.delete(call.id);
      emit({ k: "approval_result", v: { id: call.id, allow } });
      resolve(allow);
    });
  });
}

// Answer a pending approval by tool-call id. The client only knows the call id
// (that's what the approval banner carries), so search the live runs for it.
export function resolveApproval(callId: string, allow: boolean): boolean {
  for (const lr of live.values()) {
    const r = lr.approvals.get(callId);
    if (r) { r(allow); return true; }
  }
  return false;
}
