import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bm25Search } from "../bm25";
import { TOOL_DEFS } from "../tools";
import type { HiveSpecialistRole } from "./contracts";
import { hiveDb, workflowSnapshot } from "./store";
import { evaluateSpecialistPromotion } from "./evaluation";

const MANIFEST_DIR = path.join(process.cwd(), ".data", "hive", "datasets");
fs.mkdirSync(MANIFEST_DIR, { recursive: true });
const sha = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const parse = <T>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value)) as T; } catch { return fallback; } };
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
};

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

export function registerRoleDataset(sourcePath: string, manifestSourcePath: string): DatasetManifest {
  const absolute = path.resolve(sourcePath);
  const manifestPath = path.resolve(manifestSourcePath);
  if (!fs.existsSync(absolute) || !fs.existsSync(manifestPath)) throw new Error("role dataset or manifest not found");
  const raw = fs.readFileSync(absolute);
  const manifestRaw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const manifestHash = String(manifestRaw.manifest_hash || "");
  const datasetHash = String(manifestRaw.dataset_hash || "");
  const core = { ...manifestRaw }; delete core.manifest_hash; delete core.generated_at;
  if (!/^[a-f0-9]{64}$/.test(manifestHash) || sha(stable(core)) !== manifestHash) throw new Error("role manifest hash is invalid");
  if (sha(raw) !== datasetHash) throw new Error("role dataset bytes do not match its manifest");
  const expectedIds = Array.isArray(manifestRaw.ordered_example_ids) ? manifestRaw.ordered_example_ids.map(String) : [];
  const lines = raw.toString("utf8").split("\n").filter((line) => line.trim());
  if (!expectedIds.length || expectedIds.length !== lines.length) throw new Error("role manifest membership does not match JSONL rows");
  const examples: DatasetManifest["examples"] = [];
  for (const [index, line] of lines.entries()) {
    const row = JSON.parse(line) as { _hive?: Record<string, unknown> };
    const meta = row._hive || {};
    const id = String(meta.id || "");
    const checks = Array.isArray(meta.checks) ? meta.checks.map(String).filter(Boolean) : [];
    if (id !== expectedIds[index] || !checks.length) throw new Error(`invalid role example provenance on line ${index + 1}`);
    const contentHash = sha(stable({ messages: (row as Record<string, unknown>).messages, ...((row as Record<string, unknown>).tools ? { tools: (row as Record<string, unknown>).tools } : {}) }));
    if (contentHash !== meta.content_hash) throw new Error(`content hash mismatch on line ${index + 1}`);
    examples.push({
      id, contentHash, source: String(meta.source || ""), license: meta.license ? String(meta.license) : undefined,
      generator: meta.generator ? String(meta.generator) : undefined,
      parentIds: Array.isArray(meta.parent_ids) ? meta.parent_ids.map(String) : [], workflowRole: String(meta.role || ""), checks, sourceLine: index + 1,
    });
  }
  const datasetId = `ds-${manifestHash.slice(0, 24)}`;
  const manifest: DatasetManifest = { id: datasetId, version: String(manifestRaw.version || 1), sourcePath: absolute, sourceHash: datasetHash, createdAt: Number(manifestRaw.generated_at || Date.now()), examples };
  hiveDb.exec("BEGIN IMMEDIATE");
  try {
    const insert = hiveDb.prepare(`INSERT OR IGNORE INTO training_examples (id,content_hash,source,license,generator,parent_ids_json,workflow_role,checks_json,created_at,quarantine_status,content_path)
      VALUES (?,?,?,?,?,?,?,?,?,'approved',?)`);
    for (const example of examples) insert.run(example.id, example.contentHash, example.source, example.license ?? null, example.generator ?? null, JSON.stringify(example.parentIds), example.workflowRole ?? null, JSON.stringify(example.checks), manifest.createdAt, `${absolute}#L${example.sourceLine}`);
    hiveDb.prepare(`INSERT OR IGNORE INTO datasets (id,version,manifest_hash,ordered_example_ids_json,manifest_path,created_at,immutable) VALUES (?,?,?,?,?,?,1)`)
      .run(datasetId, manifest.version, manifestHash, JSON.stringify(expectedIds), manifestPath, manifest.createdAt);
    hiveDb.exec("COMMIT");
  } catch (error) { hiveDb.exec("ROLLBACK"); throw error; }
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

const ROLE_TOOLS: Record<HiveSpecialistRole, Set<string>> = {
  coordinator_planner: new Set(),
  coder_repairer: new Set(["list_files", "read_file", "read_file_outline", "grep", "write_file", "edit_file", "run_shell"]),
  verifier: new Set(["list_files", "read_file", "read_file_outline", "grep", "run_shell"]),
};

function nodeSpecialistRole(role: string): HiveSpecialistRole | null {
  if (["coordinator", "coordinator_planner", "planner", "comprehension"].includes(role)) return "coordinator_planner";
  if (["coder", "coder_repairer"].includes(role)) return "coder_repairer";
  if (role === "verifier") return "verifier";
  return null;
}

export function harvestWorkflowExamples(workflowId: string): { ids: string[]; verified: boolean } {
  const snapshot = workflowSnapshot(workflowId, 10_000);
  if (!snapshot) throw new Error("workflow not found");
  const finalAudit = snapshot.nodes.find((node) => node.nodeId === "final_audit")?.result?.verification;
  const verified = snapshot.workflow.status === "succeeded" && finalAudit?.passed === true;
  const ids: string[] = [];
  if (!verified) {
    for (const node of snapshot.nodes.filter((candidate) => candidate.status === "failed" || candidate.result?.failureCodes?.length)) {
      const role = nodeSpecialistRole(node.role); if (!role) continue;
      ids.push(proposeCorrectiveExample({
        content: { kind: "failure_diagnostic", objective: snapshot.workflow.envelope.objective, node: node.nodeId, role, failureCodes: node.result?.failureCodes || [], error: node.error, result: node.result },
        sourceWorkflowId: workflowId, workflowRole: role, checks: [],
      }));
    }
    return { ids, verified: false };
  }
  for (const node of snapshot.nodes) {
    const role = nodeSpecialistRole(node.role);
    if (!role || !node.result || node.status !== "succeeded" || node.result.failureCodes?.length) continue;
    if (role === "coordinator_planner" && node.nodeId !== "plan") continue;
    if (role === "verifier" && node.nodeId !== "final_review") continue;
    if (role === "coder_repairer") {
      if (!node.result.findings.some((finding) => finding.id === "mutation-proof")) continue;
      const verifiedAfter = node.nodeId === "core_implementation"
        ? snapshot.nodes.find((candidate) => candidate.nodeId === "core_checks")?.result?.verification?.passed
        : node.nodeId === "integration_delivery"
          ? snapshot.nodes.find((candidate) => candidate.nodeId === "checks")?.result?.verification?.passed
          : node.nodeId === "repair" ? node.result.verification?.passed : false;
      if (!verifiedAfter) continue;
    }
    const events = snapshot.events.filter((event) => event.nodeId === node.nodeId);
    const messages: Record<string, unknown>[] = [{
      role: "user",
      content: JSON.stringify({ objective: snapshot.workflow.envelope.objective, constraints: snapshot.workflow.envelope.constraints, requiredOutput: snapshot.workflow.envelope.requiredOutput, definitionOfDone: snapshot.workflow.envelope.definitionOfDone, ownedPackage: node.label }),
    }];
    const pending = new Map<string, { name: string; args: Record<string, unknown> }>();
    for (const event of events) {
      if (event.kind === "worker_tool_request") {
        const call = event.payload as { id?: string; name?: string; args?: Record<string, unknown> };
        if (!call.id || !call.name || !ROLE_TOOLS[role].has(call.name)) continue;
        pending.set(call.id, { name: call.name, args: call.args || {} });
        messages.push({ role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }] });
      } else if (event.kind === "worker_tool_result") {
        const result = event.payload as { id?: string; name?: string; ok?: boolean; output?: string };
        if (!result.id || !pending.has(result.id)) continue;
        messages.push({ role: "tool", tool_call_id: result.id, name: result.name || pending.get(result.id)!.name, content: String(result.output || "").slice(0, 8_000) });
      }
    }
    const rawOutput = events.filter((event) => event.kind === "worker_text" || event.kind === "stage_output").map((event) => String(event.payload || "")).join("");
    messages.push({ role: "assistant", content: rawOutput.trim() || node.result.summary });
    const tools = TOOL_DEFS.filter((definition) => ROLE_TOOLS[role].has(definition.function.name));
    ids.push(proposeCorrectiveExample({
      content: { messages, ...(tools.length ? { tools } : {}), _hive: { task_family: `workflow:${workflowId}`, checks: [{ code: "final_audit", passed: true }], parent_ids: [workflowId], generator: "verified-hive-trajectory" } },
      sourceWorkflowId: workflowId, workflowRole: role, parentIds: [workflowId], checks: ["final_audit_passed", "production_tool_schema"],
    }));
  }
  return { ids, verified: true };
}

