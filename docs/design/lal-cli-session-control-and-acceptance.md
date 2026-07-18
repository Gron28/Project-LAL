# LAL CLI session control and acceptance

## Goal

Make a managed LAL terminal run one durable conversation whose execution,
remote control, loop recovery, runtime identity, and completion evidence remain
truthful across interactive and headless surfaces.

## Invariants

1. Tool-result continuations use the existing `GeminiChat`; a tool result never
   creates a replacement chat or drops preceding model/tool messages.
2. Interactive runs keep only exact repeated-call and hard per-turn caps.
   Read-only, action-stagnation, alternating, and output heuristics are for
   unattended headless runs.
3. A loop halt reports its concrete type. Interactive recovery keeps history,
   does not disable detection for the session, and gives the model a compact
   instruction to change approach. A repeated recovery halt hands control back
   to the user.
4. Managed stream-json headless mode registers one client-owned gateway run and
   leases remote prompts into its existing serialized message queue. It never
   starts another CLI process.
5. Gateway run state is authoritative: heartbeats mean alive, wrapper return is
   not completion, stale heartbeats expire, and stop requests reach the owning
   client process.
6. Public model IDs are accepted only when present in the public catalog.
   Managed Ollama context-profile IDs remain an internal routing detail.
7. A model switch unloads the previous backend, then verifies the requested
   public model, backend, context, and offload before advertising readiness.
8. Completion claims are backed by file changes and relevant tests. UI/browser
   work includes an agent-visible browser check where available.
9. Deployment succeeds only after both tailnet routes answer from their intended
   upstreams: root HTTPS for Inbox and `:8443` for LAL.

## Delivery slices

- Session/loop foundation: mode-scoped detection, typed pattern reporting,
  in-context recovery, and continuity regression coverage.
- Remote lifecycle: managed headless mirror, same-process command queue, remote
  cancellation, heartbeat expiry, and shutdown cleanup.
- Runtime truth: strict public model routing, verified load metadata, and CLI
  status visibility.
- Acceptance: managed browser tooling, stronger completion prompt, deployment
  route smoke checks, and end-to-end lifecycle smoke tests.

