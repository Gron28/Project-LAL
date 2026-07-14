import { HIVE_CONTRACT_VERSION, validateRoutingDecision, validateWorkflowSpec, type ModelProfile, type RoutingDecision } from "./contracts";
import { ROLE_PROFILES, codingWorkflow, researchWorkflow } from "./presets";
import { evaluateHiveRelease, evaluateSpecialistAdapterPromotion } from "./evaluation";
import { rankEligibleModels } from "./model-registry";
import { appendToolResultNudge, hasValidMinistralRoleOrder, toolOutputSucceeded, type ToolLoopMsg } from "../toolloop";
import { destructiveShellCommand, validateToolArguments } from "../tools";

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
  const profile = (id: string, model: string, extra: Partial<ModelProfile> = {}): ModelProfile => ({ id, model, provider: "llama.cpp", versionHash: id, capabilities: ["chat", "coding", "tools"], structuredOutput: "json_schema", contextCeiling: 8192, backendCompatible: true, probeStatus: "verified", measuredTokensPerSecond: 20, ...extra });
  const routerWinner = rankEligibleModels([
    profile("general", "general-instruct"),
    profile("code", "specialist-coder", { roleScores: { coder: { score: .92, samples: 12, updatedAt: 1 } } }),
  ], ["coding", "tools"], undefined, "coder")[0];
  const routerCallable = routerWinner?.id === "code";
  const specialistBase = profile("base", "qwen3-4b-stock");
  const specialistCoder = profile("adapter:coder", "qwen3-4b-stock", { specialist: { id: "coder", role: "coder_repairer", baseModel: "qwen3-4b-stock", baseVersionHash: "base", adapterHash: "adapter", adapterPath: "/tmp/coder.gguf", adapterSize: 1, adapterMtimeMs: 1, trainingRunId: "run", datasetManifestHash: "dataset", promotionStatus: "promoted", evaluation: { heldOutRoleImprovementPoints: 8, coreRegressionPoints: 1, schemaTestsPassed: true, toolTestsPassed: true, heldOutTasks: 30, seeds: 2, unauthorizedActions: 0, falseCompletionRate: .01, adapterCompatible: true } } });
  const specialistVerifier = profile("adapter:verifier", "qwen3-4b-stock", { specialist: { ...specialistCoder.specialist!, id: "verifier", role: "verifier" } });
  const roleIsolation = rankEligibleModels([specialistBase, specialistCoder, specialistVerifier], ["coding", "tools"], undefined, "coder_repairer")[0]?.id === specialistCoder.id
    && !rankEligibleModels([specialistBase, specialistCoder, specialistVerifier], ["coding", "tools"], undefined, "verifier").some((candidate) => candidate.id === specialistCoder.id);
  const coding = codingWorkflow();
  const threeRoleCore = coding.nodes.filter((node) => ["intake", "map", "plan", "plan_judge", "test_contract", "core_implementation", "integration_delivery", "acceptance_review", "repair", "final_review"].includes(node.id)).every((node) => ["coordinator_planner", "coder_repairer", "verifier"].includes(node.role));
  const verifierReadOnly = !ROLE_PROFILES.verifier.permittedTools.some((tool) => ["write_file", "edit_file"].includes(tool));
  const finalAudit = coding.nodes.find((node) => node.id === "final_audit");
  const postRepairVerified = !!finalAudit && finalAudit.dependsOn.includes("repair") && finalAudit.dependsOn.includes("final_review");
  const adapterPromotionGate = evaluateSpecialistAdapterPromotion({ heldOutRoleImprovementPoints: 5, coreRegressionPoints: 2, schemaTestsPassed: true, toolTestsPassed: true, heldOutTasks: 30, seeds: 2, unauthorizedActions: 0, falseCompletionRate: .05, adapterCompatible: true }).promotable;
  const releaseGateProbe = evaluateHiveRelease({
    orchestration: { cases: cases.length, correct, unauthorizedCoordinatorActions: coordinatorIsolated ? 0 : 1, validStructuredOutputs: cases.length },
    research: { heldOutTasks: 30, verifiedCompletionRate: .8, bestSingleModelRate: .69 },
    coding: { heldOutTasks: 30, verifiedCompletionRate: .8, bestSingleModelRate: .69 },
    coreRegressionPoints: 2, withinBudgetRate: .9, restartExactlyOnce: true, completeProvenance: true,
  });
  const ministralToolTranscript: ToolLoopMsg[] = [
    { role: "system", content: "test" },
    { role: "user", content: "inspect the project" },
    { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call-1", name: "read_file", content: "file contents" },
  ];
  const ministralNudgeAttached = appendToolResultNudge(ministralToolTranscript, "make an edit now")
    && hasValidMinistralRoleOrder(ministralToolTranscript)
    && ministralToolTranscript.at(-1)?.content?.includes("make an edit now");
  const toolProtocolPathGuard = validateToolArguments("write_file", {
    path: "app/page.tsxx}[TOOL_CALLS]write_file[ARGS]{",
    content: "export default function Page() { return null; }",
  })?.includes("leaked tool-protocol syntax") === true
    && validateToolArguments("write_file", { path: "app/page.tsx", content: "" }) === null;
  const noOpEditGuard = validateToolArguments("edit_file", {
    path: "app/page.tsx",
    search: "broken text",
    replace: "broken text",
  })?.includes("would not change the file") === true;
  const shellExitGuard = !toolOutputSucceeded("run_shell", "build failed\n[exit 1]")
    && !toolOutputSucceeded("run_shell", "\n[timed out after 60s]")
    && toolOutputSucceeded("run_shell", "build passed\n[exit 0]");
  const dependencySecurityGuard = !toolOutputSucceeded("install_dependencies", "added packages\n1 critical vulnerability\n[exit 0]")
    && !toolOutputSucceeded("install_dependencies", "2 vulnerabilities (1 moderate, 1 critical)\n[exit 0]")
    && !toolOutputSucceeded("install_dependencies", "npm warn deprecated next: security vulnerability\n[exit 0]")
    && toolOutputSucceeded("install_dependencies", "added packages\n0 vulnerabilities\n[exit 0]");
  const destructiveShellGuard = destructiveShellCommand("rm -rf .next")
    && destructiveShellCommand("npm test && rm --recursive build")
    && !destructiveShellCommand("npm run build")
    && !destructiveShellCommand("rm stale.txt");
  return {
    passed: correct === cases.length && cases.length >= 25 && coordinatorIsolated && graphSchemasValid && routerCallable && roleIsolation && threeRoleCore && verifierReadOnly && postRepairVerified && adapterPromotionGate && releaseGateProbe.promotable && ministralNudgeAttached && toolProtocolPathGuard && noOpEditGuard && shellExitGuard && dependencySecurityGuard && destructiveShellGuard,
    routing: { cases: cases.length, correct, accuracy: correct / cases.length, roleAwareModelRouter: routerCallable, specialistRoleIsolation: roleIsolation }, coordinatorIsolated, graphSchemasValid, threeRoleCore, verifierReadOnly, postRepairVerified, adapterPromotionGate,
    failures: cases.filter((c) => c.actual !== c.expected), ministralNudgeAttached, toolProtocolPathGuard, noOpEditGuard, shellExitGuard, dependencySecurityGuard, destructiveShellGuard, releaseGateLogic: { syntheticBoundaryTest: true, ...releaseGateProbe },
  };
}
