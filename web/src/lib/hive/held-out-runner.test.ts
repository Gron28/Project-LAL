import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHiveRelease } from "./evaluation.ts";
import { metricsFromTrajectories } from "./held-out-suite.ts";
import { runHeldOutEvaluation } from "./held-out-runner.ts";

test("the executable held-out suite measures 60 paired fixtures and passes every promotion gate", () => {
  const scores = runHeldOutEvaluation();
  assert.equal(scores.length, 120);
  assert.equal(scores.every((score) => score.events?.length && score.checks?.length), true);
  const measured = metricsFromTrajectories(scores);
  const gate = evaluateHiveRelease({
    ...measured,
    orchestration: { cases: 60, correct: 60, unauthorizedCoordinatorActions: 0, validStructuredOutputs: 60 },
    coreRegressionPoints: 0,
  });
  assert.equal(measured.research.heldOutTasks, 30);
  assert.equal(measured.coding.heldOutTasks, 30);
  assert.equal(gate.promotable, true, gate.gates.filter((item) => !item.passed).map((item) => item.code).join(", "));
});
