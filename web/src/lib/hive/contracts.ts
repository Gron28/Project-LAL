export const HIVE_CONTRACT_VERSION = 1 as const;

export type HiveWorkflowKind = "research" | "coding";
export type BudgetName = "quick" | "standard" | "deep";
export type NodeStatus = "pending" | "ready" | "running" | "awaiting_approval" | "paused" | "succeeded" | "failed" | "skipped" | "cancelled";
export type WorkflowStatus = "queued" | "running" | "paused" | "awaiting_approval" | "succeeded" | "failed" | "cancelled";
export type StageStatus = "succeeded" | "failed" | "needs_followup" | "blocked";
export type RoutingAction = "dispatch" | "retry" | "verify" | "replan" | "finish" | "request_user";

export type ArtifactRef = {
  hash: string;
  mediaType: string;
  size: number;
  label?: string;
  path?: string;
};

export type EvidenceRecord = {
  id: string;
  url: string;
  retrievedAt: number;
  sourceHash: string;
  excerpt: string;
  stance: "supporting" | "contradicting" | "context";
  claim?: string;
  title?: string;
};

export type VerificationResult = {
  passed: boolean;
  score?: number;
  checks: { code: string; passed: boolean; detail: string }[];
};

export type StageResult = {
  version: typeof HIVE_CONTRACT_VERSION;
  status: StageStatus;
  summary: string;
  findings: { id: string; text: string; evidenceIds?: string[]; confidence?: number }[];
  artifacts: ArtifactRef[];
  evidence: EvidenceRecord[];
  uncertainties: string[];
  errors: string[];
  verification?: VerificationResult;
};

export type ResourceBudget = {
  name: BudgetName;
  wallTimeMs: number;
  inferenceTokens: number;
  contextTokens: number;
  modelSwaps: number;
  retries: number;
  researchCalls: number;
  shallowVerification: boolean;
};

export type ModelCapability = "chat" | "structured_output" | "tools" | "coding" | "research" | "planning" | "verification" | "vision";

export type ModelProfile = {
  id: string;
  provider: "llama.cpp" | "ollama";
  model: string;
  checkpoint?: string;
  adapter?: string;
  versionHash: string;
  capabilities: ModelCapability[];
  structuredOutput: "grammar" | "json_schema" | "repair" | "none";
  contextCeiling: number;
  measuredTokensPerSecond?: number;
  memoryGb?: number;
  offload?: string;
  backendCompatible: boolean;
  probeStatus: "discovered" | "probing" | "verified" | "failed";
  probedAt?: number;
  probeError?: string;
};

export type ContextPolicy = {
  maxTokens: number;
  artifactLimit: number;
  evidenceLimit: number;
  includeDependencyResults: boolean;
};

export type RoleProfile = {
  id: string;
  version: number;
  prompt: string;
  permittedTools: string[];
  modelRequirements: ModelCapability[];
  contextPolicy: ContextPolicy;
  evaluationSuite: string;
  coordinator?: boolean;
};

export type RetryPolicy = {
  maxAttempts: number;
  backoffMs: number;
  retryOn: ("timeout" | "backend" | "invalid_output" | "verification")[];
};

export type WorkflowNode = {
  id: string;
  label: string;
  role: string;
  action: string;
  dependsOn: string[];
  optional?: boolean;
  approval?: boolean;
  timeoutMs?: number;
  retry: RetryPolicy;
  verificationGate?: { minimumScore?: number; requireEvidence?: boolean; requireTests?: boolean };
};

export type WorkflowSpec = {
  version: typeof HIVE_CONTRACT_VERSION;
  id: string;
  kind: HiveWorkflowKind;
  name: string;
  nodes: WorkflowNode[];
  allowedFollowupActions: string[];
  budget: ResourceBudget;
};

export type TaskEnvelope = {
  version: typeof HIVE_CONTRACT_VERSION;
  objective: string;
  constraints: string[];
  artifactRefs: ArtifactRef[];
  requiredOutput: string;
  definitionOfDone: string[];
  workspace?: string;
};

export type RoutingDecision = {
  version: typeof HIVE_CONTRACT_VERSION;
  action: RoutingAction;
  targetNodeId?: string;
  followupAction?: string;
  reason: string;
  uncertainty: number;
};

