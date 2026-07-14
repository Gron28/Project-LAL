// The LAL run-stream event protocol — the single versioned contract for every event
// kind (`k`) that can appear on an agent run's SSE stream
// (web/src/app/api/agent/runs/[id]/stream/route.ts) and, by extension, in the on-disk
// run ledgers under web/.data/runs/*.ndjson that the stream replays on attach.
//
// COMPATIBILITY RULE — read before adding or changing an event:
//   - Adding a NEW EVENT KIND is a MINOR change. Every existing client dispatches on `k`
//     with a safe fallthrough for kinds it doesn't recognize (verified 2026-07-14 in
//     web/src/app/code/page.tsx's `applyEvent`/onmessage handler, web/src/app/agent/
//     agent-chat.tsx's `attachChatRun`, and web/src/app/hive/page.tsx's stream handler —
//     all are if/else-if chains with no exhaustive default, so an unmatched `k` is
//     silently ignored, never thrown). Adding a kind never breaks an old client. It DOES
//     require adding that kind to the unions below (and to the mirrored copy at
//     lal-cli/packages/core/src/lal/protocol.ts, kept in sync by
//     scripts/check_protocol_drift.mjs) in the same change.
//   - Changing the SHAPE of an EXISTING kind's `v` payload in a way an existing client
//     reads (renaming/removing/retyping a field, changing its meaning) is a BREAKING
//     change and requires bumping PROTOCOL_VERSION. Purely additive fields are fine
//     without a bump — readers destructure only the fields they know.
//   - No new event kind may be introduced ANYWHERE in the codebase (toolloop.ts,
//     deliberate.ts, hive/engine.ts, an API route, ...) except by adding it to a union in
//     this module first. If you're about to `emit({ k: "something_new", ... })`, add the
//     kind here (and to the CLI mirror) before wiring the emitter.
//
// This module does not re-implement event shapes — it re-exports the unions that already
// live next to the code that emits them (ToolLoopEvent, DeliberateEvent), so there is
// exactly one definition of each. It adds: the version constant, the stream handshake
// frame, the run-envelope kinds contributed by the run manager itself (not any particular
// agent loop), the hive-specific kinds, a few additional route-level kinds, and the
// closed set of every `k` allowed on the wire.
//
// OUT OF SCOPE: hive's internal durable ledger (`appendHiveEvent`, stored in
// web/.data/hive.db with its own `kind` taxonomy: routing_decision, node_started,
// node_finished, ...) is a separate DB-backed history model consumed by the
// workflow-detail API (`GET /api/hive/workflows/:id`), not this SSE protocol. Only the
// kinds hive/engine.ts actually `emit()`s onto the run stream — HiveWorkflowEvent below,
// plus every re-tagged ToolLoopEvent kind — are part of this protocol.

import type { ToolLoopEvent } from "../toolloop";
import type { DeliberateEvent } from "../deliberate";
import type { RunStatus } from "../runs";

export type { ToolLoopEvent } from "../toolloop";
export type { DeliberateEvent } from "../deliberate";

export const PROTOCOL_VERSION = 1;

// Sent as the very first SSE frame on every attach, before the `run` preamble and any
// replay — see the stream route. Synthesized per-connection; never persisted to the run
// ledger. Existing clients ignore unknown kinds (see compatibility rule above), so adding
// this frame is itself a minor, non-breaking change to the wire.
export type ProtocolHandshakeEvent = { k: "protocol"; v: typeof PROTOCOL_VERSION };

// ---- run envelope kinds -------------------------------------------------------------
// Contributed by the run manager (web/src/lib/runs.ts) and the stream route around every
// run, regardless of which agent loop (code/chat/deliberate/hive) produced the inner
// events.
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
// Note: "usage" is ALSO emitted at the top level of every chat/loop run, not just from
// inside a tool loop — but its shape there is exactly ToolLoopEvent's `usage` variant, so
// it's reused rather than redefined as a separate envelope kind.

// ---- hive event kinds -----------------------------------------------------------------
// hive/engine.ts (owned by another workstream, left untouched here) has no exported named
// union for what it emits onto the run stream: it forwards ToolLoopEvent unchanged,
// re-tagged with workflow/node metadata, plus these kinds of its own. Named here so both
// are still governed by this module's versioning rule.
export type HiveWorkflowEvent =
  | { k: "workflow_routing"; workflowId: string; v: unknown }
  | { k: "stage_trace"; workflowId: string; nodeId: string; role: string; modelVersion?: string; v: { kind: string; text: string; p?: number; alts?: [string, number][] } }
  | { k: "workflow_started"; workflowId: string; v: { workflowId: string; executionRunId: string; spec: string; budget: unknown } }
  | { k: "workflow_node"; workflowId: string; nodeId: string; role: string; modelVersion?: string; v: { status: string; attempt?: number; result?: unknown; durationMs?: number } }
  | { k: "workflow_finished"; workflowId: string; v: { status: string; inferenceTokens?: unknown; swaps?: unknown; retriesUsed?: unknown } };

// A ToolLoopEvent re-emitted by hive/engine.ts with routing metadata spread on
// (`emit({ ...event, workflowId, nodeId, role, modelVersion })`) — same `k`/`v` shapes as
// ToolLoopEvent, plus these extra fields.
export type HiveTaggedToolLoopEvent = ToolLoopEvent & { workflowId: string; nodeId: string; role: string; modelVersion?: string };

// ---- additional route-level kinds ------------------------------------------------------
// Emitted directly by API routes (chat/loop/deliberate), outside toolloop.ts's and
// deliberate.ts's own unions. Listed here so the conformance check has a complete, closed
// set instead of an escape hatch.
export type AdditionalRouteEvent =
  | { k: "model_loading"; v: { model: string; ctx: number } }
  | { k: "model_ready"; v: { model: string; ctx: number; backend?: string } }
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

// The closed set of every `k` allowed on the wire today. Kept as a plain runtime Set
// (rather than derived from the types above via some build step) so conformance checks
// and drift checks can use it directly without a type-to-value bridge. If you add a
// variant above, add its `k` literal(s) here too — scripts/check_protocol_drift.mjs and
// the conformance test both fail loudly if this list and the mirror in lal-cli drift, but
// nothing currently catches this list itself falling out of sync with the unions above;
// keep them next to each other and update both together.
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
  "model_loading", "model_ready", "model", "project", "done", "query", "transcript",
]);

export function isKnownEventKind(k: string): boolean {
  return KNOWN_EVENT_KINDS.has(k);
}
