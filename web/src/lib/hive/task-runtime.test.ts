import assert from "node:assert/strict";
import test from "node:test";
import { emptyStageResult, HIVE_CONTRACT_VERSION, type TaskEnvelope, type WorkflowNode } from "./contracts.ts";
import { workflowTemplate } from "./presets.ts";
import { decideTaskVerdict, isSimpleArtifactTask, normalizeTaskEnvelope } from "./task-runtime.ts";

const envelope: TaskEnvelope = {
  version: HIVE_CONTRACT_VERSION,
  objective: "Produce the answer",
  constraints: [],
  artifactRefs: [],
  requiredOutput: "A report",
  definitionOfDone: ["Claim is supported"],
};
const retry = { maxAttempts: 1, backoffMs: 0, retryOn: [] };
const nodes: WorkflowNode[] = [
  { id: "gaps", label: "Gaps", role: "verifier", action: "model", dependsOn: [], retry },
  { id: "followup", label: "Follow-up", role: "researcher", action: "model", dependsOn: ["gaps"], optional: true, resolves: ["gaps"], retry },
  { id: "verify", label: "Verify", role: "verifier", action: "verify", dependsOn: ["followup"], retry },
];

test("normalizes concrete acceptance criteria and deliverables", () => {
  const normalized = normalizeTaskEnvelope(envelope);
  assert.equal(normalized.acceptanceCriteria?.[0]?.id, "requirement-1");
  assert.equal(normalized.acceptanceCriteria?.[0]?.state, "unknown");
  assert.equal(normalized.deliverables?.[0]?.description, "A report");
});

test("needs_followup cannot become complete when its owning route did not resolve it", () => {
  const result = decideTaskVerdict(envelope, nodes, [
    { nodeId: "gaps", status: "succeeded", result: { ...emptyStageResult("gap"), status: "needs_followup" } },
    { nodeId: "followup", status: "skipped", result: emptyStageResult("skipped") },
    { nodeId: "verify", status: "succeeded", result: { ...emptyStageResult("ok"), verification: { passed: true, checks: [{ code: "requirement-1", passed: true, detail: "evidence" }] } } },
  ], 1);
  assert.equal(result.outcome, "incomplete");
  assert.deepEqual(result.unresolvedNodeIds, ["gaps"]);
});

test("explicit successful resolver and criterion evidence permit completion", () => {
  const result = decideTaskVerdict(envelope, nodes, [
    { nodeId: "gaps", status: "succeeded", result: { ...emptyStageResult("gap"), status: "needs_followup" } },
    { nodeId: "followup", status: "succeeded", result: emptyStageResult("resolved") },
    { nodeId: "verify", status: "succeeded", result: { ...emptyStageResult("ok"), verification: { passed: true, checks: [{ code: "requirement-1", passed: true, detail: "evidence" }] } } },
  ], 1);
  assert.equal(result.outcome, "complete");
  assert.deepEqual(result.acceptanceEvidence, ["node:verify:check:requirement-1"]);
});

test("routes a single HTML artifact to the direct path", () => {
  const simple = { ...envelope, objective: "Create one file named index.html" };
  assert.equal(isSimpleArtifactTask(simple), true);
  assert.equal(workflowTemplate("coding", "normal", simple).id, "coding-direct-artifact-v1");
  assert.equal(isSimpleArtifactTask({ ...envelope, objective: "Migrate an existing multi-file project to a new backend" }), false);
});

test("research graph assigns ordinary upstream follow-up to gap resolution", () => {
  const spec = workflowTemplate("research", "normal", envelope);
  const resolver = spec.nodes.find((node) => node.id === "gap_resolution");
  assert.deepEqual(resolver?.resolves, ["intake", "decompose", "queries", "gaps", "followup"]);
});
