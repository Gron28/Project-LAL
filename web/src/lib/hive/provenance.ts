import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bm25Search } from "../bm25";
import { hiveDb } from "./store";
import { evaluateSpecialistPromotion } from "./evaluation";

const MANIFEST_DIR = path.join(process.cwd(), ".data", "hive", "datasets");
fs.mkdirSync(MANIFEST_DIR, { recursive: true });
const sha = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const parse = <T>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value)) as T; } catch { return fallback; } };

export type DatasetManifest = {
  id: string; version: string; sourcePath: string; sourceHash: string; createdAt: number;
  examples: { id: string; contentHash: string; source: string; license?: string; generator?: string; parentIds: string[]; workflowRole?: string; checks: string[]; sourceLine: number }[];
};

export function migrateJsonlCorpus(sourcePath: string, metadata: { source: string; license?: string; generator?: string; workflowRole?: string; version?: string }): DatasetManifest {
  const absolute = path.resolve(sourcePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error("JSONL corpus not found");
  const raw = fs.readFileSync(absolute);
  const sourceHash = sha(raw);
  const lines = raw.toString("utf8").split("\n");
  const examples: DatasetManifest["examples"] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try { JSON.parse(line); } catch { throw new Error(`invalid JSON on line ${i + 1}; source was not modified`); }
    const contentHash = sha(line);
    const id = `ex-${contentHash.slice(0, 24)}`;
    const example = { id, contentHash, source: metadata.source, license: metadata.license, generator: metadata.generator, parentIds: [], workflowRole: metadata.workflowRole, checks: ["valid_json"], sourceLine: i + 1 };
    examples.push(example);
    hiveDb.prepare(`INSERT OR IGNORE INTO training_examples (id,content_hash,source,license,generator,parent_ids_json,workflow_role,checks_json,created_at,quarantine_status,content_path)
      VALUES (?,?,?,?,?,?,?,?,?,'approved',?)`).run(id, contentHash, metadata.source, metadata.license ?? null, metadata.generator ?? null, "[]", metadata.workflowRole ?? null, JSON.stringify(example.checks), Date.now(), `${absolute}#L${i + 1}`);
  }
  const version = metadata.version || "1";
  const datasetId = `ds-${sha(`${absolute}:${sourceHash}:${version}`).slice(0, 24)}`;
  const manifest: DatasetManifest = { id: datasetId, version, sourcePath: absolute, sourceHash, createdAt: Date.now(), examples };
  const serialized = JSON.stringify(manifest, null, 2) + "\n";
  const manifestHash = sha(serialized);
  const manifestPath = path.join(MANIFEST_DIR, `${datasetId}.json`);
  if (fs.existsSync(manifestPath) && fs.readFileSync(manifestPath, "utf8") !== serialized) throw new Error("immutable dataset manifest already exists with different content");
  if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, serialized, { flag: "wx" });
  hiveDb.prepare(`INSERT OR IGNORE INTO datasets (id,version,manifest_hash,ordered_example_ids_json,manifest_path,created_at,immutable) VALUES (?,?,?,?,?,?,1)`)
    .run(datasetId, version, manifestHash, JSON.stringify(examples.map((e) => e.id)), manifestPath, manifest.createdAt);
  return manifest;
}

export function proposeCorrectiveExample(input: { content: unknown; sourceWorkflowId: string; workflowRole: string; parentIds?: string[]; checks?: string[] }): string {
  const serialized = JSON.stringify(input.content);
  const contentHash = sha(serialized);
  const id = `ex-${contentHash.slice(0, 24)}`;
  const dir = path.join(process.cwd(), ".data", "hive", "quarantine"); fs.mkdirSync(dir, { recursive: true });
  const contentPath = path.join(dir, `${id}.json`);
  if (!fs.existsSync(contentPath)) fs.writeFileSync(contentPath, serialized + "\n", { flag: "wx" });
  hiveDb.prepare(`INSERT OR IGNORE INTO training_examples (id,content_hash,source,license,generator,parent_ids_json,workflow_role,checks_json,created_at,quarantine_status,content_path)
    VALUES (?,?,?,?,?,?,?,?,?,'quarantined',?)`).run(id, contentHash, `workflow:${input.sourceWorkflowId}`, null, "hive-failure-converter", JSON.stringify(input.parentIds || []), input.workflowRole, JSON.stringify(input.checks || []), Date.now(), contentPath);
  return id;
}

