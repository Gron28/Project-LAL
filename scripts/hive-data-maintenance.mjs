#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(root, "web", ".data");
const dbPath = path.join(dataDir, "hive.db");
const artifactDir = path.join(dataDir, "hive", "artifacts");
const apply = process.argv.includes("--apply");
const retentionDays = Number(process.env.LAL_HIVE_RETENTION_DAYS || 30);
if (!fs.existsSync(dbPath)) {
  console.log(JSON.stringify({ ok: true, mode: apply ? "apply" : "dry-run", note: "no Hive database", candidates: [] }, null, 2));
  process.exit(0);
}

const db = new DatabaseSync(dbPath, { readOnly: !apply });
db.exec("PRAGMA foreign_keys=ON");
const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => String(row.integrity_check));
const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
const sequenceProblems = db.prepare(`
  SELECT workflow_id, COUNT(*) AS events, COUNT(DISTINCT seq) AS unique_sequences,
         MIN(seq) AS first_sequence, MAX(seq) AS last_sequence
  FROM hive_events GROUP BY workflow_id
  HAVING COUNT(*) != COUNT(DISTINCT seq) OR MIN(seq) < 1
`).all();
const protectedWorkflows = new Set(
  db.prepare("SELECT id FROM workflow_runs WHERE status IN ('queued','running','paused','awaiting_approval','blocked','incomplete')").all().map((row) => String(row.id)),
);
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
if (tables.has("evaluation_runs")) {
  for (const row of db.prepare("SELECT trajectories_json FROM evaluation_runs").all()) {
    try {
      for (const item of JSON.parse(String(row.trajectories_json))) if (item?.workflowId) protectedWorkflows.add(String(item.workflowId));
    } catch {}
  }
}
const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
const candidates = db.prepare(`
  SELECT a.hash,a.relative_path,a.size,a.created_at,a.source_workflow_id
  FROM artifacts a LEFT JOIN workflow_artifacts wa ON wa.hash=a.hash
  WHERE wa.hash IS NULL AND a.created_at < ?
  ORDER BY a.created_at
`).all(cutoff).filter((row) => !row.source_workflow_id || !protectedWorkflows.has(String(row.source_workflow_id)));
const hashProblems = [];
for (const row of db.prepare("SELECT hash,relative_path,size FROM artifacts").all()) {
  const file = path.join(artifactDir, String(row.relative_path));
  try {
    const bytes = fs.readFileSync(file);
    const actual = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actual !== row.hash || bytes.length !== Number(row.size)) hashProblems.push({ hash: row.hash, actual, expectedSize: row.size, actualSize: bytes.length });
  } catch (error) {
    hashProblems.push({ hash: row.hash, error: error.message });
  }
}
const compactableStreams = db.prepare(`
  SELECT workflow_id,node_id,kind,COUNT(*) AS chunks,SUM(LENGTH(payload_json)) AS bytes
  FROM hive_events
  WHERE kind IN ('worker_text','stage_output','stage_reasoning') AND ts < ?
  GROUP BY workflow_id,node_id,kind HAVING COUNT(*) > 8
`).all(cutoff);

const moved = [];
if (apply && candidates.length) {
  const quarantine = path.join(dataDir, "hive", ".trash", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of candidates) {
      const source = path.join(artifactDir, String(row.relative_path));
      const target = path.join(quarantine, String(row.hash));
      if (fs.existsSync(source)) fs.renameSync(source, target);
      db.prepare("DELETE FROM artifacts WHERE hash=?").run(row.hash);
      moved.push({ hash: row.hash, quarantine: target });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
const report = {
  ok: integrity.every((value) => value === "ok") && foreignKeys.length === 0 && sequenceProblems.length === 0 && hashProblems.length === 0,
  mode: apply ? "apply" : "dry-run",
  retentionDays,
  integrity,
  foreignKeyProblems: foreignKeys,
  sequenceProblems,
  hashProblems,
  protectedWorkflowCount: protectedWorkflows.size,
  candidates: candidates.map((row) => ({ hash: row.hash, bytes: row.size, sourceWorkflowId: row.source_workflow_id })),
  candidateBytes: candidates.reduce((sum, row) => sum + Number(row.size), 0),
  compactableStreams,
  moved,
  note: "Apply moves unreferenced expired artifacts into a recoverable .trash directory. Stream compaction is reported only; new runtime streams are already durably chunked.",
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
