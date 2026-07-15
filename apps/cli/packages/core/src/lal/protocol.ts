// GENERATED / MIRRORED FILE — do not hand-edit the declarations below.
//
// Mirrored from web/src/lib/protocol/index.ts (the source of truth — read its header for
// the full compatibility rule) by scripts/check_protocol_drift.mjs. Self-contained: no
// imports from web/, so the CLI fork can typecheck against these shapes standalone.
//
// Compatibility rule, summarized (see web/src/lib/protocol/index.ts for the full text):
//   - a new event kind is a minor change — clients must ignore unknown kinds.
//   - a shape change to an existing kind is a version bump (PROTOCOL_VERSION).
//   - no new event kind may be added anywhere except through web/src/lib/protocol/.
//
// To update this file after changing web/src/lib/protocol/index.ts, web/src/lib/toolloop.ts,
// or web/src/lib/deliberate.ts:
//   node scripts/check_protocol_drift.mjs --write
// CI / pre-flight check (no write, exits nonzero on drift):
//   node scripts/check_protocol_drift.mjs

export const PROTOCOL_VERSION = 1;

export type ProtocolHandshakeEvent = { k: "protocol"; v: typeof PROTOCOL_VERSION };

export type ToolLoopEvent =
  // p = the model's probability for the token(s) in this delta (0-1). alts = the
  // top competing tokens, attached when the choice has meaningful ambiguity (p < 0.8) —
  // this is tier 1 of "see inside the model's head": every run's ledger records
  // not just what the model said but how sure it was and what it almost said.
  | { k: "text"; v: string; p?: number; alts?: [string, number][] }
  | { k: "think"; v: string; p?: number }
  | { k: "tool_request"; v: { id: string; name: string; args: Record<string, unknown> } }
  // Live progress WHILE a tool call's arguments are still decoding. A code agent
  // spends most of its wall-clock inside write_file calls, and tool_request only
  // fires once the whole call has finished streaming — observed live 2026-07-09:
  // 80 seconds of dead air (GPU pinned, zero events) while gemma4:12b decoded one
  // write_file. Throttled to ~1/s; carries a tail preview, not cumulative content.
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
  // Live meter: emitted after each round from llama-server's usage/timings so the
  // UI can show context fill (promptTokens+completionTokens vs ctx) and decode speed.
  | { k: "usage"; v: { promptTokens: number; completionTokens: number; totalTokens: number; tokPerSec: number | null; ctx: number; conf?: { avg: number; min: number; low: number } | null } }
  // The model's final answer was cut off by the per-round token cap (finish_reason
  // "length") rather than finishing — the "Continue" affordance keys off this.
  | { k: "truncated"; v: { round: number } }
  // Refuse a request before it reaches the inference backend when its estimated
  // input plus reserved output/tool-result space would overflow the context.
  | { k: "context_limit"; v: { estimatedTokens: number; reserveTokens: number; ctx: number } }
  // Older tool outputs were trimmed in place to fit the context window instead of
  // failing the run (deep-research died at round 12/64 from accumulated search
  // results, 2026-07-09). The most recent rounds are always kept intact.
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
  // Preamble: the run's current meta, sent first so a client knows status before replay
  // starts (e.g. a run that finished while the client was detached). Synthesized fresh by
  // the stream route on each connection — not part of the persisted ledger.
  | { k: "run"; v: unknown }
  // Chat/code turn boundary — v.base is the transcript length the new turn started from.
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
  | { k: "model"; v: string } // vision route: which model actually answered
  | { k: "project"; v: { root: string; instructionFiles?: string[] } }
  | { k: "done"; v: { conversationId?: string; dir?: string } }
  | { k: "query"; v: { query: string; model: string } } // deliberate route preamble
  // Handled defensively by web/src/app/agent/agent-chat.tsx's client but not currently
  // emitted by any route (dead/legacy path — kept so an older frame, or a future
  // speech-to-text feature reusing the kind, never fails the conformance check).
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
  // protocol handshake + run envelope
  "protocol", "run", "turn", "status", "approval_needed", "approval_result",
  // ToolLoopEvent
  "text", "think", "tool_request", "tool_progress", "tool_result", "round", "max_rounds",
  "act_nudge", "model_swap", "think_recovered", "forced_verify", "mutation_required_nudge",
  "stall_nudge", "research_depth_nudge", "usage", "truncated", "context_limit", "context_compacted",
  // DeliberateEvent (some kinds overlap with ToolLoopEvent/AdditionalRouteEvent by name —
  // "text", "error", "done" are shared/homonymous across modules, not distinct wire kinds)
  "phase", "roles", "role_progress", "debate_turn", "convergence", "artifact", "inner", "error",
  // HiveWorkflowEvent
  "workflow_routing", "stage_trace", "workflow_started", "workflow_node", "workflow_finished",
  // AdditionalRouteEvent
  "model_loading", "model_ready", "token_confidence", "model", "project", "done", "query", "transcript",
]);

export function isKnownEventKind(k: string): boolean {
  return KNOWN_EVENT_KINDS.has(k);
}
