# Project-LAL unimplemented work

Status: gap audit, reconciled 2026-07-22. This document records work described by the
current foundation roadmap and its subordinate CLI and repository plans that is
not yet implemented, not yet proven end to end, or is currently blocked.

The authoritative plan is `project-lal-foundation-roadmap.md`. The CLI product
plan is a capability inventory, not permission to expand the product ahead of
the foundation work.

Completed items are removed from the gap list rather than left as ambiguous
unchecked plans. The concise positive inventory is
[`../status/project-lal-current-state.md`](../status/project-lal-current-state.md).

## 1. Foundation roadmap gaps

### Milestone 2 — trustworthy state

- The web/CLI protocol boundary now lives in `packages/protocol/`, consumed by
  both applications; retain its conformance fixtures and import-boundary check.
- Native `/rc` and managed-headless mirrors now carry thinking, usage/context,
  host-observed model lifecycle/confidence/error events, approvals, rounds, and
  named tool progress. Default interactive native turns still need a managed
  lifecycle decision before they can claim automatic cross-device parity.
- Finish truthful CLI runtime coverage beyond the implemented host model catalog,
  requested/verified/active context, loaded state, GPU state, and synchronized
  sampling/thinking profile. Queue ownership and all failure transitions still
  need equivalent native and attach rendering.
- Make the full storage system bounded: the complete current-root inventory is
  documented, but conversations, HIVE artifacts, downloaded models, caches,
  datasets, screenshots, and training output still need registry-backed quotas,
  retention, and cleanup tests. Terminal ledger and deliberation retention are
  the only implemented eviction slices.
- Complete the regression matrix for startup, reconnect/replay, cancellation,
  process cleanup, protocol compatibility, and storage limits across host, web,
  CLI, and real remote devices.
- Meet the exit criterion for every status item: each value needs a real source,
  and unknown/failed data must remain visibly unknown instead of becoming a
  generic or decorative status.

### Milestone 3 — product boundary and repository migration

- Move `web/` to the intended `apps/web/` layout, or formally revise the target
  layout and document the decision.
- Reduce the inherited CLI surface: cloud providers, phone-home telemetry,
  upstream update checks, enterprise channels, public docs site, desktop app,
  mobile MCP, general SDKs, computer-use driver, broad locale machinery, and
  upstream GitHub automation remain present or only partially audited.
- Remove upstream package names, badges, links, release routes, and unrelated
  installation paths from normal LAL flows.
- Retire the transitional `lab-agent` recovery path after the LAL flow is
  reliable.
- Establish one dependency story and one release path. The current full CLI
  build still references absent `packages/webui` and `packages/web-shell`
  workspaces; only the headless standalone packaging path is currently usable.
- Finish the repository hygiene promised by the migration plan: fresh-clone
  setup, minimal supported CI, concise authoritative documentation, and a
  complete audit of retained daemon/ACP, VS Code, Zed, audio, and web-shell
  dependencies.

### Milestone 4 — gated capabilities

- Run and record a real Windows-terminal acceptance test. The Linux terminal
  lifecycle smoke is not equivalent to daily-use Windows parity.
- Restore dependable Hive workflows only after lifecycle, process ownership,
  evidence, and recovery behavior pass their capability gate.
- Restore dependable training only with bounded storage, reproducible fixtures,
  and a useful evaluation result.
- Restore dependable benchmarking only with reproducible measurements,
  retention, and reporting.
- Restore Lens only after its model availability, idle-stop, and cleanup paths
  are proven with an installed model.
- Do not promote new fine-tuning workflows until they have a useful gated
  result; existing experiments are documentation, not a completed capability.

## 2. CLI parity backlog

The CLI product plan's P0 battery is not complete end to end. The following
areas remain absent, partial, or unproven:

- **Chat:** finish native/attach event parity and default-visible telemetry for
  queue ownership and every error transition; add server-conversation resume,
  reconnect and cross-device idle watching, stop-all, and the shared
  conversation handoff contract. Model/context/runtime telemetry and persisted
  thinking/sampling controls now exist.
- **Chat P1/P2:** edit/resend and truncation continuation, grounding toggles, image
  routing, chat-to-code handoff, artifact previews, and crash guidance.
- **Code:** complete typed LAL runtime/error lines, approval details, rewind/edit,
  sub-agent grouping, local Git commands, preview URLs, and session
  diagnosis/report cards. LAL mode presets, live mutation display, and bounded
  non-progress recovery now exist but still need cross-device acceptance.
- **Research:** the evidence-gated search/fetch controller and live tool display
  now work; remaining work is a richer phase/debate/convergence renderer,
  durable research artifact display, retrospective/ground view, source-quality
  grading, and the open-inquiry confidence protocol.
- **Hive:** mission creation/listing, attach/replay controls, operator steering,
  node detail, retry/override, approvals, plan/workspace/evidence/audit panes,
  live vitals, role management, and readiness reporting.
- **Remote Hive coding:** typed reverse tool dispatch, client-side execution
  under local approval/sandbox policy, invariant tests, and an end-to-end
  remote-project mission.
- **Lab:** CLI forms and telemetry for training, dataset management, benchmark
  execution/leaderboards, experiment history, and Lens/visual handoff links.
- **Library/status:** model scanning, verified acquisition, default/resident
  selection, per-model settings, and web/CLI synchronization now work. Remaining
  work is full document/folder/run management, diagnosis/report cards, complete
  dashboard streaming, explicit resident-model unload UX, storage quotas, and
  all device/session management flows.

## 3. Hardening and distribution gaps

- Complete per-device credential lifecycle: approve, revoke, rename, rotate,
  last-seen metadata, and rejected-attempt warnings without recording project
  content.
- Add signed manifests, rollback, delta-aware updates, and native release
  coverage for Windows, Linux x64/ARM64, and macOS x64/ARM64.
- Add compatibility acceptance tests for CMD, PowerShell, Windows Terminal,
  bash, zsh, SSH, and phone/browser handoff.
- Add CI disk-delta tests proving storage limits and cleanup behavior.
- Replace remaining upstream update/telemetry paths with LAL-owned behavior or
  remove them. In particular, audit Alibaba RUM defaults, startup registry
  checks, standalone update URLs, computer-use downloads, and the upstream
  sandbox image reference.
- Decide whether to remove or retain the inherited Arena, Insight, language,
  bug-report, and GitHub-setup commands; if retained, repoint them to LAL
  ownership and test them.

## 4. Portability not implemented

These are later roadmap items, not current blockers:

1. Run the host stack on Windows as a same-machine fallback.
2. Make host, ports, storage roots, and model backends configurable instead of
   tied to `main-pc` and one GPU.
3. Support Android/Termux as a client and observer.
4. Revisit macOS only when there is a concrete user or maintainer need.

## 5. Explicitly deferred / out of scope

The following are intentionally not implementation gaps for the current
milestone: public launch and marketplace work, broad community/contribution
automation, new model-training campaigns, large dataset commits, desktop and
IDE products, SDK maintenance, enterprise channels, computer-use automation,
and cosmetic redesign that hides missing system truth.