export function exportApprovedRoleExamples(role: HiveSpecialistRole, filename: string): { path: string; rows: number; sha256: string } {
  if (!ROLE_TOOLS[role]) throw new Error("unknown specialist role");
  const safe = path.basename(filename).replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!safe.endsWith(".jsonl")) throw new Error("export filename must end in .jsonl");
  const rows = hiveDb.prepare("SELECT content_path FROM training_examples WHERE quarantine_status='approved' AND workflow_role=? ORDER BY id").all(role);
  const lines: string[] = [];
  for (const row of rows) {
    const [location, lineMarker] = String(row.content_path).split("#L");
    try {
      const source = fs.readFileSync(location, "utf8");
      const content = JSON.parse(lineMarker ? source.split("\n")[Number(lineMarker) - 1] : source);
      if (content?.messages) lines.push(stable(content));
    } catch { /* stale provenance remains visible but is not exported */ }
  }
  const serialized = lines.map((line) => line + "\n").join("");
  const target = path.join(process.cwd(), "..", "data", safe);
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") !== serialized) throw new Error("refusing to overwrite a different immutable role export");
  if (!fs.existsSync(target)) fs.writeFileSync(target, serialized, { flag: "wx" });
  return { path: target, rows: lines.length, sha256: sha(serialized) };
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
  const specialists = { candidate: 0, promoted: 0, rejected: 0 };
  const roleExamples: Record<HiveSpecialistRole, number> = { coordinator_planner: 0, coder_repairer: 0, verifier: 0 };
  for (const row of hiveDb.prepare("SELECT workflow_role, COUNT(*) AS n FROM training_examples WHERE quarantine_status='approved' GROUP BY workflow_role").all()) {
    const role = String(row.workflow_role || "") as HiveSpecialistRole;
    if (role in roleExamples) roleExamples[role] = Number(row.n || 0);
  }
  try {
    for (const file of fs.readdirSync(path.join(process.cwd(), "..", "models")).filter((name) => name.endsWith(".hive-adapter.json"))) {
      const status = JSON.parse(fs.readFileSync(path.join(process.cwd(), "..", "models", file), "utf8")).promotionStatus as keyof typeof specialists;
      if (status in specialists) specialists[status]++;
    }
  } catch { /* model directory may not exist on a fresh port */ }
  return { examples: count("training_examples"), datasets: count("datasets"), checkpoints: count("checkpoints"), specialists, roleExamples, quarantined: Number(hiveDb.prepare("SELECT COUNT(*) AS n FROM training_examples WHERE quarantine_status='quarantined'").get()?.n ?? 0) };
}
