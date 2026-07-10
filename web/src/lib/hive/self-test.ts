import { HIVE_CONTRACT_VERSION, validateRoutingDecision, validateWorkflowSpec, type RoutingDecision } from "./contracts";
import { ROLE_PROFILES, codingWorkflow, researchWorkflow } from "./presets";
import { evaluateHiveRelease } from "./evaluation";

export function runHiveContractSelfTest() {
  const specs = [researchWorkflow(), codingWorkflow()];
  const cases: { name: string; expected: boolean; actual: boolean }[] = [];
  for (const spec of specs) {
    for (const node of spec.nodes) {
      const decision: RoutingDecision = { version: HIVE_CONTRACT_VERSION, action: "dispatch", targetNodeId: node.id, reason: "test dependency-ready dispatch", uncertainty: 0 };
      cases.push({ name: `${spec.kind}:dispatch:${node.id}`, expected: true, actual: validateRoutingDecision(decision, spec) });
    }
    for (const action of ["retry", "verify", "replan"] as const) {
      const decision: RoutingDecision = { version: HIVE_CONTRACT_VERSION, action, targetNodeId: spec.nodes[0].id, reason: `test ${action}`, uncertainty: .25 };
      cases.push({ name: `${spec.kind}:${action}`, expected: true, actual: validateRoutingDecision(decision, spec) });
    }
    for (const action of ["finish", "request_user"] as const) {
      const decision: RoutingDecision = { version: HIVE_CONTRACT_VERSION, action, reason: `test ${action}`, uncertainty: .1 };
      cases.push({ name: `${spec.kind}:${action}`, expected: true, actual: validateRoutingDecision(decision, spec) });
    }
    cases.push({ name: `${spec.kind}:reject-invented-node`, expected: false, actual: validateRoutingDecision({ version: 1, action: "dispatch", targetNodeId: "invented", reason: "bad", uncertainty: 0 }, spec) });
    cases.push({ name: `${spec.kind}:reject-invented-followup`, expected: false, actual: validateRoutingDecision({ version: 1, action: "replan", followupAction: "arbitrary_shell", reason: "bad", uncertainty: 0 }, spec) });
  }
  const correct = cases.filter((c) => c.actual === c.expected).length;
  const coordinatorIsolated = ROLE_PROFILES.coordinator.permittedTools.length === 0 && !!ROLE_PROFILES.coordinator.coordinator;
  const graphSchemasValid = specs.every((spec) => validateWorkflowSpec(spec).length === 0);
  const releaseGateProbe = evaluateHiveRelease({
    orchestration: { cases: cases.length, correct, unauthorizedCoordinatorActions: coordinatorIsolated ? 0 : 1, validStructuredOutputs: cases.length },
    research: { heldOutTasks: 30, verifiedCompletionRate: .8, bestSingleModelRate: .69 },
    coding: { heldOutTasks: 30, verifiedCompletionRate: .8, bestSingleModelRate: .69 },
    coreRegressionPoints: 2, withinBudgetRate: .9, restartExactlyOnce: true, completeProvenance: true,
  });
  return {
    passed: correct === cases.length && cases.length >= 25 && coordinatorIsolated && graphSchemasValid && releaseGateProbe.promotable,
    routing: { cases: cases.length, correct, accuracy: correct / cases.length }, coordinatorIsolated, graphSchemasValid,
    failures: cases.filter((c) => c.actual !== c.expected), releaseGateLogic: { syntheticBoundaryTest: true, ...releaseGateProbe },
  };
}
