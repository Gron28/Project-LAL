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
import crypto from "node:crypto";
import { newId, saveConvo, setIdleHold, touchServing } from "./lab";
import { isKnownEventKind } from "./protocol";
import { runLedgerEvictionPlan } from "./retention";

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
  /** Server work owns inference/process lifetime; client work is an authenticated
   * remote terminal session whose events are only relayed and persisted here. */
  executionLocation?: "server" | "client";
  ownerDeviceId?: string;
  lastHeartbeatAt?: number;
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

type ClientLiveRun = { meta: RunMeta; subscribers: Set<(line: Line) => void> };
type ClientCommand = { id: string; type: "submit"; text: string; requestedByDeviceId: string; createdAt: number; leaseId?: string; leaseExpiresAt?: number };
type ClientRunCapability = { version: 1; ownerDeviceId: string; tokenHash: string; controlTokenHash: string; lastHeartbeatAt: number; cancelRequested?: boolean; commands?: ClientCommand[] };
export type ClientRunInit = { kind: RunKind; conversationId?: string; projectLabel?: string; model?: string; mode?: string };
export type ClientEventInput = { clientEventId: string; event: RunEvent };
export type ClientEventReceipt = { clientEventId: string; seq: number };
export type ClientRunAccess = { ok: true; meta: RunMeta } | { ok: false; error: string };

const g = globalThis as unknown as { __lab_runs?: Map<string, LiveRun>; __lab_client_runs?: Map<string, ClientLiveRun>; __lab_runs_swept?: boolean };
if (!g.__lab_runs) g.__lab_runs = new Map();
if (!g.__lab_client_runs) g.__lab_client_runs = new Map();
const live = g.__lab_runs;
const clientLive = g.__lab_client_runs;

// The GPU idle reaper (lab.ts) must never unload the model under a live run.
setIdleHold(() => live.size > 0);

const metaPath = (id: string) => path.join(RUNS_DIR, id + ".json");
const logPath = (id: string) => path.join(RUNS_DIR, id + ".ndjson");
const capabilityPath = (id: string) => path.join(RUNS_DIR, id + ".client.json");
const isMetaFile = (file: string) => file.endsWith(".json") && !file.endsWith(".client.json");
// The terminal heartbeats every 30 seconds.  Two missed heartbeats plus a
// small margin clears a closed/crashed terminal promptly without treating one
// transient network delay as a stopped session.
const CLIENT_RUN_STALE_MS = 75 * 1000;
const MAX_CLIENT_EVENTS_PER_BATCH = 32;
const MAX_CLIENT_EVENT_BYTES = 16 * 1024;
const SERVER_ENVELOPE_KINDS = new Set(["protocol", "run", "status", "approval_needed", "approval_result"]);

function writeMeta(meta: RunMeta) {
  try { fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta)); } catch {}
}

function writeCapability(id: string, value: ClientRunCapability) {
  try { fs.writeFileSync(capabilityPath(id), JSON.stringify(value), { mode: 0o600 }); } catch {}
}
function readCapability(id: string): ClientRunCapability | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(capabilityPath(id), "utf8")) as Partial<ClientRunCapability>;
    return parsed.version === 1 && typeof parsed.ownerDeviceId === "string" && typeof parsed.tokenHash === "string" && typeof parsed.controlTokenHash === "string" && typeof parsed.lastHeartbeatAt === "number"
      ? parsed as ClientRunCapability : null;
  } catch { return null; }
}
function tokenHash(token: string) { return crypto.createHash("sha256").update(token).digest("hex"); }
function equalHash(left: string, right: string) {
  const a = Buffer.from(left, "hex"), b = Buffer.from(right, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cleanClientText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}
function clientLiveRun(meta: RunMeta): ClientLiveRun {
  let entry = clientLive.get(meta.id);
  if (!entry) { entry = { meta, subscribers: new Set() }; clientLive.set(meta.id, entry); }
  else entry.meta = meta;
  return entry;
}
function notifyClientRun(meta: RunMeta, line: Line) {
  for (const cb of clientLive.get(meta.id)?.subscribers || []) { try { cb(line); } catch {} }
}
function clientEventIsSafe(input: ClientEventInput): string | null {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.clientEventId || "")) return "invalid clientEventId";
  if (!input.event || typeof input.event !== "object" || typeof input.event.k !== "string") return "event must contain a string k";
  if (!isKnownEventKind(input.event.k) || SERVER_ENVELOPE_KINDS.has(input.event.k)) return "event kind is not client-ingestable";
  let encoded = "";
  try { encoded = JSON.stringify(input.event); } catch { return "event is not JSON serializable"; }
  if (encoded.length > MAX_CLIENT_EVENT_BYTES) return "event is too large";
  return null;
}

