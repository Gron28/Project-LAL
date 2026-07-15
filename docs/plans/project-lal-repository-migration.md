# Project-LAL single-repository migration plan

Status: implementation in progress. The CLI source has been absorbed into
`apps/cli/`; archived experiments and generated datasets have been removed from
the working tree after a Desktop archive and checksum manifest were created.
Last updated: 2026-07-14.

## Goal

Replace the current nested Git repository/submodule arrangement with one lean
Project-LAL repository. The result must make it obvious which code ships, which
runtime state is local, and which experiments are historical rather than part
of the product.

## Current problem

- The root repository and `lal-cli/` were separate Git repositories even though
  they pointed to the same GitHub project on different branches.
- The web app mirrors a protocol into the nested CLI by path, making one product
  depend on accidental repository layout.
- The root includes disposable Hive sandbox applications and datasets alongside
  shipping source.
- The CLI brings a very large inherited Qwen surface, including upstream GitHub
  automation, public documentation, cloud providers, channels, SDKs, desktop
  code, and unrelated products.
- Root and CLI READMEs present conflicting identities and installation stories.

## Non-destructive rules

1. Preserve the current root branch, current CLI branch, uncommitted design
   work, and local-only artifacts before moving anything.
2. Keep Apache-2.0 attribution and the Qwen Code derivation notice.
3. Do not delete experiments or datasets during planning. First create a small
   historical training summary and move raw material outside the repository or
   into an explicit archive.
4. Do not combine package managers or rewrite the CLI tool loop merely to make
   the directory tree look tidy.
5. Every migration step must be independently buildable or reversible.

## Proposed end state

| Current area | Intended disposition |
| --- | --- |
| `web/` | Move to `apps/web/`; remain the host/control plane. |
| `lal-cli/` | Absorbed into `apps/cli/`; Git history preserved in the external migration archive. |
| Protocol mirror | Replace with `packages/protocol/`, consumed by both apps. |
| `scripts/` and `bin/` | Keep only LAL-owned launch, release, diagnostics, and migration scripts. |
| `data/` | Retain small fixtures and compiler inputs only; archive unsuccessful/generated datasets. |
| `models/`, `out/`, `.venv/`, `llama/` builds, `.data/` | Local runtime state; never commit. |
| `hive-*` directories | Move outside the repo for archival; retain one short experiment summary in docs. |
| `lab-agent` | Transitional recovery client; remove after LAL reliability milestone. |
| CLI desktop/SDK/channels/CUA/docs-site | Remove unless a later explicit product decision restores one. |

## Migration phases

### 0. Preserve and classify — completed for the first reset

- Record branch heads and local changes for both repositories.
- Produce a source/runtime/archive inventory with sizes and ownership.
- Write `docs/history/training-experiments.md`: a short account of attempted
  datasets, outcomes, and lessons, without retaining bulky generated artifacts.
- Move personal/archive material only after verifying it is copied and excluded
  from the clean repository.

### 1. Establish one workspace contract

- Add a root workspace manifest and a single documented development entry point.
- Keep web and CLI dependency installation separate initially if that is the
  least risky choice; unify only after builds are known-good.
- Centralize shared configuration for formatting, tests, ignores, and release
  metadata where it genuinely applies.

### 2. Absorb the CLI safely — completed in the working tree

- Preserve the CLI fork commit and upstream remote reference in migration notes.
- Move the LAL-maintained CLI source into `apps/cli/`.
- Remove `.gitmodules` and the gitlink only once the absorbed copy builds and
  tests in the root repository.
- Keep derivation notices and a documented upstream reference; future updates
  are selective LAL-owned changes, not automatic synchronization.

### 3. Create a real shared protocol boundary

- Move event/API schema and fixtures into `packages/protocol/`.
- Make web and CLI import that package rather than generate a source mirror.
- Add compatibility fixtures for a code run and a host/attach run.

### 4. Reduce inherited surface

- Remove cloud-provider onboarding, phone-home telemetry, upstream update
  checks, enterprise channels, public docs site, desktop application,
  mobile-MCP, general SDKs, computer-use driver, broad locale machinery, and
  upstream GitHub bots/workflows.
- Audit daemon/ACP, VS Code, Zed, audio, and web-shell code before retaining
  them. Keep only a measured dependency that enables Project-LAL's core flow.
- Replace upstream package names, badges, links, and release routes with LAL
  equivalents or delete them.

### 5. Present one honest repository

- Keep the root README concise and internal-facing.
- Add a root Apache-2.0 license and Qwen derivation notice appropriate to the
  final composition.
- Add only lightweight GitHub hygiene needed by an invite-only project: issue
  defaults and CI for the supported core path, not public-growth automation.
- Keep research notes accessible under `docs/`, clearly labelled as historical,
  deferred, or current.

## Completion criteria

- `git status` shows one repository and no submodule.
- A fresh clone can identify the supported topology, install only the needed
  dependencies, run the core checks, and distinguish source from runtime state.
- Web and CLI share one protocol package.
- No default code path calls Alibaba/Qwen telemetry, provider onboarding,
  upstream release URLs, or unrelated bot/channel infrastructure.
- The README describes current limitations honestly and points to one roadmap.
