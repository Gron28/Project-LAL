import { HIVE_CONTRACT_VERSION, type BudgetName, type ResourceBudget, type RoleProfile, type WorkflowSpec } from "./contracts";

export const BUDGETS: Record<BudgetName, ResourceBudget> = {
  quick: { name: "quick", wallTimeMs: 2 * 60_000, inferenceTokens: 12_000, contextTokens: 8_192, modelSwaps: 0, retries: 1, researchCalls: 4, shallowVerification: true },
  standard: { name: "standard", wallTimeMs: 15 * 60_000, inferenceTokens: 80_000, contextTokens: 16_384, modelSwaps: 2, retries: 4, researchCalls: 16, shallowVerification: false },
  deep: { name: "deep", wallTimeMs: 60 * 60_000, inferenceTokens: 300_000, contextTokens: 32_768, modelSwaps: 4, retries: 12, researchCalls: 48, shallowVerification: false },
};

const context = { maxTokens: 8_192, artifactLimit: 8, evidenceLimit: 24, includeDependencyResults: true };
export const ROLE_PROFILES: Record<string, RoleProfile> = {
  coordinator: { id: "coordinator", version: 1, coordinator: true, prompt: "Choose only a bounded routing decision. Never perform worker work or request a worker tool.", permittedTools: [], modelRequirements: ["structured_output", "planning"], contextPolicy: context, evaluationSuite: "orchestrator" },
  comprehension: { id: "comprehension", version: 1, prompt: "Restate the objective, constraints, output contract, and ambiguities precisely. Requirements describe work still to do: never claim tests ran, files changed, evidence exists, or the task completed unless a dependency result proves it.", permittedTools: [], modelRequirements: ["chat"], contextPolicy: context, evaluationSuite: "instruct" },
  planner: { id: "planner", version: 1, prompt: "Create a compact, dependency-aware plan. Every step needs an observable definition of done. Never describe requested outcomes as already completed; only dependency artifacts and check results count as completed work.", permittedTools: ["list_files", "read_file", "read_file_outline", "grep"], modelRequirements: ["planning"], contextPolicy: context, evaluationSuite: "planning" },
  researcher: { id: "researcher", version: 1, prompt: "Decompose the question and identify source-quality requirements and likely contradictions.", permittedTools: [], modelRequirements: ["research", "planning"], contextPolicy: context, evaluationSuite: "research" },
  query_generator: { id: "query_generator", version: 1, prompt: "Generate 4 to 8 short, diverse web search queries. Put each query in a separate finding.text, under 18 words. Prefer primary-source domains and cover every major sub-question. Do not answer the research question.", permittedTools: [], modelRequirements: ["research", "structured_output"], contextPolicy: context, evaluationSuite: "research-query-generation" },
  reader: { id: "reader", version: 1, prompt: "Extract bounded claims only from supplied source snapshots. Preserve uncertainty and conflicts.", permittedTools: [], modelRequirements: ["chat", "research"], contextPolicy: context, evaluationSuite: "research-extraction" },
  synthesizer: { id: "synthesizer", version: 1, prompt: "Synthesize only supported claims. Attach evidence IDs to every factual finding and address contradictions.", permittedTools: [], modelRequirements: ["research", "planning"], contextPolicy: { ...context, evidenceLimit: 48 }, evaluationSuite: "research-synthesis" },
  coder: { id: "coder", version: 1, prompt: "Implement the approved plan stepwise in the workspace. Inspect before editing and verify actual files before claiming completion.", permittedTools: ["list_files", "read_file", "read_file_outline", "grep", "write_file", "edit_file", "run_shell"], modelRequirements: ["coding", "tools"], contextPolicy: context, evaluationSuite: "coding" },
  verifier: { id: "verifier", version: 1, prompt: "Audit the produced artifacts against every definition-of-done item. A claim without observable evidence fails.", permittedTools: ["list_files", "read_file", "read_file_outline", "grep"], modelRequirements: ["verification"], contextPolicy: context, evaluationSuite: "verification" },
};

const retry = { maxAttempts: 2, backoffMs: 250, retryOn: ["timeout", "backend", "invalid_output", "verification"] as ("timeout" | "backend" | "invalid_output" | "verification")[] };

export function researchWorkflow(budget: ResourceBudget = BUDGETS.standard): WorkflowSpec {
  return { version: HIVE_CONTRACT_VERSION, id: "research-v1", kind: "research", name: "Evidence-first research", budget, allowedFollowupActions: ["targeted_search", "reread_source"], nodes: [
    { id: "intake", label: "Intake / comprehension", role: "comprehension", action: "model", dependsOn: [], retry },
    { id: "decompose", label: "Question decomposition", role: "researcher", action: "model", dependsOn: ["intake"], retry },
    { id: "queries", label: "Search-query generation", role: "query_generator", action: "model", dependsOn: ["decompose"], retry },
    { id: "search", label: "Deterministic search", role: "researcher", action: "research_search", dependsOn: ["queries"], retry },
    { id: "read", label: "Independent source reading", role: "reader", action: "research_fetch", dependsOn: ["search"], retry },
    { id: "evidence", label: "Evidence ledger", role: "reader", action: "evidence_ledger", dependsOn: ["read"], retry, verificationGate: { requireEvidence: true } },
    { id: "gaps", label: "Contradiction and gap check", role: "verifier", action: "model", dependsOn: ["evidence"], retry },
    { id: "followup", label: "Targeted follow-up", role: "researcher", action: "research_followup", dependsOn: ["gaps"], optional: true, retry },
    { id: "synthesis", label: "Synthesis", role: "synthesizer", action: "model", dependsOn: ["evidence", "gaps", "followup"], retry },
    { id: "verify", label: "Citation verification", role: "verifier", action: "citation_verify", dependsOn: ["synthesis"], retry, verificationGate: { requireEvidence: true, minimumScore: .9 } },
  ] };
}

export function codingWorkflow(budget: ResourceBudget = BUDGETS.standard): WorkflowSpec {
  return { version: HIVE_CONTRACT_VERSION, id: "coding-v1", kind: "coding", name: "Verified coding", budget, allowedFollowupActions: ["repair", "rerun_checks"], nodes: [
    { id: "intake", label: "Task comprehension", role: "comprehension", action: "model", dependsOn: [], retry },
    { id: "map", label: "Repository map", role: "planner", action: "repo_map", dependsOn: ["intake"], retry },
    { id: "plan", label: "Implementation plan", role: "planner", action: "model", dependsOn: ["map"], retry },
    { id: "critique", label: "Plan critique", role: "verifier", action: "model", dependsOn: ["plan"], retry },
    { id: "implement", label: "Stepwise implementation", role: "coder", action: "worker_tools", dependsOn: ["critique"], retry },
    { id: "checks", label: "Tests and static checks", role: "verifier", action: "deterministic_checks", dependsOn: ["implement"], retry },
    { id: "audit", label: "Requirement audit", role: "verifier", action: "requirement_audit", dependsOn: ["checks"], retry, verificationGate: { requireTests: true, minimumScore: 1 } },
    { id: "repair", label: "Bounded repair", role: "coder", action: "repair", dependsOn: ["audit"], optional: true, retry },
    { id: "report", label: "Final report", role: "synthesizer", action: "final_report", dependsOn: ["audit", "repair"], retry, verificationGate: { requireTests: true } },
  ] };
}

export function workflowTemplate(kind: "research" | "coding", budgetName: BudgetName = "standard"): WorkflowSpec {
  return kind === "research" ? researchWorkflow(BUDGETS[budgetName]) : codingWorkflow(BUDGETS[budgetName]);
}
