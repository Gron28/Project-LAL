import crypto from "node:crypto";
import { HIVE_CONTRACT_VERSION, validateWorkflowSpec, type WorkflowNode, type WorkflowSpec } from "./contracts.ts";

export type GraphPort = { id: string; dataType: "task" | "evidence" | "artifact" | "result" | "decision" };
export type GraphCondition = { kind: "always" } | { kind: "routing_action"; action: "dispatch" | "retry" | "verify" | "replan" | "finish" | "request_user" };
export type WorkflowGraphNodeDefinition = {
  id: string;
  // The palette type is an LAL-owned, finite label. It never evaluates code.
  type: "intake" | "question" | "router" | "research" | "planner" | "worker" | "tool" | "check" | "verifier" | "approval" | "merge" | "output";
  inputs: GraphPort[];
  outputs: GraphPort[];
  promptTemplateRef: string;
  execution: Omit<WorkflowNode, "dependsOn">;
};
export type WorkflowGraphEdgeDefinition = { from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; condition: GraphCondition };
export type WorkflowDefinition = {
  version: typeof HIVE_CONTRACT_VERSION;
  id: string;
  name: string;
  description: string;
  kind: WorkflowSpec["kind"];
  owner: string;
  nodes: WorkflowGraphNodeDefinition[];
  edges: WorkflowGraphEdgeDefinition[];
  allowedFollowupActions: string[];
  budget: WorkflowSpec["budget"];
  parentRevision?: string;
  changeNote: string;
  // Layout intentionally has no input into compilation or revision identity.
  layout?: Record<string, { x: number; y: number }>;
};
export type GraphCompileResult = { ok: true; spec: WorkflowSpec; revision: string } | { ok: false; errors: string[] };

const mutationActions = new Set(["write", "edit", "shell", "git", "tool"]);
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
};

/** Revision identity excludes canvas placement, so moving boxes cannot change
 * execution semantics or invalidate a replay. */
export function workflowRevision(definition: WorkflowDefinition): string {
  const semantic = { ...definition };
  delete semantic.layout;
  return crypto.createHash("sha256").update(stable(semantic)).digest("hex");
}

export function compileWorkflowDefinition(definition: WorkflowDefinition): GraphCompileResult {
  const errors: string[] = [];
  if (definition.version !== HIVE_CONTRACT_VERSION) errors.push(`version must be ${HIVE_CONTRACT_VERSION}`);
  if (!definition.id.trim() || !definition.name.trim() || !definition.owner.trim()) errors.push("workflow id, name, and owner are required");
  const nodeIds = new Set<string>();
  const inputPorts = new Map<string, GraphPort>();
  const outputPorts = new Map<string, GraphPort>();
  for (const node of definition.nodes) {
    if (!node.id.trim()) { errors.push("node id is required"); continue; }
    if (nodeIds.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
    if (!node.promptTemplateRef.trim()) errors.push(`${node.id} requires a versioned prompt template reference`);
    if (node.execution.id !== node.id) errors.push(`${node.id} execution id must match node id`);
    if (mutationActions.has(node.execution.action) && !node.execution.approval) errors.push(`${node.id} mutation action requires approval`);
    for (const [direction, set, values] of [["input", inputPorts, node.inputs], ["output", outputPorts, node.outputs]] as const) for (const port of values) {
      const key = `${node.id}:${port.id}`;
      if (!port.id.trim() || set.has(key)) errors.push(`${node.id} has an invalid or duplicate ${direction} port`);
      set.set(key, port);
    }
  }
  const dependencies = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of definition.edges) {
    const source = outputPorts.get(`${edge.from.nodeId}:${edge.from.portId}`);
    const target = inputPorts.get(`${edge.to.nodeId}:${edge.to.portId}`);
    if (!nodeIds.has(edge.from.nodeId) || !nodeIds.has(edge.to.nodeId)) { errors.push("edge references a missing node"); continue; }
    if (!source || !target) { errors.push("edge references a missing port"); continue; }
    if (source.dataType !== target.dataType) errors.push(`${edge.from.nodeId} → ${edge.to.nodeId} has incompatible ports`);
    if (edge.from.nodeId === edge.to.nodeId) errors.push(`${edge.from.nodeId} cannot self-connect`);
    const deps = dependencies.get(edge.to.nodeId)!;
    if (deps.includes(edge.from.nodeId)) errors.push(`duplicate edge ${edge.from.nodeId} → ${edge.to.nodeId}`);
    else deps.push(edge.from.nodeId);
  }
  const spec: WorkflowSpec = {
    version: HIVE_CONTRACT_VERSION, id: definition.id, kind: definition.kind, name: definition.name,
    nodes: definition.nodes.map((node) => ({ ...node.execution, dependsOn: dependencies.get(node.id) ?? [] })),
    allowedFollowupActions: [...definition.allowedFollowupActions], budget: definition.budget,
  };
  errors.push(...validateWorkflowSpec(spec));
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  return { ok: true, spec, revision: workflowRevision(definition) };
}

/** Imports existing fixed templates without modifying their scheduler contract. */
export function definitionFromWorkflowSpec(spec: WorkflowSpec, owner = "local-owner"): WorkflowDefinition {
  const outputs = new Map<string, GraphPort>();
  const nodes = spec.nodes.map((node) => {
    const output = { id: "result", dataType: "result" as const };
    outputs.set(node.id, output);
    const execution = Object.fromEntries(Object.entries(node).filter(([key]) => key !== "dependsOn")) as Omit<WorkflowNode, "dependsOn">;
    return { id: node.id, type: "worker" as const, inputs: [{ id: "result", dataType: "result" as const }], outputs: [output], promptTemplateRef: `legacy:${spec.id}:${node.id}:v${spec.version}`, execution };
  });
  return {
    version: HIVE_CONTRACT_VERSION, id: spec.id, name: spec.name, description: `Imported ${spec.kind} workflow`, kind: spec.kind, owner,
    nodes,
    edges: spec.nodes.flatMap((node) => node.dependsOn.map((dependency) => ({ from: { nodeId: dependency, portId: outputs.get(dependency)?.id ?? "result" }, to: { nodeId: node.id, portId: "result" }, condition: { kind: "always" as const } }))),
    allowedFollowupActions: [...spec.allowedFollowupActions], budget: { ...spec.budget }, changeNote: "Imported fixed workflow",
  };
}
