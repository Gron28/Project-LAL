import { HIVE_CONTRACT_VERSION, type BudgetName, type ResourceBudget, type RoleProfile, type WorkflowSpec } from "./contracts";

// Tiers are effort levels, not time limits — a local rig is slow on purpose and
// no mission dies because minutes elapsed. cycles = verify→repair passes the
// workflow may spend polishing (wired into the repair node's maxAttempts below).
// Token ceilings are generous backstops against a truly runaway loop, sized from
// observed runs (one worker_tools stage peaks ~8-20k with peak-prompt accounting).
export const BUDGETS: Record<BudgetName, ResourceBudget> = {
  normal: { name: "normal", cycles: 1, inferenceTokens: 150_000, contextTokens: 16_384, modelSwaps: 2, retries: 4, researchCalls: 16 },
  thorough: { name: "thorough", cycles: 3, inferenceTokens: 400_000, contextTokens: 32_768, modelSwaps: 4, retries: 8, researchCalls: 32 },
  extra: { name: "extra", cycles: 6, inferenceTokens: 1_000_000, contextTokens: 32_768, modelSwaps: 8, retries: 16, researchCalls: 64 },
};

const context = { maxTokens: 8_192, artifactLimit: 8, evidenceLimit: 24, includeDependencyResults: true };
export const ROLE_PROFILES: Record<string, RoleProfile> = {
  coordinator: { id: "coordinator", version: 1, coordinator: true, prompt: "Choose only a bounded routing decision. Never perform worker work or request a worker tool.", permittedTools: [], modelRequirements: ["structured_output", "planning"], contextPolicy: context, evaluationSuite: "orchestrator" },
  coordinator_planner: { id: "coordinator_planner", version: 1, coordinator: true, prompt: "Own decomposition and handoffs only. Translate the task contract and repository map into bounded implementation packages with explicit dependencies, file ownership, inputs, outputs, and one mechanical acceptance check each. Never edit files, run commands, or claim implementation occurred. Replan only from concrete verifier evidence.", permittedTools: [], modelRequirements: ["structured_output", "planning"], contextPolicy: context, evaluationSuite: "hive-coordinator-planner" },
  comprehension: { id: "comprehension", version: 1, prompt: "Restate the objective, constraints, output contract, and ambiguities precisely. Requirements describe work still to do: never claim tests ran, files changed, evidence exists, or the task completed unless a dependency result proves it.", permittedTools: [], modelRequirements: ["chat"], contextPolicy: context, evaluationSuite: "instruct" },
  planner: { id: "planner", version: 1, prompt: "Create a dependency-aware plan from evidence, not recalled assumptions. Break implementation into independently reviewable packages with file ownership, inputs, outputs, and a mechanical acceptance check for each. Every step needs an observable definition of done. Never describe requested outcomes as already completed; only dependency artifacts and check results count as completed work.", permittedTools: ["list_files", "read_file", "read_file_outline", "grep"], modelRequirements: ["planning"], contextPolicy: context, evaluationSuite: "planning" },
  researcher: { id: "researcher", version: 1, prompt: "Assume pre-trained knowledge may be stale. Decompose the task into research questions, identify primary sources and source-quality requirements, and name contradictions or implementation risks that must be resolved before planning.", permittedTools: [], modelRequirements: ["research", "planning"], contextPolicy: context, evaluationSuite: "research" },
  query_generator: { id: "query_generator", version: 1, prompt: "Generate 4 to 8 short, diverse web search queries. Put each query in a separate finding.text, under 18 words. Prefer primary-source domains and cover every major sub-question. Do not answer the research question.", permittedTools: [], modelRequirements: ["research", "structured_output"], contextPolicy: context, evaluationSuite: "research-query-generation" },
  reader: { id: "reader", version: 1, prompt: "Extract bounded claims only from supplied source snapshots. Preserve uncertainty and conflicts.", permittedTools: [], modelRequirements: ["chat", "research"], contextPolicy: context, evaluationSuite: "research-extraction" },
  synthesizer: { id: "synthesizer", version: 1, prompt: "Synthesize only supported claims. Attach evidence IDs to every factual finding and address contradictions.", permittedTools: [], modelRequirements: ["research", "planning"], contextPolicy: { ...context, evidenceLimit: 48 }, evaluationSuite: "research-synthesis" },
  coder: { id: "coder", version: 1, prompt: "Implement only the scoped package assigned to this stage. Read the evidence and plan handoff first so you are not disconnected from intent. Make the smallest coherent change, run the package's stated check, and leave the workspace in a working state for the next specialist. Call install_dependencies after creating package.json when a greenfield Node project needs declared packages. Never claim work owned by a later package.", permittedTools: ["list_files", "read_file", "read_file_outline", "grep", "write_file", "edit_file", "run_shell", "install_dependencies"], modelRequirements: ["coding", "tools"], contextPolicy: context, evaluationSuite: "coding" },
  coder_repairer: { id: "coder_repairer", version: 1, prompt: "Own implementation and repair only. Inspect before editing, make real scoped mutations, run the package's mechanical check after the final mutation, and use exact failure output rather than guesses. For a greenfield Node project, create package.json then call install_dependencies before running app checks. Delete or rewrite incorrect prior work when evidence requires it. Never claim success without a fresh passing check and never perform research or delegation.", permittedTools: ["list_files", "read_file", "read_file_outline", "grep", "write_file", "edit_file", "run_shell", "install_dependencies"], modelRequirements: ["coding", "tools"], contextPolicy: context, evaluationSuite: "hive-coder-repairer" },
  verifier: { id: "verifier", version: 1, prompt: "Audit the produced artifacts against every definition-of-done item. A claim without observable evidence fails. Identify missing deliverables, missing behavioral coverage, and assumptions that require research before implementation proceeds.", permittedTools: ["list_files", "read_file", "read_file_outline", "grep", "run_shell"], modelRequirements: ["verification"], contextPolicy: context, evaluationSuite: "verification" },
};

