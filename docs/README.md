# Project-LAL documentation

This directory is intentionally small and decision-oriented. Product truth
lives in the current architecture and roadmap; old research remains available
as background, not as a promise or implementation queue.

## Current authority

- [Project architecture](design/project-lal-architecture.md) — product purpose,
  topology, boundaries, and target monorepo.
- [Foundation roadmap](plans/project-lal-foundation-roadmap.md) — the ordered
  reliability work that must precede feature expansion.
- [Repository migration](plans/project-lal-repository-migration.md) — how to
  replace the nested CLI repository with one clean Project-LAL repository.
- [Capability elevation plan](plans/project-lal-capability-elevation-plan.md) —
  deep architecture and phased plan for model lifecycle, evaluation,
  multimodality, resource-aware HIVE specialists, defensive research,
  whole-system host portability, training, and inherited CLI provenance/reduction;
  subordinate to the foundation roadmap.

## Current implementation inventories

- [Storage and retention inventory](design/storage-retention-inventory.md) —
  the current mutable roots, effective retention, reference protections, and
  deliberate gaps before registry-backed cleanup.
- [Host-assumption inventory](design/host-assumption-inventory.md) — a redacted,
  hash-based current-host reproducibility snapshot for portability changes.
- [Platform directories and host profiles](design/platform-host-profile-boundary.md)
  — portable state roots, strict compatibility profiles, and safe diagnostic
  fact export.
- [LAL CLI provenance and egress baseline](design/lal-cli-provenance-egress-baseline.md)
  — source-backed initial ledger and outbound-destination inventory, with an
  executable source-anchor check.

## Supporting designs

- [LAL CLI product plan](design/lal-cli-product-plan.md) — detailed capability
  inventory and implementation notes; subordinate to the foundation roadmap.
- [LAL distribution](design/lal-cli-distribution.md) — internal bootstrap and
  update-channel notes, deferred until the core flow is reliable.
- [Open inquiry](design/open-inquiry-protocol.md) — deferred research/training
  design; not current product work.

## Historical research

The other documents record experiments, model choices, orchestration research,
and training lessons. They are retained for context. They do not establish a
shipping commitment, and incomplete experiments should not be revived merely
because a document exists.

- [Training experiment history](history/training-experiments.md) — short record
  of what was tried and why large experimental artifacts do not stay in the
  working repository.
