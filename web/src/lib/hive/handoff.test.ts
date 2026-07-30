import test from "node:test";
import assert from "node:assert/strict";
import { HIVE_CONTRACT_VERSION, type SpecialistHandoff, type TaskEnvelope } from "./contracts.ts";
import { taskContractDigest, validateHandoff } from "./handoff.ts";

const task: TaskEnvelope = { version: 1, objective: "Build it", constraints: [], artifactRefs: [], requiredOutput: "x", definitionOfDone: ["A", "B"] };
const handoff: SpecialistHandoff = {
  version: HIVE_CONTRACT_VERSION,
  target: { nodeId: "b", role: "coder", label: "Build" },
  task: { objective: task.objective, constraints: [], requiredOutput: "x", definitionOfDone: ["A", "B"] },
  contractDigest: taskContractDigest(task),
  included: ["task contract", "dependency summaries"],
  omitted: ["full model transcript"],
  linkedArtifactHashes: ["abc"],
  ownedPackage: "Build",
  dependencies: [{ nodeId: "a", role: "planner", status: "succeeded", summary: "plan", findings: [], artifacts: [{ hash: "abc", mediaType: "text/plain", size: 1 }], uncertainties: [], failureCodes: [] }],
  evidence: [], exactFailures: [], operatorGuidance: [], conversation: [], priorMission: null,
};

test("handoffs retain requirements and link source artifacts", () => assert.deepEqual(validateHandoff(handoff, task), []));
test("handoff loss is detected before downstream completion", () => {
  const lossy = structuredClone(handoff);
  lossy.task.definitionOfDone = ["A"];
  lossy.linkedArtifactHashes = [];
  assert.deepEqual(validateHandoff(lossy, task), ["missing requirement: B", "dependency artifacts are not linked: a"]);
});
