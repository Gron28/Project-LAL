import test from "node:test";
import assert from "node:assert/strict";
import { HIVE_CONTRACT_VERSION, type TaskVerdict } from "./contracts.ts";
import { buildPostRunReport, redactPostRunReport } from "./post-run-report.ts";
import type { WorkflowRecord } from "./store.ts";

test("post-run reports are derived from durable facts and expose first divergence", () => {
  const verdict: TaskVerdict = { version: 1, outcome: "incomplete", reason: "check failed", criteria: [{ id: "c1", text: "works", state: "fail", evidenceIds: ["event:2"] }], acceptanceEvidence: ["event:2"], uncheckedProperties: ["visual polish"], unresolvedNodeIds: ["verify"], decidedAt: 3 };
  const workflow: WorkflowRecord = {
    id: "w", kind: "coding", templateId: "coding-v2", status: "incomplete",
    envelope: { version: HIVE_CONTRACT_VERSION, objective: "x", constraints: [], artifactRefs: [], requiredOutput: "x", definitionOfDone: ["works"] },
    spec: { version: 1, id: "coding-v2", kind: "coding", name: "x", nodes: [], allowedFollowupActions: [], budget: { name: "normal", cycles: 1, inferenceTokens: 1, contextTokens: 1, modelSwaps: 1, retries: 1, researchCalls: 1 } },
    budget: { name: "normal", cycles: 1, inferenceTokens: 1, contextTokens: 1, modelSwaps: 1, retries: 1, researchCalls: 1 },
    working: { verdict }, createdAt: 1, updatedAt: 4, startedAt: 1, finishedAt: 4,
  };
  const report = buildPostRunReport(workflow, [], [], [{ schemaVersion: 1, schemaKnown: true, eventId: "e", seq: 2, ts: 2, kind: "node_failed", traceId: "w", spanId: "s", payloadRedacted: false, payload: null }], 5);
  assert.equal(report.outcome.status, "incomplete");
  assert.equal(report.analysis.firstDivergence?.seq, 2);
  assert.deepEqual(report.provenance.eventRange, [2, 2]);
});

test("report exports redact likely credentials", () => {
  const input = { suggestedImprovements: ["token=abcdefghijklmnopqrstuvwxyz012345"] } as ReturnType<typeof buildPostRunReport>;
  assert.match(redactPostRunReport(input).suggestedImprovements[0], /REDACTED/);
});
