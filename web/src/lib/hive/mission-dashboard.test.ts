import test from "node:test";
import assert from "node:assert/strict";
import { buildMissionDashboard } from "./mission-dashboard.ts";
import type { WorkflowRecord } from "./store.ts";

test("dashboard facts link back to durable event IDs", () => {
  const workflow = {
    id: "w", kind: "coding", templateId: "direct", status: "running", createdAt: 1, updatedAt: 2,
    envelope: { version: 1, objective: "build", constraints: [], artifactRefs: [], requiredOutput: "x", definitionOfDone: ["works"] },
    spec: { version: 1, id: "direct", kind: "coding", name: "direct", nodes: [], allowedFollowupActions: [], budget: { name: "normal", cycles: 1, inferenceTokens: 1, contextTokens: 1, modelSwaps: 1, retries: 1, researchCalls: 1 } },
    budget: { name: "normal", cycles: 1, inferenceTokens: 1, contextTokens: 1, modelSwaps: 1, retries: 1, researchCalls: 1 }, working: {},
  } as WorkflowRecord;
  const dashboard = buildMissionDashboard(workflow, [], [], [{ schemaVersion: 1, schemaKnown: true, eventId: "evt-1", seq: 1, ts: 1, kind: "node_skipped", nodeId: "x", traceId: "w", spanId: "s", payloadRedacted: false, payload: { reason: "not needed" } }], 3);
  assert.equal(dashboard.graph.skipReasons[0].eventId, "evt-1");
  assert.equal(dashboard.ledgerHealth.sequenceGap, false);
  assert.equal(dashboard.graph.criticalPathMs, 0);
});

test("critical path follows dependencies instead of summing parallel nodes", () => {
  const budget = { name: "normal" as const, cycles: 1, inferenceTokens: 1, contextTokens: 1, modelSwaps: 1, retries: 1, researchCalls: 1 };
  const workflow = {
    id: "w", kind: "coding", templateId: "parallel", status: "complete", createdAt: 1, updatedAt: 30, startedAt: 1, finishedAt: 30,
    envelope: { version: 1, objective: "build", constraints: [], artifactRefs: [], requiredOutput: "x", definitionOfDone: ["works"] },
    spec: {
      version: 1, id: "parallel", kind: "coding", name: "parallel", allowedFollowupActions: [], budget,
      nodes: [
        { id: "a", label: "a", role: "coder", action: "model", dependsOn: [], retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] } },
        { id: "b", label: "b", role: "coder", action: "model", dependsOn: [], retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] } },
        { id: "c", label: "c", role: "verifier", action: "model", dependsOn: ["a", "b"], retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] } },
      ],
    },
    budget, working: {},
  } as WorkflowRecord;
  const node = (nodeId: string, durationMs: number) => ({
    nodeId, label: nodeId, role: "coder", action: "model", status: "succeeded" as const, attempt: 1,
    durationMs, promptTokens: 0, completionTokens: 0, contextTokens: 0, swapMs: 0, adapterMs: 0, toolCalls: 0, idempotencyKey: nodeId,
  });
  const dashboard = buildMissionDashboard(workflow, [node("a", 10), node("b", 20), node("c", 5)], [], [], 30);
  assert.equal(dashboard.graph.criticalPathMs, 25);
});

test("research sources expose provenance, authority, and freshness", () => {
  const workflow = {
    id: "w", kind: "research", templateId: "research", status: "running", createdAt: 1, updatedAt: 2,
    envelope: { version: 1, objective: "research", constraints: [], artifactRefs: [], requiredOutput: "x", definitionOfDone: ["grounded"] },
    spec: { version: 1, id: "research", kind: "research", name: "research", nodes: [], allowedFollowupActions: [], budget: { name: "normal", cycles: 1, inferenceTokens: 1, contextTokens: 1, modelSwaps: 1, retries: 1, researchCalls: 1 } },
    budget: { name: "normal", cycles: 1, inferenceTokens: 1, contextTokens: 1, modelSwaps: 1, retries: 1, researchCalls: 1 }, working: {},
  } as WorkflowRecord;
  const dashboard = buildMissionDashboard(
    workflow,
    [],
    [{ id: "ev-1", url: "https://adk.dev/evaluate/", retrievedAt: 40, sourceHash: "hash", excerpt: "evaluation", stance: "supporting" }],
    [{ schemaVersion: 1, schemaKnown: true, eventId: "evt-source", seq: 1, ts: 41, kind: "source_classified", nodeId: "read", traceId: "w", spanId: "s", payloadRedacted: false, payload: { evidenceId: "ev-1", sourceClass: "primary", authorityScore: 0.9 } }],
    100,
  );
  assert.deepEqual(dashboard.research.sources[0], {
    evidenceId: "ev-1",
    eventId: "evt-source",
    url: "https://adk.dev/evaluate/",
    origin: "https://adk.dev",
    stance: "supporting",
    claim: undefined,
    retrievedAt: 40,
    ageMs: 60,
    sourceClass: "primary",
    authorityScore: 0.9,
  });
});
