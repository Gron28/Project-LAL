import {
  HIVE_CONTRACT_VERSION,
  type AcceptanceCriterion,
  type StageResult,
  type TaskEnvelope,
  type TaskVerdict,
  type WorkflowNode,
} from "./contracts.ts";
import { evaluateSharedCompletion } from "@lal/protocol/agent-runtime";

export type VerdictNode = {
  nodeId: string;
  status: string;
  result?: StageResult;
};

export function normalizeTaskEnvelope(envelope: TaskEnvelope): TaskEnvelope {
  const definitionOfDone = envelope.definitionOfDone
    .map((item) => String(item).trim())
    .filter(Boolean);
  const supplied = envelope.acceptanceCriteria || [];
  const acceptanceCriteria: AcceptanceCriterion[] = definitionOfDone.map((text, index) => {
    const existing = supplied.find((criterion) => criterion.id === `requirement-${index + 1}`)
      || supplied.find((criterion) => criterion.text === text);
    return {
      id: existing?.id || `requirement-${index + 1}`,
      text,
      state: existing?.state || "unknown",
      evidenceIds: [...(existing?.evidenceIds || [])],
      ...(existing?.detail ? { detail: existing.detail } : {}),
    };
  });
  return {
    ...envelope,
    latestUserRequest: envelope.latestUserRequest?.trim() || envelope.objective,
    definitionOfDone,
    deliverables: envelope.deliverables?.length
      ? envelope.deliverables
      : [{ id: "primary-output", description: envelope.requiredOutput, required: true }],
    acceptanceCriteria,
    unverifiableProperties: envelope.unverifiableProperties || [],
    permissions: envelope.permissions || [],
  };
}

export function isSimpleArtifactTask(envelope: TaskEnvelope): boolean {
  const text = [
    envelope.objective,
    envelope.requiredOutput,
    ...envelope.definitionOfDone,
    ...envelope.constraints,
  ].join(" ");
  const singleHtml = /\b(single[- ]file|one file|index\.html|\.html\b)/i.test(text);
  const complexity = /\b(existing (?:project|repository|codebase)|migration|multi[- ]file|backend|database|authentication|deploy|research|latest|third[- ]party)\b/i.test(text);
  const requiredDeliverables = envelope.deliverables?.filter((item) => item.required).length || 1;
  return singleHtml && !complexity && requiredDeliverables === 1;
}

function criterionResults(envelope: TaskEnvelope, nodes: VerdictNode[]): AcceptanceCriterion[] {
  const normalized = normalizeTaskEnvelope(envelope);
  const audits = [...nodes].reverse().filter((node) =>
    ["report", "final_audit", "audit", "verify"].includes(node.nodeId)
    && node.result?.verification,
  );
  return (normalized.acceptanceCriteria || []).map((criterion, index) => {
    const source = audits.find((node) => node.result?.verification?.checks.some((candidate) =>
      candidate.code === criterion.id || candidate.code === `requirement-${index + 1}`));
    const check = source?.result?.verification?.checks.find((candidate) =>
      candidate.code === criterion.id || candidate.code === `requirement-${index + 1}`);
    if (!check) return { ...criterion, state: "unknown", evidenceIds: [] };
    return {
      ...criterion,
      state: check.passed ? "pass" : "fail",
      evidenceIds: [`node:${source!.nodeId}:check:${check.code}`],
      detail: check.detail,
    };
  });
}

export function decideTaskVerdict(
  envelope: TaskEnvelope,
  specNodes: WorkflowNode[],
  nodes: VerdictNode[],
  now = Date.now(),
): TaskVerdict {
  const criteria = criterionResults(envelope, nodes);
  const requiredNodeIds = new Set(specNodes.filter((node) => !node.optional).map((node) => node.id));
  const unresolvedNodeIds = nodes
    .filter((node) => {
      if (node.status === "failed" || node.status === "cancelled") return requiredNodeIds.has(node.nodeId);
      if (!["needs_followup", "blocked"].includes(node.result?.status || "")) return false;
      return !nodes.some((candidate) => {
        const definition = specNodes.find((item) => item.id === candidate.nodeId);
        return definition?.resolves?.includes(node.nodeId)
          && candidate.status === "succeeded"
          && candidate.result?.status === "succeeded";
      });
    })
    .map((node) => node.nodeId);
  const blocked = nodes.some((node) => node.result?.status === "blocked");
  const failed = nodes.some((node) => requiredNodeIds.has(node.nodeId) && node.status === "failed");
  const finalGate = [...nodes].reverse().find((node) =>
    ["report", "final_audit", "verify"].includes(node.nodeId)
    && node.result?.verification,
  );
  const verified = finalGate?.result?.verification?.passed === true;
  const sharedVerdict = evaluateSharedCompletion({
    ...(failed ? { executionFault: "A required runtime stage failed." } : {}),
    ...(blocked ? { blockedReason: "A stage requires named external input or authority." } : {}),
    unresolvedWorkIds: unresolvedNodeIds,
    criteria,
    requiredVerificationPassed: verified && criteria.length > 0,
  });
  const outcome = sharedVerdict.outcome;
  const uncheckedProperties = [
    ...(normalizeTaskEnvelope(envelope).unverifiableProperties || []),
    ...criteria.filter((criterion) => criterion.state === "unknown").map((criterion) => criterion.text),
  ];
  return {
    version: HIVE_CONTRACT_VERSION,
    outcome,
    reason: sharedVerdict.reason,
    criteria,
    acceptanceEvidence: criteria.flatMap((criterion) => criterion.evidenceIds),
    uncheckedProperties,
    unresolvedNodeIds,
    decidedAt: now,
  };
}