export function approveTrainingExample(id: string, approved: boolean): boolean {
  if (approved) {
    const example = hiveDb.prepare("SELECT checks_json FROM training_examples WHERE id=? AND quarantine_status='quarantined'").get(id);
    if (!example || !parse<string[]>(example.checks_json, []).length) throw new Error("deterministic quality checks must pass before an example can leave quarantine");
  }
  const result = hiveDb.prepare("UPDATE training_examples SET quarantine_status=? WHERE id=? AND quarantine_status='quarantined'").run(approved ? "approved" : "rejected", id);
  return Number(result.changes) > 0;
}

export function registerCheckpoint(input: { id: string; baseWeightsHash: string; trainingConfig: unknown; codeRevision: string; orderedExampleIds: string[]; datasetHashes: string[]; evaluation: unknown; artifactHash?: string }): void {
  if (!input.orderedExampleIds.length) throw new Error("checkpoint requires exact ordered example IDs");
  hiveDb.prepare(`INSERT INTO checkpoints (id,base_weights_hash,training_config_json,code_revision,ordered_example_ids_json,dataset_hashes_json,evaluation_json,artifact_hash,created_at,promotion_status)
    VALUES (?,?,?,?,?,?,?,?,?,'candidate')`).run(input.id, input.baseWeightsHash, JSON.stringify(input.trainingConfig), input.codeRevision, JSON.stringify(input.orderedExampleIds), JSON.stringify(input.datasetHashes), JSON.stringify(input.evaluation), input.artifactHash ?? null, Date.now());
}

// Promotion is deliberately a separate mutation from training/checkpoint creation:
// candidate creation approval can never silently make it active.
export function decideCheckpointPromotion(id: string, approved: boolean): boolean {
  if (approved) {
    const row = hiveDb.prepare("SELECT evaluation_json FROM checkpoints WHERE id=? AND promotion_status='candidate'").get(id);
    if (!row) return false;
    const metrics = parse<Record<string, unknown>>(row.evaluation_json, {});
    const gate = evaluateSpecialistPromotion({
      heldOutRoleImprovementPoints: Number(metrics.heldOutRoleImprovementPoints), coreRegressionPoints: Number(metrics.coreRegressionPoints),
      schemaTestsPassed: metrics.schemaTestsPassed === true, toolTestsPassed: metrics.toolTestsPassed === true,
    });
    if (!gate.promotable) throw new Error(`specialist promotion gates failed: ${gate.gates.filter((g) => !g.passed).map((g) => g.code).join(", ")}`);
  }
  const result = hiveDb.prepare("UPDATE checkpoints SET promotion_status=? WHERE id=? AND promotion_status='candidate'").run(approved ? "promoted" : "rejected", id);
  return Number(result.changes) > 0;
}

export function attributionReport(failureText: string, limit = 20) {
  const rows = hiveDb.prepare("SELECT id,source,workflow_role,parent_ids_json,content_path FROM training_examples WHERE quarantine_status='approved'").all();
  const docs = rows.map((row) => {
    const location = String(row.content_path);
    const [file, marker] = location.split("#L");
    let text = "";
    try { text = marker ? fs.readFileSync(file, "utf8").split("\n")[Number(marker) - 1] || "" : fs.readFileSync(file, "utf8"); } catch {}
    return { id: String(row.id), text };
  });
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return {
    label: "ranked evidence, not causal proof",
    method: "BM25 lexical similarity plus dataset/role lineage; semantic similarity and per-example loss are intentionally absent until measured retrieval/loss jobs exist",
    candidates: bm25Search(docs, failureText, limit).map((hit) => {
      const row = byId.get(hit.id)!;
      return { exampleId: hit.id, lexicalScore: hit.score, source: row.source, workflowRole: row.workflow_role, parentIds: parse(row.parent_ids_json, []) };
    }),
  };
}

export function provenanceSummary() {
  const count = (table: string) => Number(hiveDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
  return { examples: count("training_examples"), datasets: count("datasets"), checkpoints: count("checkpoints"), quarantined: Number(hiveDb.prepare("SELECT COUNT(*) AS n FROM training_examples WHERE quarantine_status='quarantined'").get()?.n ?? 0) };
}