// 3 attempts, not 2: with the engine's escalating infra backoff, the third try
// lands ~1 min after a GPU wedge/backend crash — inside observed amdgpu-reset
// recovery time. Two hot attempts died inside the same 37s outage (2026-07-11).
const retry = { maxAttempts: 3, backoffMs: 250, retryOn: ["timeout", "backend", "invalid_output", "verification"] as ("timeout" | "backend" | "invalid_output" | "verification")[] };

export function researchWorkflow(budget: ResourceBudget = BUDGETS.normal): WorkflowSpec {
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

export function codingWorkflow(budget: ResourceBudget = BUDGETS.normal): WorkflowSpec {
  return { version: HIVE_CONTRACT_VERSION, id: "coding-v2", kind: "coding", name: "Evidence-first staged coding", budget, allowedFollowupActions: ["repair", "rerun_checks"], nodes: [
    { id: "intake", label: "Essential task understanding", role: "coordinator_planner", action: "model", dependsOn: [], retry },
    // The whole research prelude is optional: engine.shouldSkipOptional skips it
    // deterministically unless the envelope actually references external
    // evidence (URLs, third-party APIs, "latest", …). A stdlib-only greenfield
    // task paid ~450s of model stages here for zero fetched sources before.
    { id: "research_strategy", label: "Deep-research strategy", role: "researcher", action: "model", dependsOn: ["intake"], optional: true, retry },
    { id: "research_queries", label: "Evidence query design", role: "query_generator", action: "model", dependsOn: ["research_strategy"], optional: true, retry },
    { id: "research_search", label: "Source discovery", role: "researcher", action: "research_search", dependsOn: ["research_queries"], optional: true, retry },
    { id: "research_read", label: "Primary-source reading", role: "reader", action: "research_fetch", dependsOn: ["research_search"], optional: true, retry },
    { id: "evidence", label: "Evidence ledger", role: "reader", action: "evidence_ledger", dependsOn: ["research_read"], optional: true, retry },
    { id: "research_judge", label: "Research and assumption judge", role: "verifier", action: "model", dependsOn: ["evidence"], optional: true, retry },
    { id: "map", label: "Repository and environment map", role: "coordinator_planner", action: "repo_map", dependsOn: ["intake", "research_judge"], retry },
    { id: "plan", label: "Evidence-backed implementation packages", role: "coordinator_planner", action: "model", dependsOn: ["map", "evidence"], retry },
    { id: "plan_judge", label: "Plan and package judge", role: "verifier", action: "model", dependsOn: ["plan"], retry },
    { id: "test_contract", label: "Package 1 · acceptance tests and scaffold", role: "coder_repairer", action: "worker_tools", dependsOn: ["plan_judge"], retry },
    { id: "core_implementation", label: "Package 2 · core implementation", role: "coder_repairer", action: "worker_tools", dependsOn: ["test_contract"], retry },
    { id: "core_checks", label: "Package 2 · mechanical check", role: "verifier", action: "deterministic_checks", dependsOn: ["core_implementation"], retry },
    { id: "integration_delivery", label: "Package 3 · integration and delivery", role: "coder_repairer", action: "worker_tools", dependsOn: ["core_checks"], retry },
    { id: "checks", label: "Final deterministic checks", role: "verifier", action: "deterministic_checks", dependsOn: ["integration_delivery"], retry },
    { id: "acceptance_review", label: "Definition-of-done evidence review", role: "verifier", action: "verifier_tools", dependsOn: ["checks"], retry, verificationGate: { minimumScore: 1 } },
    { id: "audit", label: "Requirement audit", role: "verifier", action: "requirement_audit", dependsOn: ["checks", "acceptance_review"], retry, verificationGate: { requireTests: true, minimumScore: 1 } },
    // The budget's cycles tier is exactly this node's attempt allowance: each
    // attempt is one full repair pass ending in fresh deterministic checks.
    { id: "repair", label: "Bounded evidence-guided repair", role: "coder_repairer", action: "repair", dependsOn: ["audit"], optional: true, retry: { ...retry, maxAttempts: Math.max(1, budget.cycles) } },
    { id: "final_review", label: "Post-repair independent review", role: "verifier", action: "verifier_tools", dependsOn: ["repair"], retry, verificationGate: { minimumScore: 1 } },
    { id: "final_audit", label: "Final requirement audit", role: "verifier", action: "requirement_audit", dependsOn: ["checks", "repair", "final_review"], retry, verificationGate: { requireTests: true, minimumScore: 1 } },
    { id: "report", label: "Final evidence report", role: "verifier", action: "final_report", dependsOn: ["final_audit"], retry, verificationGate: { requireTests: true } },
  ] };
}

export function workflowTemplate(kind: "research" | "coding", budgetName: BudgetName = "normal"): WorkflowSpec {
  return kind === "research" ? researchWorkflow(BUDGETS[budgetName]) : codingWorkflow(BUDGETS[budgetName]);
}
