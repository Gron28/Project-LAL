import assert from "node:assert/strict";
import test from "node:test";
import { HIVE_CONTRACT_VERSION, type WorkflowSpec } from "./contracts.ts";
import { compileWorkflowDefinition, definitionFromWorkflowSpec, workflowRevision } from "./graph-authoring.ts";

const spec: WorkflowSpec = {
  version: HIVE_CONTRACT_VERSION, id: "authoring-test", kind: "research", name: "Authoring test", allowedFollowupActions: ["retry"],
  budget: { name: "normal", cycles: 1, inferenceTokens: 10, contextTokens: 10, modelSwaps: 0, retries: 1, researchCalls: 1 },
  nodes: [
    { id: "intake", label: "Intake", role: "coordinator", action: "understand", dependsOn: [], retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] } },
    { id: "verify", label: "Verify", role: "verifier", action: "verify", dependsOn: ["intake"], retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] } },
  ],
};

test("fixed workflow imports and compiles with identical execution semantics", () => {
  const compiled = compileWorkflowDefinition(definitionFromWorkflowSpec(spec));
  assert.equal(compiled.ok, true);
  if (compiled.ok) assert.deepEqual(compiled.spec, spec);
});

test("layout is not revision identity and unsafe graph constructs cannot compile", () => {
  const definition = definitionFromWorkflowSpec(spec);
  const before = workflowRevision(definition);
  definition.layout = { intake: { x: 99, y: 4 } };
  assert.equal(workflowRevision(definition), before);
  definition.nodes[0].execution = { ...definition.nodes[0].execution, action: "write" };
  const bad = compileWorkflowDefinition(definition);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.errors.some((error) => error.includes("requires approval")));
});
