import type { TaskVerdict } from "./contracts";
import type { HiveEvent, WorkflowNodeRecord, WorkflowRecord } from "./store";
import type { EvidenceRecord } from "./contracts";

export type PostRunReport = {
  schemaVersion: 1;
  workflowId: string;
  generatedAt: number;
  outcome: { status: string; reason: string; deliverables: string[] };
  requirements: { id: string; requirement: string; state: string; evidence: string[]; detail?: string }[];
  changesOrKnowledge: { nodeId: string; summary: string; artifacts: string[] }[];
  checks: { nodeId: string; code: string; passed: boolean; detail: string }[];
  uncheckedProperties: string[];
  claimSourceMatrix: { claim: string; evidenceIds: string[]; sources: string[]; stance: string }[];
  execution: {
    durationMs: number;
    criticalPathMs: number;
    promptTokens: number;
    completionTokens: number;
    toolCalls: number;
    modelSwapMs: number;
  };
  recovery: { failures: number; retries: number; interventions: number; events: string[] };
  analysis: { firstDivergence?: { seq: number; kind: string; nodeId?: string }; wastedWorkMs: number };
  baseline: { applicable: string; comparisonAvailable: boolean; note: string };
  suggestedImprovements: string[];
  provenance: {
    templateId: string;
    specVersion: number;
    modelVersions: string[];
    eventRange: [number, number] | [];
    checkpoint: string;
    environment: { platform: string; architecture: string; node: string };
  };
};

export function buildPostRunReport(
  workflow: WorkflowRecord,
  nodes: WorkflowNodeRecord[],
  evidence: EvidenceRecord[],
  events: HiveEvent[],
  generatedAt = Date.now(),
): PostRunReport {
  const verdict = workflow.working.verdict as TaskVerdict | undefined;
  const checks = nodes.flatMap((node) => (node.result?.verification?.checks || []).map((check) => ({ nodeId: node.nodeId, ...check })));
  const failures = events.filter((event) => /failed|error/.test(event.kind));
  const interventions = events.filter((event) => event.lifecycle === "operator_intervention" || /manual_override|operator_message|approval/.test(event.kind));
  const retries = nodes.reduce((sum, node) => sum + Math.max(0, node.attempt - 1), 0);
  const firstDivergence = events.find((event) => /failed|context_loss|budget_exhausted|rejected/.test(event.kind));
  const modelVersions = [...new Set(nodes.map((node) => node.modelVersion).filter((value): value is string => !!value))];
  const eventRange: [number, number] | [] = events.length ? [events[0].seq, events.at(-1)!.seq] : [];
  const requirements = (verdict?.criteria || workflow.envelope.acceptanceCriteria || []).map((criterion) => ({
    id: criterion.id,
    requirement: criterion.text,
    state: criterion.state,
    evidence: criterion.evidenceIds,
    ...(criterion.detail ? { detail: criterion.detail } : {}),
  }));
  const failedChecks = checks.filter((check) => !check.passed);
  const suggestions = [
    ...(firstDivergence ? [`Investigate the first divergence at event ${firstDivergence.seq} (${firstDivergence.kind}).`] : []),
    ...(retries ? [`Reduce or better target the ${retries} retry attempt(s) using recorded failure evidence.`] : []),
    ...(failedChecks.length ? [`Improve acceptance or repair handling for: ${[...new Set(failedChecks.map((check) => check.code))].join(", ")}.`] : []),
    ...((verdict?.uncheckedProperties || []).length ? ["Add deterministic validators for currently unchecked properties."] : []),
  ];
  return {
    schemaVersion: 1,
    workflowId: workflow.id,
    generatedAt,
    outcome: {
      status: verdict?.outcome || workflow.status,
      reason: verdict?.reason || workflow.error || "No runtime verdict has been recorded.",
      deliverables: (workflow.envelope.deliverables || []).map((item) => item.path || item.description),
    },
    requirements,
    changesOrKnowledge: nodes.filter((node) => node.result).map((node) => ({
      nodeId: node.nodeId,
      summary: node.result!.summary,
      artifacts: node.result!.artifacts.map((artifact) => artifact.hash),
    })),
    checks,
    uncheckedProperties: verdict?.uncheckedProperties || workflow.envelope.unverifiableProperties || [],
    claimSourceMatrix: evidence.map((item) => ({
      claim: item.claim || "",
      evidenceIds: [item.id],
      sources: [item.url],
      stance: item.stance,
    })),
    execution: {
      durationMs: Math.max(0, (workflow.finishedAt || workflow.updatedAt) - (workflow.startedAt || workflow.createdAt)),
      criticalPathMs: nodes.reduce((sum, node) => sum + (node.durationMs || 0), 0),
      promptTokens: nodes.reduce((sum, node) => sum + node.promptTokens, 0),
      completionTokens: nodes.reduce((sum, node) => sum + node.completionTokens, 0),
      toolCalls: nodes.reduce((sum, node) => sum + node.toolCalls, 0),
      modelSwapMs: nodes.reduce((sum, node) => sum + node.swapMs, 0),
    },
    recovery: {
      failures: failures.length,
      retries,
      interventions: interventions.length,
      events: [...failures, ...interventions].map((event) => `${event.seq}:${event.kind}`).slice(0, 100),
    },
    analysis: {
      ...(firstDivergence ? { firstDivergence: { seq: firstDivergence.seq, kind: firstDivergence.kind, nodeId: firstDivergence.nodeId } } : {}),
      wastedWorkMs: nodes.filter((node) => node.status === "failed" || (node.result && node.result.status !== "succeeded")).reduce((sum, node) => sum + (node.durationMs || 0), 0),
    },
    baseline: {
      applicable: workflow.kind === "coding" ? "direct tool-using agent" : "direct research agent",
      comparisonAvailable: typeof workflow.working.baselineWorkflowId === "string",
      note: typeof workflow.working.baselineWorkflowId === "string"
        ? `Compare with workflow ${workflow.working.baselineWorkflowId}.`
        : "No identical-task baseline trajectory is linked to this run.",
    },
    suggestedImprovements: suggestions.length ? suggestions : ["No evidence-backed runtime change is suggested by this trajectory."],
    provenance: {
      templateId: workflow.templateId,
      specVersion: workflow.spec.version,
      modelVersions,
      eventRange,
      checkpoint: String(workflow.working.checkpoint || "latest committed node"),
      environment: { platform: process.platform, architecture: process.arch, node: process.version },
    },
  };
}

export function redactPostRunReport(report: PostRunReport): PostRunReport {
  const scrub = (value: string) => value
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\b/g, "[REDACTED]")
    .replace(/(password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
  return JSON.parse(JSON.stringify(report), (_key, value) => typeof value === "string" ? scrub(value) : value) as PostRunReport;
}
