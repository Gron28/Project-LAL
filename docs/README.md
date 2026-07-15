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
