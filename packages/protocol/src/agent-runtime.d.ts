export const AGENT_RUNTIME_SCHEMA_VERSION: 1;
export type SharedTaskOutcome = "complete" | "incomplete" | "blocked" | "cancelled" | "failed";
export type SharedCriterionState = "unknown" | "pass" | "fail" | "blocked";
export type SharedAcceptanceCriterion = { id: string; text: string; state: SharedCriterionState; evidenceIds: string[]; detail?: string };
export type SharedTaskContract = {
  objective: string; latestUserRequest: string;
  deliverables: { id: string; description: string; path?: string; required: boolean }[];
  criteria: SharedAcceptanceCriterion[]; constraints: string[]; permissions: string[]; unverifiableProperties: string[];
};
export type SharedCompletionInput = {
  executionFault?: string; blockedReason?: string; cancelled?: boolean; unresolvedWorkIds: string[];
  criteria: SharedAcceptanceCriterion[]; requiredVerificationPassed: boolean;
};
export function evaluateSharedCompletion(input: SharedCompletionInput): { outcome: SharedTaskOutcome; reason: string };
export type SharedRuntimeEvent = {
  schemaVersion: 1; eventId: string; sequence: number; timestamp: number; runId: string; invocationId?: string;
  traceId: string; spanId: string; parentSpanId?: string; lifecycle: string; kind: string; nodeId?: string;
  agentId?: string; modelId?: string; toolCallId?: string; payloadRedacted: boolean; artifactRefs: string[]; payload: unknown;
};
export type ResearchCoverageItem = { id: string; evidenceIds: string[]; unresolved: boolean; contradictory: boolean };
export function evaluateResearchCoverage(items: ResearchCoverageItem[], fetchedEvidenceIds: Set<string>): { complete: boolean; uncoveredIds: string[]; contradictionIds: string[] };
export type ResearchCollectionInput = { queries: string[]; sources: string[]; minQueries?: number; minOrigins?: number; plateauFetches?: number };
export type ResearchCollectionResult = {
  passed: boolean; reason: "plateau" | "sufficient"; queryCount: number; sourceCount: number;
  originCount: number; origins: string[]; redundantTail: number; breadthMet: boolean;
  independenceMet: boolean; plateaued: boolean; missingQueries: number; missingOrigins: number;
};
export function evaluateResearchCollection(input: ResearchCollectionInput): ResearchCollectionResult;
export type StaticHtmlValidation = {
  passed: boolean;
  checks: { code: string; passed: boolean; detail: string }[];
  uncheckedProperties: string[];
};
export function validateStaticHtmlDocument(html: string): StaticHtmlValidation;
export type ArtifactAcceptanceAdapter<TContext = unknown> = {
  id: string; mediaTypes: string[];
  validate: (context: TContext) => Promise<{ passed: boolean; checks: { code: string; passed: boolean; detail: string }[]; uncheckedProperties: string[] }>;
};
export class ArtifactAcceptanceRegistry {
  register(adapter: ArtifactAcceptanceAdapter): void;
  resolve(mediaType: string): ArtifactAcceptanceAdapter | undefined;
  list(): string[];
}
