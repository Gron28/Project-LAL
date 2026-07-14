import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ArtifactRef, EvidenceRecord, ModelProfile, NodeStatus, ResourceBudget, StageResult, TaskEnvelope, WorkflowSpec, WorkflowStatus } from "./contracts";

const DATA_DIR = path.join(process.cwd(), ".data");
const HIVE_DIR = path.join(DATA_DIR, "hive");
const ARTIFACT_DIR = path.join(HIVE_DIR, "artifacts");
const DB_PATH = path.join(DATA_DIR, "hive.db");
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

type DbGlobal = typeof globalThis & { __hive_db?: DatabaseSync };
const globalDb = globalThis as DbGlobal;
export const hiveDb = globalDb.__hive_db ?? new DatabaseSync(DB_PATH, { timeout: 5_000 });
globalDb.__hive_db = hiveDb;

hiveDb.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, template_id TEXT NOT NULL, spec_version INTEGER NOT NULL,
    status TEXT NOT NULL, envelope_json TEXT NOT NULL, spec_json TEXT NOT NULL, budget_json TEXT NOT NULL,
    working_json TEXT NOT NULL DEFAULT '{}', execution_run_id TEXT, parent_workflow_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, error TEXT
  );
  CREATE TABLE IF NOT EXISTS workflow_nodes (
    workflow_id TEXT NOT NULL, node_id TEXT NOT NULL, label TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL,
    status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, model_profile_id TEXT, model_version TEXT,
    started_at INTEGER, finished_at INTEGER, duration_ms INTEGER, prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0, context_tokens INTEGER NOT NULL DEFAULT 0, swap_ms INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0, result_json TEXT, error TEXT, idempotency_key TEXT NOT NULL,
    PRIMARY KEY (workflow_id, node_id), FOREIGN KEY (workflow_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS hive_events (
    workflow_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, node_id TEXT,
    role TEXT, model_version TEXT, payload_json TEXT NOT NULL, PRIMARY KEY (workflow_id, seq),
    FOREIGN KEY (workflow_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS artifacts (
    hash TEXT PRIMARY KEY, media_type TEXT NOT NULL, size INTEGER NOT NULL, relative_path TEXT NOT NULL,
    label TEXT, source_workflow_id TEXT, source_node_id TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workflow_artifacts (
    workflow_id TEXT NOT NULL, node_id TEXT, hash TEXT NOT NULL, direction TEXT NOT NULL,
    PRIMARY KEY (workflow_id, node_id, hash, direction), FOREIGN KEY (hash) REFERENCES artifacts(hash)
  );
  CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, node_id TEXT NOT NULL, url TEXT NOT NULL, retrieved_at INTEGER NOT NULL,
    source_hash TEXT NOT NULL, excerpt TEXT NOT NULL, stance TEXT NOT NULL, claim TEXT, title TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS model_profiles (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, version_hash TEXT NOT NULL,
    profile_json TEXT NOT NULL, probe_status TEXT NOT NULL, probed_at INTEGER, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, node_id TEXT, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER, FOREIGN KEY (workflow_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS node_side_effects (
    workflow_id TEXT NOT NULL, node_id TEXT NOT NULL, fingerprint TEXT NOT NULL, tool_name TEXT NOT NULL,
    args_json TEXT NOT NULL, status TEXT NOT NULL, output TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (workflow_id,node_id,fingerprint), FOREIGN KEY (workflow_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS semantic_facts (
    id TEXT PRIMARY KEY, fact TEXT NOT NULL, source_hash TEXT NOT NULL, valid_from INTEGER, valid_to INTEGER,
    supersedes_id TEXT, contradiction_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS procedural_memory (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, content_json TEXT NOT NULL, source_workflow_id TEXT NOT NULL,
    verification_score REAL NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS training_examples (
    id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, source TEXT NOT NULL, license TEXT, generator TEXT,
    parent_ids_json TEXT NOT NULL, workflow_role TEXT, checks_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    quarantine_status TEXT NOT NULL, content_path TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest_hash TEXT NOT NULL, ordered_example_ids_json TEXT NOT NULL,
    manifest_path TEXT NOT NULL, created_at INTEGER NOT NULL, immutable INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY, base_weights_hash TEXT NOT NULL, training_config_json TEXT NOT NULL, code_revision TEXT NOT NULL,
    ordered_example_ids_json TEXT NOT NULL, dataset_hashes_json TEXT NOT NULL, evaluation_json TEXT NOT NULL,
    artifact_hash TEXT, created_at INTEGER NOT NULL, promotion_status TEXT NOT NULL DEFAULT 'candidate'
  );
  CREATE TABLE IF NOT EXISTS role_overrides (
    role_id TEXT PRIMARY KEY, prompt TEXT, preferred_model TEXT, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_updated ON workflow_runs(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_workflow_nodes_status ON workflow_nodes(workflow_id, status);
  CREATE INDEX IF NOT EXISTS idx_hive_events_workflow ON hive_events(workflow_id, seq);
  CREATE INDEX IF NOT EXISTS idx_evidence_workflow ON evidence(workflow_id, node_id);
`);
// Additive migration for databases created before specialist adapters existed.
if (!hiveDb.prepare("PRAGMA table_info(workflow_nodes)").all().some((column) => column.name === "adapter_ms")) {
  hiveDb.exec("ALTER TABLE workflow_nodes ADD COLUMN adapter_ms INTEGER NOT NULL DEFAULT 0");
}

const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown, fallback: T): T => { try { return JSON.parse(String(v)) as T; } catch { return fallback; } };
const now = () => Date.now();

export type WorkflowNodeRecord = {
  nodeId: string; label: string; role: string; action: string; status: NodeStatus; attempt: number;
  modelProfileId?: string; modelVersion?: string; startedAt?: number; finishedAt?: number; durationMs?: number;
  promptTokens: number; completionTokens: number; contextTokens: number; swapMs: number; adapterMs: number; toolCalls: number;
  result?: StageResult; error?: string; idempotencyKey: string;
};

export type WorkflowRecord = {
  id: string; kind: "research" | "coding"; templateId: string; status: WorkflowStatus;
  envelope: TaskEnvelope; spec: WorkflowSpec; budget: ResourceBudget; working: Record<string, unknown>;
  executionRunId?: string; parentWorkflowId?: string; createdAt: number; updatedAt: number; startedAt?: number; finishedAt?: number; error?: string;
};

function workflowFromRow(row: Record<string, unknown>): WorkflowRecord {
  return {
    id: String(row.id), kind: row.kind as "research" | "coding", templateId: String(row.template_id), status: row.status as WorkflowStatus,
    envelope: parse(row.envelope_json, {} as TaskEnvelope), spec: parse(row.spec_json, {} as WorkflowSpec), budget: parse(row.budget_json, {} as ResourceBudget),
    working: parse(row.working_json, {}), executionRunId: row.execution_run_id ? String(row.execution_run_id) : undefined,
    parentWorkflowId: row.parent_workflow_id ? String(row.parent_workflow_id) : undefined, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    startedAt: row.started_at ? Number(row.started_at) : undefined, finishedAt: row.finished_at ? Number(row.finished_at) : undefined,
    error: row.error ? String(row.error) : undefined,
  };
}

function nodeFromRow(row: Record<string, unknown>): WorkflowNodeRecord {
  return {
    nodeId: String(row.node_id), label: String(row.label), role: String(row.role), action: String(row.action), status: row.status as NodeStatus,
    attempt: Number(row.attempt), modelProfileId: row.model_profile_id ? String(row.model_profile_id) : undefined,
    modelVersion: row.model_version ? String(row.model_version) : undefined, startedAt: row.started_at ? Number(row.started_at) : undefined,
    finishedAt: row.finished_at ? Number(row.finished_at) : undefined, durationMs: row.duration_ms ? Number(row.duration_ms) : undefined,
    promptTokens: Number(row.prompt_tokens), completionTokens: Number(row.completion_tokens), contextTokens: Number(row.context_tokens),
    swapMs: Number(row.swap_ms), adapterMs: Number(row.adapter_ms || 0), toolCalls: Number(row.tool_calls), result: row.result_json ? parse(row.result_json, undefined) : undefined,
    error: row.error ? String(row.error) : undefined, idempotencyKey: String(row.idempotency_key),
  };
}

export function createWorkflow(record: WorkflowRecord): void {
  hiveDb.exec("BEGIN IMMEDIATE");
  try {
    hiveDb.prepare(`INSERT INTO workflow_runs (id,kind,template_id,spec_version,status,envelope_json,spec_json,budget_json,working_json,execution_run_id,parent_workflow_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.id, record.kind, record.templateId, record.spec.version, record.status, json(record.envelope), json(record.spec), json(record.budget), json(record.working), record.executionRunId ?? null, record.parentWorkflowId ?? null, record.createdAt, record.updatedAt);
    const insert = hiveDb.prepare(`INSERT INTO workflow_nodes (workflow_id,node_id,label,role,action,status,idempotency_key) VALUES (?,?,?,?,?,'pending',?)`);
    for (const node of record.spec.nodes) insert.run(record.id, node.id, node.label, node.role, node.action, crypto.createHash("sha256").update(`${record.id}:${node.id}:${record.spec.version}`).digest("hex"));
    hiveDb.exec("COMMIT");
  } catch (e) { hiveDb.exec("ROLLBACK"); throw e; }
}

export function getWorkflow(id: string): WorkflowRecord | null {
  const row = hiveDb.prepare("SELECT * FROM workflow_runs WHERE id=?").get(id);
  return row ? workflowFromRow(row) : null;
}

export function listWorkflows(limit = 50): WorkflowRecord[] {
  return hiveDb.prepare("SELECT * FROM workflow_runs ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(limit, 200))).map(workflowFromRow);
}

export function getWorkflowNodes(id: string): WorkflowNodeRecord[] {
  return hiveDb.prepare("SELECT * FROM workflow_nodes WHERE workflow_id=? ORDER BY rowid").all(id).map(nodeFromRow);
}

export function updateWorkflow(id: string, patch: Partial<Pick<WorkflowRecord, "status" | "working" | "executionRunId" | "startedAt" | "finishedAt" | "error">>): void {
  const current = getWorkflow(id);
  if (!current) return;
  const value = <K extends keyof typeof patch>(key: K, fallback: unknown) => Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] ?? null : fallback;
  hiveDb.prepare(`UPDATE workflow_runs SET status=?,working_json=?,execution_run_id=?,started_at=?,finished_at=?,error=?,updated_at=? WHERE id=?`).run(
    patch.status ?? current.status, json(patch.working ?? current.working), patch.executionRunId ?? current.executionRunId ?? null,
    value("startedAt", current.startedAt ?? null), value("finishedAt", current.finishedAt ?? null), value("error", current.error ?? null), now(), id,
  );
}

export function updateNode(workflowId: string, nodeId: string, patch: Partial<WorkflowNodeRecord>): void {
  const row = hiveDb.prepare("SELECT * FROM workflow_nodes WHERE workflow_id=? AND node_id=?").get(workflowId, nodeId);
  if (!row) return;
  const n = nodeFromRow(row);
  hiveDb.prepare(`UPDATE workflow_nodes SET status=?,attempt=?,model_profile_id=?,model_version=?,started_at=?,finished_at=?,duration_ms=?,prompt_tokens=?,completion_tokens=?,context_tokens=?,swap_ms=?,adapter_ms=?,tool_calls=?,result_json=?,error=? WHERE workflow_id=? AND node_id=?`).run(
    patch.status ?? n.status, patch.attempt ?? n.attempt, patch.modelProfileId ?? n.modelProfileId ?? null, patch.modelVersion ?? n.modelVersion ?? null,
    patch.startedAt ?? n.startedAt ?? null, patch.finishedAt ?? n.finishedAt ?? null, patch.durationMs ?? n.durationMs ?? null,
    patch.promptTokens ?? n.promptTokens, patch.completionTokens ?? n.completionTokens, patch.contextTokens ?? n.contextTokens,
    patch.swapMs ?? n.swapMs, patch.adapterMs ?? n.adapterMs, patch.toolCalls ?? n.toolCalls, patch.result !== undefined ? json(patch.result) : n.result ? json(n.result) : null,
    patch.error ?? n.error ?? null, workflowId, nodeId,
  );
  hiveDb.prepare("UPDATE workflow_runs SET updated_at=? WHERE id=?").run(now(), workflowId);
}

export type HiveEvent = { seq: number; ts: number; kind: string; nodeId?: string; role?: string; modelVersion?: string; payload: unknown };
export function appendHiveEvent(workflowId: string, event: Omit<HiveEvent, "seq" | "ts">): HiveEvent {
  hiveDb.exec("BEGIN IMMEDIATE");
  try {
    const row = hiveDb.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM hive_events WHERE workflow_id=?").get(workflowId);
    const out = { ...event, seq: Number(row?.seq ?? 1), ts: now() };
    hiveDb.prepare("INSERT INTO hive_events (workflow_id,seq,ts,kind,node_id,role,model_version,payload_json) VALUES (?,?,?,?,?,?,?,?)")
      .run(workflowId, out.seq, out.ts, out.kind, out.nodeId ?? null, out.role ?? null, out.modelVersion ?? null, json(out.payload));
    hiveDb.exec("COMMIT");
    return out;
  } catch (e) { hiveDb.exec("ROLLBACK"); throw e; }
}

export function getHiveEvents(workflowId: string, after = 0, limit = 500): HiveEvent[] {
  return hiveDb.prepare("SELECT * FROM hive_events WHERE workflow_id=? AND seq>? ORDER BY seq LIMIT ?").all(workflowId, after, Math.min(limit, 2_000)).map((r) => ({
    seq: Number(r.seq), ts: Number(r.ts), kind: String(r.kind), nodeId: r.node_id ? String(r.node_id) : undefined,
    role: r.role ? String(r.role) : undefined, modelVersion: r.model_version ? String(r.model_version) : undefined, payload: parse(r.payload_json, null),
  }));
}

export function getLatestHiveEvents(workflowId: string, limit = 500): HiveEvent[] {
  return hiveDb.prepare("SELECT * FROM hive_events WHERE workflow_id=? ORDER BY seq DESC LIMIT ?").all(workflowId, Math.min(limit, 2_000)).reverse().map((r) => ({
    seq: Number(r.seq), ts: Number(r.ts), kind: String(r.kind), nodeId: r.node_id ? String(r.node_id) : undefined,
    role: r.role ? String(r.role) : undefined, modelVersion: r.model_version ? String(r.model_version) : undefined, payload: parse(r.payload_json, null),
  }));
}

export function getLatestHiveToolResult(workflowId: string, toolName: string): HiveEvent | null {
  const row = hiveDb.prepare("SELECT * FROM hive_events WHERE workflow_id=? AND kind='worker_tool_result' AND json_extract(payload_json, '$.name')=? ORDER BY seq DESC LIMIT 1").get(workflowId, toolName);
  if (!row) return null;
  return {
    seq: Number(row.seq), ts: Number(row.ts), kind: String(row.kind), nodeId: row.node_id ? String(row.node_id) : undefined,
    role: row.role ? String(row.role) : undefined, modelVersion: row.model_version ? String(row.model_version) : undefined, payload: parse(row.payload_json, null),
  };
}

export function getLatestHiveToolResults(workflowId: string, toolName: string, limit = 20): HiveEvent[] {
  return hiveDb.prepare("SELECT * FROM hive_events WHERE workflow_id=? AND kind='worker_tool_result' AND json_extract(payload_json, '$.name')=? ORDER BY seq DESC LIMIT ?").all(workflowId, toolName, Math.min(limit, 100)).reverse().map((row) => ({
    seq: Number(row.seq), ts: Number(row.ts), kind: String(row.kind), nodeId: row.node_id ? String(row.node_id) : undefined,
    role: row.role ? String(row.role) : undefined, modelVersion: row.model_version ? String(row.model_version) : undefined, payload: parse(row.payload_json, null),
  }));
}

export function putArtifact(content: string | Uint8Array, mediaType: string, meta: { workflowId?: string; nodeId?: string; label?: string } = {}): ArtifactRef {
  const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const relative = path.join(hash.slice(0, 2), hash);
  const targetDir = path.join(ARTIFACT_DIR, hash.slice(0, 2));
  const target = path.join(ARTIFACT_DIR, relative);
  fs.mkdirSync(targetDir, { recursive: true });
  if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { flag: "wx" });
  hiveDb.prepare("INSERT OR IGNORE INTO artifacts (hash,media_type,size,relative_path,label,source_workflow_id,source_node_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(hash, mediaType, bytes.length, relative, meta.label ?? null, meta.workflowId ?? null, meta.nodeId ?? null, now());
  if (meta.workflowId) hiveDb.prepare("INSERT OR IGNORE INTO workflow_artifacts (workflow_id,node_id,hash,direction) VALUES (?,?,?,'output')").run(meta.workflowId, meta.nodeId ?? null, hash);
  return { hash, mediaType, size: bytes.length, label: meta.label, path: target };
}

export function readArtifact(hash: string): Buffer | null {
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  const row = hiveDb.prepare("SELECT relative_path FROM artifacts WHERE hash=?").get(hash);
  if (!row) return null;
  try { return fs.readFileSync(path.join(ARTIFACT_DIR, String(row.relative_path))); } catch { return null; }
}

export function putEvidence(workflowId: string, nodeId: string, evidence: EvidenceRecord): void {
  hiveDb.prepare(`INSERT OR REPLACE INTO evidence (id,workflow_id,node_id,url,retrieved_at,source_hash,excerpt,stance,claim,title) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(evidence.id, workflowId, nodeId, evidence.url, evidence.retrievedAt, evidence.sourceHash, evidence.excerpt.slice(0, 2_000), evidence.stance, evidence.claim ?? null, evidence.title ?? null);
}

export function getEvidence(workflowId: string): EvidenceRecord[] {
  return hiveDb.prepare("SELECT * FROM evidence WHERE workflow_id=? ORDER BY retrieved_at").all(workflowId).map((r) => ({
    id: String(r.id), url: String(r.url), retrievedAt: Number(r.retrieved_at), sourceHash: String(r.source_hash), excerpt: String(r.excerpt),
    stance: r.stance as EvidenceRecord["stance"], claim: r.claim ? String(r.claim) : undefined, title: r.title ? String(r.title) : undefined,
  }));
}

export function upsertModelProfile(profile: ModelProfile): void {
  hiveDb.prepare(`INSERT INTO model_profiles (id,provider,model,version_hash,profile_json,probe_status,probed_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,model=excluded.model,version_hash=excluded.version_hash,profile_json=excluded.profile_json,probe_status=excluded.probe_status,probed_at=excluded.probed_at,updated_at=excluded.updated_at`)
    .run(profile.id, profile.provider, profile.model, profile.versionHash, json(profile), profile.probeStatus, profile.probedAt ?? null, now());
}
export function listModelProfiles(): ModelProfile[] { return hiveDb.prepare("SELECT profile_json FROM model_profiles ORDER BY model").all().map((r) => parse(r.profile_json, {} as ModelProfile)); }

export function workflowSnapshot(id: string, eventLimit = 300, eventAfter = 0) {
  const workflow = getWorkflow(id);
  if (!workflow) return null;
  return { workflow, nodes: getWorkflowNodes(id), evidence: getEvidence(id), events: getHiveEvents(id, eventAfter, eventLimit) };
}

// User-editable overrides on top of presets.ts's hardcoded ROLE_PROFILES — which
// model a role prefers and/or a replacement system prompt. Unset fields mean "use
// the default." engine.ts's effectiveRole() merges these in at execution time.
export type RoleOverride = { prompt?: string; preferredModel?: string };
export function getRoleOverrides(): Record<string, RoleOverride> {
  const rows = hiveDb.prepare("SELECT role_id, prompt, preferred_model FROM role_overrides").all();
  const out: Record<string, RoleOverride> = {};
  for (const r of rows) {
    out[String(r.role_id)] = { ...(r.prompt ? { prompt: String(r.prompt) } : {}), ...(r.preferred_model ? { preferredModel: String(r.preferred_model) } : {}) };
  }
  return out;
}
export function setRoleOverride(roleId: string, o: RoleOverride): void {
  hiveDb.prepare(`INSERT INTO role_overrides (role_id,prompt,preferred_model,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(role_id) DO UPDATE SET prompt=excluded.prompt, preferred_model=excluded.preferred_model, updated_at=excluded.updated_at`)
    .run(roleId, o.prompt || null, o.preferredModel || null, now());
}
export function resetRoleOverride(roleId: string): void {
  hiveDb.prepare("DELETE FROM role_overrides WHERE role_id=?").run(roleId);
}

// workflow_nodes/hive_events/evidence/approvals/node_side_effects all cascade via
// their FK on workflow_runs(id) (PRAGMA foreign_keys=ON) — only workflow_artifacts
// has no FK constraint on workflow_id, so it needs an explicit delete.
export function deleteWorkflow(id: string): boolean {
  hiveDb.prepare("DELETE FROM workflow_artifacts WHERE workflow_id=?").run(id);
  const r = hiveDb.prepare("DELETE FROM workflow_runs WHERE id=?").run(id);
  return Number(r.changes) > 0;
}

export function createApproval(id: string, workflowId: string, nodeId: string | undefined, kind: string, payload: unknown): void {
  hiveDb.prepare("INSERT INTO approvals (id,workflow_id,node_id,kind,payload_json,status,created_at) VALUES (?,?,?,?,?,'pending',?)").run(id, workflowId, nodeId ?? null, kind, json(payload), now());
}
export function resolveStoredApproval(id: string, allow: boolean): boolean {
  const r = hiveDb.prepare("UPDATE approvals SET status=?,resolved_at=? WHERE id=? AND status='pending'").run(allow ? "approved" : "denied", now(), id);
  return Number(r.changes) > 0;
}

export function beginSideEffect(workflowId: string, nodeId: string, toolName: string, args: Record<string, unknown>): { action: "execute" | "replay" | "uncertain"; fingerprint: string; output?: string } {
  const fingerprint = crypto.createHash("sha256").update(json({ toolName, args })).digest("hex");
  const inserted = hiveDb.prepare(`INSERT OR IGNORE INTO node_side_effects (workflow_id,node_id,fingerprint,tool_name,args_json,status,created_at,updated_at) VALUES (?,?,?,?,?,'running',?,?)`)
    .run(workflowId, nodeId, fingerprint, toolName, json(args), now(), now());
  if (Number(inserted.changes) > 0) return { action: "execute", fingerprint };
  const row = hiveDb.prepare("SELECT status,output FROM node_side_effects WHERE workflow_id=? AND node_id=? AND fingerprint=?").get(workflowId, nodeId, fingerprint);
  if (row?.status === "completed") return { action: "replay", fingerprint, output: String(row.output ?? "") };
  if (row?.status === "failed") {
    hiveDb.prepare("UPDATE node_side_effects SET status='running',updated_at=? WHERE workflow_id=? AND node_id=? AND fingerprint=?").run(now(), workflowId, nodeId, fingerprint);
    return { action: "execute", fingerprint };
  }
  return { action: "uncertain", fingerprint };
}

export function finishSideEffect(workflowId: string, nodeId: string, fingerprint: string, output: string, succeeded: boolean): void {
  hiveDb.prepare("UPDATE node_side_effects SET status=?,output=?,updated_at=? WHERE workflow_id=? AND node_id=? AND fingerprint=?")
    .run(succeeded ? "completed" : "failed", output.slice(0, 32_000), now(), workflowId, nodeId, fingerprint);
}

export function resetInterruptedNodes(workflowId: string): number {
  const r = hiveDb.prepare("UPDATE workflow_nodes SET status='pending',error='execution interrupted; resuming from the last completed node',started_at=NULL WHERE workflow_id=? AND status IN ('running','ready','cancelled','awaiting_approval')").run(workflowId);
  return Number(r.changes);
}

// A user-requested resume of a FAILED workflow must give its failed node a
// genuinely fresh start — attempt count included. Without this, resume left
// failed nodes terminal, the dependency graph saw them as blockers, and the
// workflow re-failed instantly as "blocked by failed node(s)" (observed
// 2026-07-11: a GPU wedge failed the judge, resume was a no-op). Attempt
// resets too, because the stored spec's maxAttempts already rejected the node.
export function resetFailedNodes(workflowId: string): number {
  const r = hiveDb.prepare("UPDATE workflow_nodes SET status='pending',attempt=0,error='reset for resume after failure',started_at=NULL,finished_at=NULL WHERE workflow_id=? AND status='failed'").run(workflowId);
  return Number(r.changes);
}
