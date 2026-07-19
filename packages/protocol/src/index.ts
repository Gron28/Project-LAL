// The versioned wire contract shared by the LAL host and terminal client.
// Additive event kinds are minor changes; incompatible payload changes require a
// protocol-version bump. Unknown kinds must always degrade visibly at clients.

export const PROTOCOL_VERSION = 1;

export type ProtocolHandshakeEvent = { k: "protocol"; v: typeof PROTOCOL_VERSION };

export type ToolLoopEvent =
  | { k: "text"; v: string; p?: number; alts?: [string, number][] }
  | { k: "think"; v: string; p?: number }
  | { k: "tool_request"; v: { id: string; name: string; args: Record<string, unknown> } }
  | { k: "tool_progress"; v: { id: string; name: string; chars: number; preview: string } }
  | { k: "tool_result"; v: { id: string; name: string; ok: boolean; output: string } }
  | { k: "round" }
  | { k: "max_rounds"; v: number }
  | { k: "act_nudge" }
  | { k: "model_swap"; v: { from: string | null; to: string } }
  | { k: "think_recovered"; v: { count: number } }
  | { k: "forced_verify" }
  | { k: "mutation_required_nudge"; v: { count: number } }
  | { k: "stall_nudge" }
  | { k: "research_depth_nudge"; v: { count: number; min: number } }
  | { k: "usage"; v: { promptTokens: number; completionTokens: number; totalTokens: number; tokPerSec: number | null; ctx: number; conf?: { avg: number; min: number; low: number } | null } }
  | { k: "truncated"; v: { round: number } }
  | { k: "context_limit"; v: { estimatedTokens: number; reserveTokens: number; ctx: number } }
  | { k: "context_compacted"; v: { trimmed: number } };

export type Role = { name: string; lens: string; bias?: string };

export type DeliberateEvent =
  | { k: "phase"; v: { name: string } }
  | { k: "roles"; v: { roles: Role[] } }
  | { k: "role_progress"; v: { role: string; stage: string } }
  | { k: "debate_turn"; v: { round: number; role: string; text: string } }
  | { k: "convergence"; v: { round: number; verdict: "converged" | "continue" | "unresolved" } }
  | { k: "artifact"; v: { path: string } }
  | { k: "text"; v: string }
  | { k: "inner"; v: { phase: string; role?: string; event: ToolLoopEvent } }
  | { k: "error"; v: string }
  | { k: "done"; v: { dir: string } };

export type RunStatus = "running" | "done" | "error" | "stopped" | "interrupted";

export type RunEnvelopeEvent =
  | { k: "run"; v: unknown }
  | { k: "turn"; v: { base: number } }
  | { k: "status"; v: RunStatus; error?: string }
  | { k: "approval_needed"; v: { id: string; name: string; args: Record<string, unknown> } }
  | { k: "approval_result"; v: { id: string; allow: boolean; timeout?: boolean } };

export type HiveWorkflowEvent =
  | { k: "workflow_routing"; workflowId: string; v: unknown }
  | { k: "stage_trace"; workflowId: string; nodeId: string; role: string; modelVersion?: string; v: { kind: string; text: string; p?: number; alts?: [string, number][] } }
  | { k: "workflow_started"; workflowId: string; v: { workflowId: string; executionRunId: string; spec: string; budget: unknown } }
  | { k: "workflow_node"; workflowId: string; nodeId: string; role: string; modelVersion?: string; v: { status: string; attempt?: number; result?: unknown; durationMs?: number } }
  | { k: "workflow_finished"; workflowId: string; v: { status: string; inferenceTokens?: unknown; swaps?: unknown; retriesUsed?: unknown } };

export type HiveTaggedToolLoopEvent = ToolLoopEvent & { workflowId: string; nodeId: string; role: string; modelVersion?: string };

export type AdditionalRouteEvent =
  | { k: "model_loading"; v: { model: string; ctx: number } }
  | { k: "model_ready"; v: { model: string; ctx: number; backend?: string } }
  | { k: "token_confidence"; v: { token?: string; p: number; alts?: [string, number][] } }
  | { k: "model"; v: string }
  | { k: "project"; v: { root: string; instructionFiles?: string[] } }
  | { k: "done"; v: { conversationId?: string; dir?: string } }
  | { k: "query"; v: { query: string; model: string } }
  | { k: "transcript"; v: string };

export type ProtocolEvent =
  | ProtocolHandshakeEvent
  | RunEnvelopeEvent
  | ToolLoopEvent
  | DeliberateEvent
  | HiveWorkflowEvent
  | HiveTaggedToolLoopEvent
  | AdditionalRouteEvent;

export const KNOWN_EVENT_KINDS = new Set<string>([
  "protocol", "run", "turn", "status", "approval_needed", "approval_result",
  "text", "think", "tool_request", "tool_progress", "tool_result", "round", "max_rounds",
  "act_nudge", "model_swap", "think_recovered", "forced_verify", "mutation_required_nudge",
  "stall_nudge", "research_depth_nudge", "usage", "truncated", "context_limit", "context_compacted",
  "phase", "roles", "role_progress", "debate_turn", "convergence", "artifact", "inner", "error",
  "workflow_routing", "stage_trace", "workflow_started", "workflow_node", "workflow_finished",
  "model_loading", "model_ready", "token_confidence", "model", "project", "done", "query", "transcript",
]);

export function isKnownEventKind(k: string): boolean {
  return KNOWN_EVENT_KINDS.has(k);
}
