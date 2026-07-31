// The versioned wire contract shared by the LAL host and terminal client.
//
// Tool identity is part of that contract — see ./tools.ts (PLAN 2.2).
// Additive event kinds are minor changes; incompatible payload changes require a
// protocol-version bump. Unknown kinds must always degrade visibly at clients.

export const PROTOCOL_VERSION = 1;

export type ContextVerificationStatus =
  | "unknown"
  | "planned"
  | "probing"
  | "verified"
  | "degraded"
  | "failed";

/**
 * One context-window truth shared by the host, browser, and terminal.  The
 * model limit is metadata; requested is policy; active is what the backend
 * actually allocated.  Consumers must never present one as another.
 */
export type ContextProfile = {
  model: string;
  backend: "llama.cpp" | "ollama" | "openvino";
  modelMaxTokens: number | null;
  requestedTokens: number;
  activeTokens: number | null;
  verifiedTokens: number | null;
  verification: ContextVerificationStatus;
  source: "gguf" | "ollama" | "openvino" | "cache" | "runtime" | "fallback";
  gpuOffload: string | null;
  fingerprint: string;
  checkedAt: string | null;
  reason?: string;
};

/** Owner-selected defaults for one model, shared by every LAL surface. */
export type ModelRuntimeSettings = {
  contextTokens: number;
  maxOutputTokens: number;
  gpuLayers: number | null;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  thinking: boolean;
  updatedAt: string | null;
};

export type WorkingStateEvidence = {
  kind: "file" | "tool" | "test" | "research" | "error";
  ref: string;
  summary: string;
};

/** Durable state which must survive transcript compaction. */
export type WorkingState = {
  revision: number;
  objective: string;
  latestUserRequest: string;
  constraints: string[];
  decisions: string[];
  completed: string[];
  pending: string[];
  blockers: string[];
  evidence: WorkingStateEvidence[];
  updatedAt: string;
};

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
  | { k: "context_compacted"; v: { trimmed: number } }
  | { k: "context_profile"; v: ContextProfile };

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
  | { k: "model_loading"; v: { model: string; ctx: number; contextProfile?: ContextProfile } }
  | { k: "model_ready"; v: { model: string; ctx: number; backend?: string; contextProfile?: ContextProfile; gpuOffload?: string; runtimeProfile?: string } }
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
  "stall_nudge", "research_depth_nudge", "usage", "truncated", "context_limit", "context_compacted", "context_profile",
  "phase", "roles", "role_progress", "debate_turn", "convergence", "artifact", "inner", "error",
  "workflow_routing", "stage_trace", "workflow_started", "workflow_node", "workflow_finished",
  "model_loading", "model_ready", "token_confidence", "model", "project", "done", "query", "transcript",
]);

export function isKnownEventKind(k: string): boolean {
  return KNOWN_EVENT_KINDS.has(k);
}

// --------------------------------------------------------------------------
// PLAN 2.2 — one registry is the only source of tool identity.
//
// The gateway used to keep its own hand-maintained `LAL_TERMINAL_TOOLS` set
// inside the chat-completions route while the CLI kept the real tool names in
// `tool-names.ts`. Two hand-maintained lists of the same thing drift, and the
// drift was silent in the worst possible direction: the gateway DROPS any
// advertised tool whose name it does not recognise, so the model was handed a
// capability list nobody told it about. Both failures below were real:
//
//   - `screenshot` sat in the allowlist and matched no tool at all, so the entry
//     admitted nothing while reading as though screen capture were available.
//   - the computer-use driver advertises `computer_use__page`, and the allowlist
//     named the bare verb `page`, so every browser tool `tool_search` loaded was
//     deleted at the filter — while the system prompt instructed the model to
//     load and use them (PLAN 2.1, hypothesis 4).
//
// This module is that single declaration. It lives in the shared protocol
// package because it is exactly a host↔client contract: the host decides which
// tools may cross the wire, and the client must not advertise what the host will
// silently drop.

/**
 * Tools the managed terminal boundary admits.
 *
 * This is a PRODUCT boundary, not a capability inventory — excluding a tool is
 * its job. Teams, workflows and the broader inherited surface are deliberately
 * outside it, because a small local model handed sixty schemas emits none of
 * them correctly.
 */
export const LAL_TERMINAL_TOOLS: readonly string[] = [
  // File and shell work: the irreducible core.
  "read_file",
  "edit",
  "write_file",
  "run_shell_command",
  // Orientation. Without list/search the model cannot discover the project it
  // is asked to change, which manifested as repeat-loops instead of tool calls.
  "grep_search",
  "glob",
  "list_directory",
  "todo_write",
  // One-chat project orchestration. Deliberately the only larger synthetic
  // schemas admitted at this boundary.
  "tool_search",
  "agent",
  "task_stop",
  "web_search",
  "web_fetch",
  // Browser acceptance tools stay lazy behind tool_search; admitting them here
  // lets their eventual schemas and results live in the same turn.
  "launch_app",
  "list_windows",
  "get_window_state",
  "page",
];

const TERMINAL_TOOL_SET = new Set(LAL_TERMINAL_TOOLS);

/**
 * The computer-use driver advertises its tools prefixed. The allowlist is
 * written in terms of the bare verb, so the prefix is stripped before matching —
 * in ONE place, shared by both sides, which is the point of this module.
 */
export const COMPUTER_USE_PREFIX = "computer_use__";

/** The name to match against the allowlist for an as-advertised tool name. */
export function canonicalToolName(advertisedName: string): string {
  return advertisedName.startsWith(COMPUTER_USE_PREFIX)
    ? advertisedName.slice(COMPUTER_USE_PREFIX.length)
    : advertisedName;
}

/** Would the gateway admit a tool advertised under this name? */
export function isTerminalTool(advertisedName: string): boolean {
  return TERMINAL_TOOL_SET.has(canonicalToolName(advertisedName));
}
