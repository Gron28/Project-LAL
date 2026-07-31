import test from "node:test";
import assert from "node:assert/strict";
import { HELD_OUT_FIXTURES, HELD_OUT_SUITE_ID, metricsFromTrajectories } from "./held-out-suite.ts";

test("versioned held-out suite contains 30 coding and 30 research cases", () => {
  assert.equal(HELD_OUT_SUITE_ID, "hive-held-out-v1");
  assert.equal(HELD_OUT_FIXTURES.filter((fixture) => fixture.domain === "coding").length, 30);
  assert.equal(HELD_OUT_FIXTURES.filter((fixture) => fixture.domain === "research").length, 30);
  assert.ok(new Set(HELD_OUT_FIXTURES.map((fixture) => fixture.category)).size >= 12);
});

test("release metrics are computed from trajectories rather than supplied rates", () => {
  const scores = HELD_OUT_FIXTURES.flatMap((fixture) => [
    { fixtureId: fixture.id, candidate: "workflow" as const, verifiedComplete: true, falseComplete: false, withinBudget: true, provenanceComplete: true, harmfulDuplicateSideEffect: false },
    { fixtureId: fixture.id, candidate: "baseline" as const, verifiedComplete: false, falseComplete: false, withinBudget: true, provenanceComplete: true, harmfulDuplicateSideEffect: false },
  ]);
  const metrics = metricsFromTrajectories(scores);
  assert.equal(metrics.coding.heldOutTasks, 30);
  assert.equal(metrics.research.verifiedCompletionRate, 1);
  assert.equal(metrics.falseCompletionRate, 0);
});
