import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkflowSpec } from "./contracts.ts";
import { compileWorkflowDefinition, type WorkflowDefinition, type GraphCompileResult } from "./graph-authoring.ts";

export type PublishedWorkflowRevision = {
  workflowId: string;
  revision: string;
  parentRevision?: string;
  definition: WorkflowDefinition;
  spec: WorkflowSpec;
  createdAt: number;
};

/** Separate durable authoring store. The scheduler only receives `spec` copied
 * at run creation, so later canvas edits cannot mutate a running workflow. */
export class WorkflowRevisionRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(options: { databasePath: string; now?: () => number }) {
    if (!path.isAbsolute(options.databasePath)) throw new Error("workflow revision databasePath must be absolute");
    fs.mkdirSync(path.dirname(options.databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.databasePath, { timeout: 5_000 }); this.now = options.now ?? Date.now;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workflow_graph_revisions (
        workflow_id TEXT NOT NULL, revision TEXT NOT NULL, parent_revision TEXT,
        definition_json TEXT NOT NULL, spec_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_graph_revisions_created ON workflow_graph_revisions(workflow_id, created_at DESC);`);
  }
  private record(row: Record<string, unknown>): PublishedWorkflowRevision {
    return { workflowId: String(row.workflow_id), revision: String(row.revision), ...(row.parent_revision ? { parentRevision: String(row.parent_revision) } : {}), definition: JSON.parse(String(row.definition_json)) as WorkflowDefinition, spec: JSON.parse(String(row.spec_json)) as WorkflowSpec, createdAt: Number(row.created_at) };
  }
  validate(definition: WorkflowDefinition): GraphCompileResult { return compileWorkflowDefinition(definition); }
  publish(definition: WorkflowDefinition): PublishedWorkflowRevision {
    const compiled = compileWorkflowDefinition(definition);
    if (!compiled.ok) throw new Error(`workflow draft cannot publish: ${compiled.errors.join("; ")}`);
    const existing = this.get(definition.id, compiled.revision);
    if (existing) return existing;
    if (definition.parentRevision && !this.get(definition.id, definition.parentRevision)) throw new Error("parent workflow revision does not exist");
    const createdAt = this.now();
    this.db.prepare("INSERT INTO workflow_graph_revisions (workflow_id,revision,parent_revision,definition_json,spec_json,created_at) VALUES (?,?,?,?,?,?)")
      .run(definition.id, compiled.revision, definition.parentRevision ?? null, JSON.stringify(definition), JSON.stringify(compiled.spec), createdAt);
    return { workflowId: definition.id, revision: compiled.revision, ...(definition.parentRevision ? { parentRevision: definition.parentRevision } : {}), definition, spec: compiled.spec, createdAt };
  }
  get(workflowId: string, revision: string): PublishedWorkflowRevision | null {
    const row = this.db.prepare("SELECT * FROM workflow_graph_revisions WHERE workflow_id=? AND revision=?").get(workflowId, revision) as Record<string, unknown> | undefined;
    return row ? this.record(row) : null;
  }
  list(workflowId: string): PublishedWorkflowRevision[] {
    return this.db.prepare("SELECT * FROM workflow_graph_revisions WHERE workflow_id=? ORDER BY created_at DESC, revision DESC").all(workflowId).map((row) => this.record(row));
  }
  cloneToDraft(workflowId: string, revision: string, changeNote: string): WorkflowDefinition {
    const existing = this.get(workflowId, revision);
    if (!existing) throw new Error("workflow revision not found");
    if (!changeNote.trim()) throw new Error("draft change note is required");
    return structuredClone({ ...existing.definition, parentRevision: existing.revision, changeNote });
  }
}
