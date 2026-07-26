import { validateWorkflowSpec, type NodeStatus, type WorkflowSpec } from "./contracts.ts";
import type { WorkflowNodeRecord } from "./store.ts";

/** A read-only rendering of a workflow DAG.  It is deliberately separate from
 * the scheduler: callers can inspect an invalid proposed workflow without ever
 * making it executable. */
export type WorkflowGraph = {
  valid: boolean;
  errors: string[];
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  topologicalOrder: string[];
  summary: { total: number; terminal: number; blocked: number; runnable: number };
};

export type WorkflowGraphNode = {
  id: string;
  label: string;
  role: string;
  action: string;
  optional: boolean;
  dependsOn: string[];
  depth: number;
  status: NodeStatus;
  blockedBy: string[];
  runnable: boolean;
};

export type WorkflowGraphEdge = { from: string; to: string; satisfied: boolean };

const TERMINAL = new Set<NodeStatus>(["succeeded", "failed", "skipped", "cancelled"]);
const SATISFIED = new Set<NodeStatus>(["succeeded", "skipped"]);

/**
 * Derive a stable graph projection for the HIVE UI and API.  The function has
 * no persistence or scheduling side effects; validation errors are returned
 * alongside the best-effort graph so a user can correct a draft safely.
 */
export function projectWorkflowGraph(spec: WorkflowSpec, records: readonly Pick<WorkflowNodeRecord, "nodeId" | "status">[] = []): WorkflowGraph {
  const errors = validateWorkflowSpec(spec);
  const statuses = new Map(records.map((record) => [record.nodeId, record.status]));
  const nodes = spec.nodes.map((node) => ({ ...node, status: statuses.get(node.id) ?? "pending" as NodeStatus }));
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const edges: WorkflowGraphEdge[] = [];

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) continue;
      children.get(dependency)!.push(node.id);
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      edges.push({ from: dependency, to: node.id, satisfied: SATISFIED.has(statuses.get(dependency) ?? "pending") });
    }
  }

  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id).sort();
  const topologicalOrder: string[] = [];
  const depths = new Map(nodes.map((node) => [node.id, 0]));
  while (queue.length) {
    const id = queue.shift()!;
    topologicalOrder.push(id);
    for (const child of children.get(id) ?? []) {
      depths.set(child, Math.max(depths.get(child) ?? 0, (depths.get(id) ?? 0) + 1));
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
    queue.sort();
  }

  const viewNodes: WorkflowGraphNode[] = nodes.map((node) => {
    const blockedBy = node.dependsOn.filter((dependency) => ids.has(dependency) && !SATISFIED.has(statuses.get(dependency) ?? "pending"));
    const status = node.status;
    return {
      id: node.id, label: node.label, role: node.role, action: node.action, optional: !!node.optional,
      dependsOn: [...node.dependsOn], depth: depths.get(node.id) ?? 0, status, blockedBy,
      runnable: errors.length === 0 && !TERMINAL.has(status) && status !== "running" && status !== "awaiting_approval" && blockedBy.length === 0,
    };
  });
  const terminal = viewNodes.filter((node) => TERMINAL.has(node.status)).length;
  return {
    valid: errors.length === 0,
    errors,
    nodes: viewNodes,
    edges,
    topologicalOrder,
    summary: {
      total: viewNodes.length,
      terminal,
      blocked: viewNodes.filter((node) => !TERMINAL.has(node.status) && node.blockedBy.length > 0).length,
      runnable: viewNodes.filter((node) => node.runnable).length,
    },
  };
}
