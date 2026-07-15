# Project-LAL architecture

Status: current product architecture. Last updated: 2026-07-14.

## Purpose

Project-LAL is a private, local-first AI environment that gives a person
practical control over their models, data, projects, and computing tools. It
must be usable without a cloud-provider account, understandable while it is
working, and adaptable to whatever computer the owner can host it on.

LAL is the terminal command and short product name. Project-LAL is the project
and repository name. `LALF` is retired terminology.

This is not yet a public product. It is an internal system being made reliable
enough to use daily and eventually share with invited people who can host their
own instance.

## Product principles

1. **Ownership over dependence.** Models, data, session history, credentials,
   and project files stay under the host owner's control. External services are
   optional integrations, never a requirement for the core experience.
2. **Truthful observability.** The UI and CLI expose real run state, model load
   state, context use, throughput, GPU/CPU/memory use, process failures, and
   durable artifacts. Decorative progress and silent background work are bugs.
3. **Local tools stay local.** A coding agent executes file, shell, Git, LSP,
   and MCP tools on the computer containing the project. A remote inference host
   never mutates a client project directly.
4. **One session across personal devices.** A person can start work from a
   Windows laptop, observe or continue an attach-mode session from a phone, and
   reconnect without losing server-side work.
5. **Reliability before breadth.** A working Chat/Code/reconnect lifecycle is
   more valuable than another mode, model, dashboard, integration, or training
   experiment.
6. **Accessible by inspection.** The system should make its behavior legible to
   its owner, including failures and limits, rather than requiring trust in a
   hidden service.

## Immediate topology

```text
Windows laptop                         Linux main-pc                    Phone
┌───────────────────────┐          ┌─────────────────────────┐     ┌───────────┐
│ lal in local project  │          │ Project-LAL web server  │     │ web UI    │
│ file/shell/git/MCP    │──HTTPS──▶│ model gateway + GPU     │◀───▶│ same run  │
│ local approvals       │          │ durable runs + storage  │     │ observe / │
└───────────────────────┘          │ Hive/research/train     │     │ continue  │
                                   └─────────────────────────┘     └───────────┘
```

The Linux host is the most capable computer today. Tailscale is the preferred
personal-device transport, not a product dependency: the host must work locally
when the internet is unavailable. If the Linux host is lost or unsuitable, the
same Project-LAL system must be adaptable to run and be used on a Windows host.
That portability is designed and tested incrementally; it is not a promise of
full laptop-local inference in the first foundation milestone.

## Execution modes

| Mode | Execution owner | Persistence and continuity |
| --- | --- | --- |
| Chat | Host | Durable server conversation and run; CLI/web can reattach. |
| Research | Host | Durable deliberate run and artifacts; CLI/web can reattach. |
| Hive | Host initially | Durable workflow and ledger; remote project mutation is deferred. |
| Code | Client project + host inference | Tools run locally; local ledger persists; server-side observability follows later. |
| Train and bench | Host | Host-owned jobs, artifacts, and resource scheduling. |

The first end-to-end acceptance flow is: start `lal` in a Windows project,
infer on the Linux host, and observe or continue the same attach-mode session
from the phone web interface.

## Safety and trust boundary

Project-LAL supports personal autonomy, privacy, defensive security research,
and testing systems that the owner is authorized to assess. It must not collect
project contents, prompts, paths, or tool arguments merely to identify a
device. It does not need external model-provider telemetry.

Local model control is not a reason to build unsafe automation. Operational
security features are limited to defensive, authorized uses; approvals,
sandboxing, and local ownership remain visible to the user.

## Target repository shape

One Project-LAL Git repository owns the runnable product:

```text
apps/
  web/                 # Project-LAL host web app and API
  cli/                 # LAL terminal client, derived from Qwen Code
packages/
  protocol/            # Versioned event/API contract shared by web and CLI
  shared/              # Only genuinely shared runtime-neutral utilities
scripts/               # Build, release, migration, and maintenance scripts
ml/                    # Training and dataset compiler source, not model output
data/
  fixtures/            # Small committed test/evaluation fixtures only
docs/                  # Current decisions, roadmap, and retained research
tests/                 # Cross-application verification
```

Models, virtual environments, caches, generated training output, production
run data, and disposable evaluation projects are local runtime state outside
the repository. Large datasets are generated or explicitly archived, not
silently accumulated in Git.

## Deliberate exclusions

Until a concrete need proves otherwise, Project-LAL does not maintain inherited
Qwen cloud providers, enterprise channels, desktop/Electron surfaces,
mobile-MCP, general SDKs, docs sites, computer-use drivers, broad locale packs,
or GitHub bot automation. VS Code/Zed integrations may return only if they can
be kept small and clearly reduce daily friction.

The retained CLI foundation is the terminal UI, local tool loop, approval and
sandbox mechanisms, session recovery, MCP/LSP, Git/worktree support, and
headless operation. The daemon/ACP path is kept only after an audit proves it
is needed for LAL's cross-device lifecycle rather than inherited complexity.