export const ROUTING_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "action", "reason", "uncertainty"],
  properties: {
    version: { const: HIVE_CONTRACT_VERSION },
    action: { enum: ["dispatch", "retry", "verify", "replan", "finish", "request_user"] },
    targetNodeId: { type: "string" },
    followupAction: { type: "string" },
    reason: { type: "string" },
    uncertainty: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function validateTaskEnvelope(value: unknown): string[] {
  if (!isObject(value)) return ["task envelope must be an object"];
  const errors: string[] = [];
  if (value.version !== HIVE_CONTRACT_VERSION) errors.push(`version must be ${HIVE_CONTRACT_VERSION}`);
  if (typeof value.objective !== "string" || !value.objective.trim()) errors.push("objective is required");
  if (!strings(value.constraints)) errors.push("constraints must be a string array");
  if (!Array.isArray(value.artifactRefs)) errors.push("artifactRefs must be an array");
  if (typeof value.requiredOutput !== "string" || !value.requiredOutput.trim()) errors.push("requiredOutput is required");
  if (!strings(value.definitionOfDone) || !value.definitionOfDone.length) errors.push("definitionOfDone must contain at least one check");
  if (value.workspace !== undefined && typeof value.workspace !== "string") errors.push("workspace must be a string");
  return errors;
}

export function validateWorkflowSpec(value: unknown): string[] {
  if (!isObject(value)) return ["workflow spec must be an object"];
  const errors: string[] = [];
  if (value.version !== HIVE_CONTRACT_VERSION) errors.push(`version must be ${HIVE_CONTRACT_VERSION}`);
  if (value.kind !== "research" && value.kind !== "coding") errors.push("kind must be research or coding");
  if (!Array.isArray(value.nodes) || !value.nodes.length) return [...errors, "nodes must be a non-empty array"];
  const ids = new Set<string>();
  for (const [index, raw] of value.nodes.entries()) {
    if (!isObject(raw) || typeof raw.id !== "string" || !raw.id) { errors.push(`nodes[${index}].id is required`); continue; }
    if (ids.has(raw.id)) errors.push(`duplicate node id: ${raw.id}`);
    ids.add(raw.id);
    if (!strings(raw.dependsOn)) errors.push(`${raw.id}.dependsOn must be a string array`);
    if (typeof raw.role !== "string" || typeof raw.action !== "string") errors.push(`${raw.id} requires role and action`);
  }
  for (const raw of value.nodes) {
    if (!isObject(raw) || !strings(raw.dependsOn) || typeof raw.id !== "string") continue;
    for (const dep of raw.dependsOn) if (!ids.has(dep)) errors.push(`${raw.id} depends on missing node ${dep}`);
  }
  // Kahn's algorithm catches cycles before any side effects can run.
  const nodes = value.nodes.filter(isObject) as Record<string, unknown>[];
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const n of nodes) if (typeof n.id === "string") { indegree.set(n.id, strings(n.dependsOn) ? n.dependsOn.length : 0); children.set(n.id, []); }
  for (const n of nodes) if (typeof n.id === "string" && strings(n.dependsOn)) for (const dep of n.dependsOn) children.get(dep)?.push(n.id);
  const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) { const id = queue.shift()!; visited++; for (const child of children.get(id) || []) { const n = (indegree.get(child) || 0) - 1; indegree.set(child, n); if (!n) queue.push(child); } }
  if (visited !== indegree.size) errors.push("workflow graph contains a dependency cycle");
  return errors;
}

export function validateRoutingDecision(value: unknown, spec: WorkflowSpec): value is RoutingDecision {
  if (!isObject(value) || value.version !== HIVE_CONTRACT_VERSION) return false;
  if (!["dispatch", "retry", "verify", "replan", "finish", "request_user"].includes(String(value.action))) return false;
  if (typeof value.reason !== "string" || typeof value.uncertainty !== "number" || value.uncertainty < 0 || value.uncertainty > 1) return false;
  if (value.targetNodeId !== undefined && (typeof value.targetNodeId !== "string" || !spec.nodes.some((n) => n.id === value.targetNodeId))) return false;
  if (value.followupAction !== undefined && (typeof value.followupAction !== "string" || !spec.allowedFollowupActions.includes(value.followupAction))) return false;
  return true;
}

export function emptyStageResult(summary = ""): StageResult {
  return { version: HIVE_CONTRACT_VERSION, status: "succeeded", summary, findings: [], artifacts: [], evidence: [], uncertainties: [], errors: [] };
}
