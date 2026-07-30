import test from "node:test";
import assert from "node:assert/strict";
import { HIVE_CONTRACT_VERSION, type TaskEnvelope } from "./contracts.ts";
import { chooseWorkflowRoute } from "./orchestration-policy.ts";

const envelope = (objective: string, requiredOutput = "index.html"): TaskEnvelope => ({
  version: HIVE_CONTRACT_VERSION,
  objective,
  constraints: ["self-contained"],
  artifactRefs: [],
  requiredOutput,
  definitionOfDone: ["file exists", "browser checks pass"],
});

test("simple HTML uses the direct baseline with an inspectable reason", () => {
  const decision = chooseWorkflowRoute("coding", envelope("Create a self-contained HTML dashboard"), "normal");
  assert.equal(decision.route, "direct_agent");
  assert.match(decision.reason, /browser-validated/);
});

test("research, risky coding, and custom graphs route explicitly", () => {
  assert.equal(chooseWorkflowRoute("research", envelope("Investigate this"), "normal").route, "iterative_research");
  assert.equal(chooseWorkflowRoute("coding", envelope("Migrate the production database", "project changes"), "thorough").route, "staged_coding");
  assert.equal(chooseWorkflowRoute("coding", envelope("anything"), "normal", "saved-v4").route, "custom");
});
