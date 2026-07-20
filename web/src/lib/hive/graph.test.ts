import assert from "node:assert/strict";
import test from "node:test";
import { HIVE_CONTRACT_VERSION, type WorkflowSpec } from "./contracts.ts";
import { projectWorkflowGraph } from "./graph.ts";

const spec: WorkflowSpec = {
  version: HIVE_CONTRACT_VERSION, id: "graph-test", kind: "coding", name: "Graph test", allowedFollowupActions: [],
  budget: { name: "normal", cycles: 1, inferenceTokens: 1, contextTokens: 1, modelSwaps: 0, retries: 0, researchCalls: 0 },
  nodes: [
    { id: "discover", label: "Discover", role: "planner", action: "read", dependsOn: [], retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] } },
    { id: "build", label: "Build", role: "coder", action: "edit", dependsOn: ["discover"], retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] } },
    { id: "verify", label: "Verify", role: "verifier", action: "test", dependsOn: ["build"], retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] } },
  ],
};

test("projects a validated DAG without making it executable", () => {
  const graph = projectWorkflowGraph(spec, [{ nodeId: "discover", status: "succeeded" }]);
  assert.equal(graph.valid, true);
  assert.deepEqual(graph.topologicalOrder, ["discover", "build", "verify"]);
  assert.equal(graph.nodes.find((node) => node.id === "discover")?.depth, 0);
  assert.equal(graph.nodes.find((node) => node.id === "build")?.runnable, true);
  assert.deepEqual(graph.nodes.find((node) => node.id === "verify")?.blockedBy, ["build"]);
  assert.deepEqual(graph.edges, [
    { from: "discover", to: "build", satisfied: true },
    { from: "build", to: "verify", satisfied: false },
  ]);
});

test("reports invalid cycles as a diagnostic-only projection", () => {
  const cyclic = structuredClone(spec);
  cyclic.nodes[0].dependsOn = ["verify"];
  const graph = projectWorkflowGraph(cyclic);
  assert.equal(graph.valid, false);
  assert.ok(graph.errors.some((error) => error.includes("cycle")));
  assert.equal(graph.summary.runnable, 0);
});
