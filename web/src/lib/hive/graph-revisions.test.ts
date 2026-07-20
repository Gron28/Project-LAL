import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HIVE_CONTRACT_VERSION, type WorkflowSpec } from "./contracts.ts";
import { definitionFromWorkflowSpec } from "./graph-authoring.ts";
import { WorkflowRevisionRepository } from "./graph-revisions.ts";

const spec: WorkflowSpec = { version: HIVE_CONTRACT_VERSION, id: "revision-test", kind: "research", name: "Revision test", allowedFollowupActions: [], budget: { name: "normal", cycles: 1, inferenceTokens: 1, contextTokens: 1, modelSwaps: 0, retries: 0, researchCalls: 0 }, nodes: [{ id: "read", label: "Read", role: "researcher", action: "read", dependsOn: [], retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] } }] };

test("published graph revisions are immutable scheduler inputs and clone to a new draft", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lal-graph-revisions-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); let now = 0;
  const repo = new WorkflowRevisionRepository({ databasePath: path.join(root, "revisions.sqlite"), now: () => ++now });
  const first = repo.publish(definitionFromWorkflowSpec(spec));
  assert.deepEqual(first.spec, spec);
  assert.equal(repo.publish(definitionFromWorkflowSpec(spec)).revision, first.revision);
  const draft = repo.cloneToDraft(spec.id, first.revision, "Add a reviewed branch");
  assert.equal(draft.parentRevision, first.revision);
  draft.name = "Revision test v2";
  const second = repo.publish(draft);
  assert.notEqual(second.revision, first.revision);
  assert.equal(repo.get(spec.id, first.revision)?.spec.name, "Revision test");
  assert.equal(repo.list(spec.id).length, 2);
});
