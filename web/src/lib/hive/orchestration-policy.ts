import type { BudgetName, TaskEnvelope } from "./contracts.ts";
import { isSimpleArtifactTask } from "./task-runtime.ts";

export type WorkflowRoute = "direct_agent" | "iterative_research" | "staged_coding" | "custom";
export type WorkflowRouteDecision = {
  route: WorkflowRoute;
  templateId: string;
  features: {
    kind: "research" | "coding";
    simpleArtifact: boolean;
    externalEvidence: boolean;
    highRisk: boolean;
    requestedBudget: BudgetName;
    customWorkflow: boolean;
  };
  reason: string;
};

const EXTERNAL = /\b(https?:\/\/|research|look up|latest|current|official docs?|third.party|external api|release notes?|changelog)\b/i;
const HIGH_RISK = /\b(production|migration|security|authentication|payment|delete|medical|legal|financial|database schema|breaking change)\b/i;

export function chooseWorkflowRoute(
  kind: "research" | "coding",
  envelope: TaskEnvelope,
  budget: BudgetName,
  customTemplateId?: string,
): WorkflowRouteDecision {
  const combined = [
    envelope.objective,
    envelope.latestUserRequest,
    envelope.requiredOutput,
    ...envelope.constraints,
    ...envelope.definitionOfDone,
  ].filter(Boolean).join(" ");
  const features = {
    kind,
    simpleArtifact: kind === "coding" && isSimpleArtifactTask(envelope),
    externalEvidence: kind === "research" || EXTERNAL.test(combined),
    highRisk: HIGH_RISK.test(combined),
    requestedBudget: budget,
    customWorkflow: !!customTemplateId,
  };
  if (customTemplateId) return { route: "custom", templateId: customTemplateId, features, reason: "The operator supplied an explicit saved workflow." };
  if (kind === "research") return { route: "iterative_research", templateId: "research-v1", features, reason: "The requested outcome is evidence-backed research and requires iterative coverage checks." };
  if (features.simpleArtifact && !features.highRisk && !features.externalEvidence) {
    return { route: "direct_agent", templateId: "coding-direct-artifact-v1", features, reason: "A single bounded artifact can be implemented and browser-validated without specialist handoffs." };
  }
  return {
    route: "staged_coding",
    templateId: "coding-v2",
    features,
    reason: features.highRisk
      ? "Risk-sensitive coding requires independent planning and verification."
      : features.externalEvidence
        ? "External evidence is required before implementation."
        : "The task spans more than one bounded artifact or project concern.",
  };
}