// Runs marked "running" on disk with no live registry entry can only mean the app
// restarted (or crashed) mid-run — the loop is gone. Mark them honestly instead of
// letting a client ever infer "still running" from a stale file. Also prune runs
// old enough that nobody will replay them.
function sweepOnce() {
  if (g.__lab_runs_swept) return;
  g.__lab_runs_swept = true;
  let files: string[] = [];
  try { files = fs.readdirSync(RUNS_DIR).filter(isMetaFile); } catch { return; }
  for (const f of files) {
    try {
      const meta: RunMeta = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf8"));
      if (meta.executionLocation === "client") {
        if (meta.status === "running") sweepStaleClientRun(meta);
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
  pruneRunLedgers();
}

function sweepStaleClientRun(meta: RunMeta): void {
  const cap = readCapability(meta.id);
  const last = cap?.lastHeartbeatAt ?? meta.lastHeartbeatAt ?? meta.updatedAt;
  if (Date.now() - last < CLIENT_RUN_STALE_MS) return;
  meta.status = "interrupted";
  meta.error = "the client stopped reporting; local process state is unknown";
  meta.updatedAt = Date.now();
  meta.seq = Math.max(meta.seq, lastSeqInLog(meta.id));
  const line = appendLog(meta, { k: "status", v: "interrupted", error: meta.error });
  writeMeta(meta);
  notifyClientRun(meta, line);
  clientLive.delete(meta.id);
}

function sweepClientRuns() {
  let files: string[] = [];
  try { files = fs.readdirSync(RUNS_DIR).filter(isMetaFile); } catch { return; }
  for (const f of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf8")) as RunMeta;
      if (meta.executionLocation === "client" && meta.status === "running") sweepStaleClientRun(meta);
    } catch {}
  }
}

function pruneRunLedgers() {
  let files: string[] = [];
  try { files = fs.readdirSync(RUNS_DIR).filter(isMetaFile); } catch { return; }
  const entries: Array<{ id: string; status: string; updatedAt: number; bytes: number }> = [];
  for (const f of files) {
    try {
      const meta: RunMeta = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf8"));
      let bytes = 0;
      try { bytes += fs.statSync(metaPath(meta.id)).size; } catch {}
      try { bytes += fs.statSync(logPath(meta.id)).size; } catch {}
      entries.push({ id: meta.id, status: meta.status, updatedAt: meta.updatedAt || 0, bytes });
    } catch {}
  }
  for (const entry of runLedgerEvictionPlan(entries).evict) {
    try { fs.unlinkSync(metaPath(entry.id)); } catch {}
    try { fs.unlinkSync(logPath(entry.id)); } catch {}
    try { fs.unlinkSync(capabilityPath(entry.id)); } catch {}
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

/** Register a terminal session that executes on a paired device. The server
 * generates both the durable run id and a per-run write capability; callers may
 * display project labels but never provide server filesystem paths. */
export function createClientRun(init: ClientRunInit, ownerDeviceId: string): { meta: RunMeta; ingestToken: string; controlToken: string } {
  sweepOnce(); sweepClientRuns();
  const kind: RunKind = ["code", "chat", "deliberate", "hive"].includes(init.kind) ? init.kind : "code";
  const now = Date.now();
  const id = "run-" + newId();
  const meta: RunMeta = {
    id, kind,
    conversationId: cleanClientText(init.conversationId, 120) || `code-${newId()}`,
    ...(cleanClientText(init.projectLabel, 120) ? { project: cleanClientText(init.projectLabel, 120) } : {}),
    model: cleanClientText(init.model, 120) || "client-local",
    ...(cleanClientText(init.mode, 60) ? { mode: cleanClientText(init.mode, 60) } : {}),
    status: "running", startedAt: now, updatedAt: now, seq: 0,
    executionLocation: "client", ownerDeviceId, lastHeartbeatAt: now,
  };
  const ingestToken = crypto.randomBytes(32).toString("base64url");
  const controlToken = crypto.randomBytes(32).toString("base64url");
  saveConvo({ id: meta.conversationId, title: "Terminal-linked session", messages: [], model: meta.model, mode: meta.mode, ...(meta.project ? { project: meta.project } : {}), ts: now });
  writeMeta(meta);
  writeCapability(id, { version: 1, ownerDeviceId, tokenHash: tokenHash(ingestToken), controlTokenHash: tokenHash(controlToken), lastHeartbeatAt: now, commands: [] });
  clientLiveRun(meta);
  return { meta, ingestToken, controlToken };
}

/** Validate capability/device ownership before routes accept client-originated work. */
export function accessClientRun(id: string, ownerDeviceId: string, ingestToken: string): ClientRunAccess {
  sweepOnce(); sweepClientRuns();
  const meta = getRun(id);
  if (!meta || meta.executionLocation !== "client") return { ok: false, error: "client run not found" };
  const cap = readCapability(id);
  if (!cap || cap.ownerDeviceId !== ownerDeviceId || meta.ownerDeviceId !== ownerDeviceId) return { ok: false, error: "run does not belong to this device" };
  if (!ingestToken || !equalHash(cap.tokenHash, tokenHash(ingestToken))) return { ok: false, error: "invalid run capability" };
  return { ok: true, meta };
}

function priorClientReceipt(id: string, clientEventId: string): number | null {
  try {
    for (const line of fs.readFileSync(logPath(id), "utf8").split("\n")) {
      if (!line) continue;
      const parsed = JSON.parse(line) as { clientEventId?: unknown; seq?: unknown };
      if (parsed.clientEventId === clientEventId && typeof parsed.seq === "number") return parsed.seq;
    }
  } catch {}
  return null;
}

export function appendClientEvents(meta: RunMeta, events: ClientEventInput[]): { ok: true; accepted: ClientEventReceipt[]; lastSeq: number } | { ok: false; error: string } {
  if (meta.status !== "running") return { ok: false, error: `run is ${meta.status}` };
  if (!Array.isArray(events) || events.length < 1 || events.length > MAX_CLIENT_EVENTS_PER_BATCH) return { ok: false, error: `events must contain 1-${MAX_CLIENT_EVENTS_PER_BATCH} items` };
  for (const input of events) { const error = clientEventIsSafe(input); if (error) return { ok: false, error }; }
  const accepted: ClientEventReceipt[] = [];
  for (const input of events) {
    const prior = priorClientReceipt(meta.id, input.clientEventId);
    if (prior !== null) { accepted.push({ clientEventId: input.clientEventId, seq: prior }); continue; }
    const line = appendLog(meta, { ...input.event, clientEventId: input.clientEventId });
    accepted.push({ clientEventId: input.clientEventId, seq: meta.seq });
    notifyClientRun(meta, line);
  }
  meta.updatedAt = Date.now();
  writeMeta(meta);
  return { ok: true, accepted, lastSeq: meta.seq };
}

/**
 * Record a host-observed lifecycle event beside a terminal-owned run.
 *
 * The terminal remains the only writer for its text and tool activity. The
 * host owns model loading, GPU queuing, and backend failures, so those facts
 * are appended here instead of being guessed by the CLI. One paired device has
 * one practical active terminal run today; if that changes this lookup must be
 * replaced with an explicit per-request run id, not broadened silently.
 */
export function appendHostObservationForClientDevice(ownerDeviceId: string | null, event: RunEvent): void {
  if (!ownerDeviceId || !isKnownEventKind(event.k) || SERVER_ENVELOPE_KINDS.has(event.k)) return;
  sweepOnce(); sweepClientRuns();
  let candidates: RunMeta[] = [];
  try {
    candidates = fs.readdirSync(RUNS_DIR).filter(isMetaFile).flatMap((file) => {
      try { return [JSON.parse(fs.readFileSync(path.join(RUNS_DIR, file), "utf8")) as RunMeta]; } catch { return []; }
    }).filter((meta) => meta.executionLocation === "client" && meta.status === "running" && meta.ownerDeviceId === ownerDeviceId);
  } catch { return; }
  const meta = candidates.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!meta) return;
  const line = appendLog(meta, event);
  meta.updatedAt = Date.now();
  writeMeta(meta);
  notifyClientRun(meta, line);
}

export function heartbeatClientRun(meta: RunMeta, ack?: { id?: unknown; leaseId?: unknown }): { cancelRequested: boolean; command?: { id: string; type: "submit"; text: string; leaseId: string } } {
  const now = Date.now();
  meta.lastHeartbeatAt = now; meta.updatedAt = now;
  const cap = readCapability(meta.id);
  let command: { id: string; type: "submit"; text: string; leaseId: string } | undefined;
  if (cap) {
    cap.lastHeartbeatAt = now;
    const commands = cap.commands || [];
    // The CLI only acknowledges a command while holding its lease. An expired
    // lease becomes available again, so a disconnected terminal never loses a
    // phone-submitted prompt; the CLI must dedupe command ids locally on retry.
    if (typeof ack?.id === "string" && typeof ack.leaseId === "string") {
      cap.commands = commands.filter((item) => !(item.id === ack.id && item.leaseId === ack.leaseId));
    }
    const pending = (cap.commands || []).find((item) => !item.leaseId || (item.leaseExpiresAt || 0) <= now);
    if (pending) {
      pending.leaseId = crypto.randomBytes(16).toString("base64url");
      pending.leaseExpiresAt = now + 30_000;
      command = { id: pending.id, type: pending.type, text: pending.text, leaseId: pending.leaseId };
    }
    writeCapability(meta.id, cap);
  }
  writeMeta(meta);
  return { cancelRequested: cap?.cancelRequested === true, ...(command ? { command } : {}) };
}

/** Queue a deliberately tiny inbound control surface for a paired terminal.
 * It carries only a user text submission; approvals, shell commands, paths and
 * tool calls stay out of this bridge. A pairing-token holder is the current
 * single-user owner authentication boundary. */
export function enqueueClientCommand(id: string, requesterDeviceId: string, text: unknown): { ok: true; commandId: string } | { ok: false; error: string } {
  sweepOnce(); sweepClientRuns();
  const meta = getRun(id);
  if (!meta || meta.executionLocation !== "client") return { ok: false, error: "client run not found" };
  if (meta.status !== "running") return { ok: false, error: `run is ${meta.status}` };
  const clean = cleanClientText(text, 4000);
  if (!clean) return { ok: false, error: "submit text is required" };
  const cap = readCapability(id);
  if (!cap) return { ok: false, error: "client run capability is unavailable" };
  const commands = cap.commands || [];
  if (commands.length >= 8) return { ok: false, error: "client command queue is full" };
  const commandId = "cmd-" + crypto.randomBytes(12).toString("base64url");
  commands.push({ id: commandId, type: "submit", text: clean, requestedByDeviceId: requesterDeviceId, createdAt: Date.now() });
  cap.commands = commands; writeCapability(id, cap);
  return { ok: true, commandId };
}

// Browser control is scoped to one /rc session. Its token is supplied in the
// deep-link fragment, never in the URL query or as a host-wide credential.
export function enqueueClientControlCommand(id: string, controlToken: string, text: unknown): { ok: true; commandId: string } | { ok: false; error: string } {
  const meta = getRun(id);
  const cap = readCapability(id);
  if (!meta || meta.executionLocation !== "client" || !cap) return { ok: false, error: "client run not found" };
  if (!controlToken || !equalHash(cap.controlTokenHash, tokenHash(controlToken))) return { ok: false, error: "invalid remote-control capability" };
  return enqueueClientCommand(id, "web-control", text);
}

export function finishClientRun(meta: RunMeta, status: Extract<RunStatus, "done" | "error" | "stopped">, error?: string): { ok: true } | { ok: false; error: string } {
  if (meta.status !== "running") return { ok: false, error: `run is ${meta.status}` };
  meta.status = status;
  if (error) meta.error = cleanClientText(error, 2000);
  meta.updatedAt = Date.now();
  const line = appendLog(meta, { k: "status", v: status, ...(meta.error ? { error: meta.error } : {}) });
  writeMeta(meta); notifyClientRun(meta, line); clientLive.delete(meta.id); pruneRunLedgers();
  return { ok: true };
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
    if (!isKnownEventKind(e.k)) throw new Error(`refusing unknown run event kind: ${e.k}`);
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
    pruneRunLedgers();
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
  if (!lr) {
    const meta = getRun(id);
    if (!meta || meta.executionLocation !== "client" || meta.status !== "running") return false;
    const cap = readCapability(id);
    if (!cap) return false;
    cap.cancelRequested = true;
    writeCapability(id, cap);
    return true;
  }
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
  sweepClientRuns();
  const ids = new Set([
    ...live.keys(),
    ...clientLive.keys(),
    ...listRuns(500)
      .filter((run) => run.status === "running")
      .map((run) => run.id),
  ]);
  for (const id of ids) stopRun(id);
  return [...ids];
}

export function getRun(id: string): RunMeta | null {
  const lr = live.get(id);
  if (lr) return lr.meta;
  sweepOnce();
  try { return JSON.parse(fs.readFileSync(metaPath(id), "utf8")); } catch { return null; }
}

export function isRunLive(id: string): boolean {
  // Client-owned terminals can disappear without a final HTTP request. Refresh
  // their heartbeat expiry before reporting a live state to the UI or guards.
  sweepClientRuns();
  if (live.has(id) || clientLive.has(id)) return true;
  const meta = getRun(id);
  return meta?.status === "running";
}

export function anyRunLive(): boolean {
  // Do this before consulting the in-memory map: a stale remote terminal may
  // still have a relay entry until its heartbeat expiry is processed.
  sweepClientRuns();
  if (live.size > 0 || clientLive.size > 0) return true;
  return listRuns(500).some((run) => run.status === "running");
}

export function listRuns(limit = 50): RunMeta[] {
  sweepOnce();
  sweepClientRuns();
  const out = new Map<string, RunMeta>();
  for (const lr of live.values()) out.set(lr.meta.id, lr.meta);
  let files: string[] = [];
  try { files = fs.readdirSync(RUNS_DIR).filter(isMetaFile); } catch {}
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
  if (isRunLive(id)) return { ok: false, error: "run is still active — stop it first" };
  const meta = getRun(id);
  if (!meta) return { ok: false, error: "run not found" };
  let removed = false;
  try { fs.unlinkSync(metaPath(id)); removed = true; } catch {}
  try { fs.unlinkSync(logPath(id)); removed = true; } catch {}
  try { fs.unlinkSync(capabilityPath(id)); } catch {}
  return removed ? { ok: true } : { ok: false, error: "run not found" };
}

// Bulk cleanup for the Library's "delete all" — removes every TERMINAL run's
// meta + ledger in one pass. Live runs are untouched (stop them first); the
// count of skipped-because-live runs is reported so the UI can say so.
export function deleteAllRuns(): { deleted: number; skippedLive: number } {
  let deleted = 0;
  let files: string[] = [];
  try { files = fs.readdirSync(RUNS_DIR).filter(isMetaFile); } catch {}
  for (const f of files) {
    const id = f.slice(0, -5);
    if (isRunLive(id)) continue;
    try { fs.unlinkSync(metaPath(id)); deleted++; } catch {}
    try { fs.unlinkSync(logPath(id)); } catch {}
    try { fs.unlinkSync(capabilityPath(id)); } catch {}
  }
  return { deleted, skippedLive: listRuns(500).filter((run) => run.status === "running").length };
}

// Replay-then-tail with no gap and no duplicates: subscribe FIRST (buffering live
// lines that arrive while we read the file), then stream the file, then flush the
// buffer minus anything the file already contained. Returns an unsubscribe fn.
export function openRunStream(id: string, afterSeq: number, onLine: (line: Line) => void): { close: () => void } {
  const lr = live.get(id);
  const meta = lr?.meta ?? getRun(id);
  const client = !lr && meta?.executionLocation === "client" && meta.status === "running" ? clientLiveRun(meta) : undefined;
  const buffered: Line[] = [];
  let replaying = true;
  const sub = (line: Line) => { if (replaying) buffered.push(line); else onLine(line); };
  lr?.subscribers.add(sub); client?.subscribers.add(sub);

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

  return { close: () => { lr?.subscribers.delete(sub); client?.subscribers.delete(sub); } };
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
