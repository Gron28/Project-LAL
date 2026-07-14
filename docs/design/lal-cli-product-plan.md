# LAL CLI product plan

Status: approved planning baseline, not yet implemented beyond the prototype foundation  
Last updated: 2026-07-14

## Product goal

`lal` must feel like Local AI Lab in a terminal, not like a renamed upstream CLI.
From any folder on any Tailscale-connected computer, the user launches one command,
selects a Local AI Lab model and operating mode, sees reasoning and work stream in
real time, and lets the client modify the project on that computer while inference
runs on `main-pc`.

The client must also preserve project-scoped conversations, resume them from the
same folder, update in place, identify every connected device, and expose the same
important controls already present in the Local AI Lab web UI.

## Current working foundation

The prototype already proves the critical distributed architecture:

- `lal` starts in the caller's current directory on Windows.
- File, shell, Git, LSP, and other project tools run on the client computer.
- OpenAI-compatible model inference is streamed from `main-pc` over Tailscale.
- Authenticated installers, device identities, connection auditing, model discovery,
  and an idempotent `lal update` channel exist.
- Conversations are stored under `~/.lal/projects` and remain local to the client.
- The Windows client is a checksum-verified standalone archive with its own Node
  runtime; installing it does not require Node or Qwen Code.
- The native fork has the approved LAL monogram and cyan/green/yellow palette.

This is a sound transport and agent-tool foundation. The remaining problem is
product identity and system integration: too much inherited provider, terminology,
command, and presentation behavior is still visible.

## Remove or hide from the default LAL experience

### Upstream identity and onboarding

- Alibaba ModelStudio onboarding, token plans, and provider marketing.
- Upstream terms/privacy links and Qwen support destinations.
- `QWEN.md` tips as the primary project-memory instruction. `LAL.md` is primary;
  `AGENTS.md` and `QWEN.md` remain compatibility inputs only.
- Qwen/Gemini product names in prompts, warnings, help, snapshots, diagnostics,
  settings labels, environment-variable guidance, and generated files.
- Upstream update channels, npm installation instructions, bug-report links, and
  telemetry destinations.

### Provider abstraction leaked into the UI

- `[openai]` beside every local model. OpenAI is the wire protocol, not the owner.
- The duplicated `LAL · model-name` label and its mojibake form (`LAL Â·`).
- Raw `Base URL` and `API Key` fields in the normal model picker.
- Generic provider creation and third-party API-key setup in the primary flow.

The normal picker should show the model name, Local AI Lab family or role, modality,
context, availability, loaded state, speed/size when known, and which computer serves
it. Protocol and endpoint details belong in an advanced connection screen.

### Weight and distraction

- Random inherited loading phrases. Replace them with real state such as queuing,
  loading a model, thinking, calling a tool, waiting for approval, or verifying.
- Cloud channels, hosted-account flows, IDE promotion, GitHub setup, desktop/mobile
  product surfaces, and extension marketplace screens that are not part of the LAL
  terminal product.
- Upstream analytics/telemetry, surveys, notices, scheduled-task features, and
  computer-use features until LAL explicitly adopts and secures them.
- Duplicate slash commands and aliases that expose the foundation's internal
  organization rather than LAL's workflows.
- Bundled docs, translations, examples, SDKs, templates, and release jobs not needed
  to build or ship the terminal client. Keep required licenses and derivation notices.

Removal should happen in two stages: hide and disconnect first, then delete only
after dependency tracing and regression tests prove the code is unused.

## Keep and harden from the foundation

- Ink-based full-screen terminal rendering and keyboard navigation.
- Streaming assistant output, tool calls, diffs, shell output, and cancellation.
- Local file/shell/Git/LSP/MCP tools and folder trust boundaries.
- Approval modes, sandbox hooks, ignore files, memory loading, and session resume.
- Model/provider transport internals, while presenting them as a managed LAL
  connection.
- Context accounting, retry/error handling, compressed history, headless operation,
  and accessibility primitives.
- Apache-2.0 license and accurate attribution to the upstream foundation.

## Add from Local AI Lab

### Home screen and persistent status

The opening screen should immediately show:

- the approved LAL mark and palette;
- current project and Git branch;
- selected model, mode, and effort;
- `main-pc` connection and GPU/model state;
- context use and session identity;
- tool permission state;
- concise shortcuts for resume, model, mode, settings, and help.

### First-class operating modes

- **Default:** one capable agent balances planning, implementation, and verification.
- **Code:** project-focused implementation with diffs, commands, diagnostics, and
  tests visible as they happen.
- **Hive:** coordinator, planner/researcher, coder/repairer, and independent verifier
  work through typed handoffs and a shared workspace.
- **Deliberate research:** plan, search/read, compare evidence, synthesize, and cite;
  filesystem mutations remain off unless explicitly enabled.
- **Chat:** conversational use with optional voice and no implied project mutation.
- **Lab:** model evaluation, benchmark, training, provenance, and promotion controls
  exposed intentionally rather than mixed into normal coding.

Modes must be real server/client capabilities, not prompt-label cosmetics.

### Model thinking and J-space

- Stream model thinking in real time when the selected model/runtime exposes it.
- Give thinking a collapsible panel with clear separation from the final answer.
- Preserve the raw stream for the active session without pretending hidden reasoning
  exists when a provider does not supply it.
- Show J-space/certainty as a small live graph with confidence, uncertainty, branch,
  recovery, and convergence events.
- Let the user expand the graph into an event timeline tied to tool calls and file
  mutations.

### Real-time agent work

- Stream tool arguments while they are being formed.
- Show file writes as live diffs, shell commands as live output, and diagnostics/tests
  as structured results.
- Allow approve, reject, edit, stop, retry, and redirect without losing the session.
- Show queueing, model load, token generation, tool execution, verification, and
  recovery as concrete states.
- Keep an append-only activity timeline so Hive handoffs and repairs are inspectable.

### Project and session behavior

- Derive a stable project identity from the repository root when one exists and the
  canonical folder path otherwise.
- Store chats per project and offer the most recent resumable sessions on launch.
- Support `lal --resume`, `lal --new`, named sessions, search, fork, archive, export,
  and delete.
- Keep histories on the client by default because project paths and tool output belong
  to that machine. Sync only explicit metadata or an opt-in encrypted history.
- Load `LAL.md`, relevant `AGENTS.md`, selected skills, and repo instructions with a
  visible context inspector.

### Voice

- `/voice` opens the same voice-chat capability used by `/chat` when the terminal can
  capture and play audio.
- On constrained clients, show a Tailscale URL/QR handoff to the web voice UI while
  keeping the same session.
- Display listening, transcribing, thinking, speaking, muted, and disconnected states.
- Never silently record; microphone start/stop must always be explicit and visible.

### Security and fleet controls

- Keep stable device IDs and `./start.sh --list-cli-devices`.
- Add approve/revoke/rename device controls, last-seen/request metadata, token rotation,
  and a visible warning for rejected attempts.
- Move from one shared prototype token toward per-device credentials.
- Never record prompts, project paths, tool arguments, or file contents in the device
  registry.
- Make local execution boundaries and approval policy visible at all times.

## Proposed command surface

Keep the first level small and LAL-specific:

| Command | Purpose |
| --- | --- |
| `/model` | Select a Local AI Lab model and inspect load/context capability. |
| `/mode` | Switch Default, Code, Hive, Research, Chat, or Lab. |
| `/effort` | Set fast, balanced, high, or maximum reasoning/tool budget. |
| `/thinking` | Toggle/collapse the live thinking panel. |
| `/jspace` | Toggle or expand the certainty graph and event timeline. |
| `/project` | Inspect project identity, root, Git state, and instructions. |
| `/session` | Resume, name, fork, search, export, archive, or delete chats. |
| `/context` | Inspect context sources, size, and compression. |
| `/memory` | Edit or reload persistent project guidance. |
| `/tools` | Inspect local tools and their availability. |
| `/permissions` | Change approval and sandbox policy. |
| `/git` | Inspect branch/diff/status and common safe operations. |
| `/preview` | Open or inspect the current application preview. |
| `/ground` | Search/read sources and manage citations. |
| `/hive` | Inspect workers, handoffs, shared workspace, and verification. |
| `/lab` | Enter model/training/evaluation controls. |
| `/voice` | Start, stop, or hand off voice chat. |
| `/stop` | Cancel current generation or tool execution. |
| `/settings` | Open LAL settings. |
| `/update` | Update the managed client in place. |
| `/help` | Show the concise LAL command guide. |
| `/quit` | Exit without losing the resumable session. |

Advanced foundation commands can remain discoverable under `/advanced` until LAL
either adopts or removes them.

## Distributed architecture

```text
client computer                                main-pc
┌───────────────────────────────┐              ┌────────────────────────────┐
│ lal TUI in the project folder │  Tailscale   │ authenticated LAL gateway  │
│ sessions + project context    │◄────────────►│ model catalog + GPU queue  │
│ file/shell/Git/LSP/MCP tools  │  event stream│ llama.cpp + Lab services  │
│ approvals + sandbox boundary  │              │ Hive/research orchestration│
└───────────────────────────────┘              └────────────────────────────┘
```

The non-negotiable rule is that project tools execute where the project lives.
For a repository on another computer, Hive cannot execute its shell/filesystem work
inside `main-pc`. The orchestration service must dispatch typed tool requests back to
the authenticated client, receive streamed results, and preserve client-side approval
and sandbox policy. Inference and coordination may be remote; authority over the
project remains local.

Use one versioned event protocol for assistant deltas, thinking deltas, J-space
events, tool-call drafts, approvals, tool output, file diffs, worker handoffs, usage,
errors, cancellation, and resume cursors. That protocol should serve both the CLI and
web UI so the two products do not drift.

## Delivery phases

### Phase 0 — stabilize the prototype

- Fix encoding and settings migration permanently with fixtures for Windows code
  pages, UTF-8 without BOM, and atomic rollback.
- Make model ownership `local-ai-lab`; remove `[openai]` and duplicate LAL labels.
- Ensure no normal startup path can show upstream onboarding or terms.
- Add smoke tests for install, update, launch, model list, one streamed tool call,
  session resume, and device audit.
- Make build, release, verification, deployment, and Desktop launch repo-owned and
  one-command operations.

### Phase 1 — clean LAL shell

- Replace the opening screen, model picker, settings, help, status line, errors, and
  loading states with the LAL information architecture.
- Hide unused inherited surfaces behind `/advanced`.
- Establish the final command registry and terminology rules.

### Phase 2 — shared streaming protocol

- Define the versioned event schema and resume cursor.
- Stream real model state, thinking where available, tool drafts/output, diffs, usage,
  and cancellation through the gateway.
- Build the terminal activity timeline and collapsible thinking view.

### Phase 3 — modes and effort

- Integrate Default, Code, Deliberate Research, Chat, and Lab with real Local AI Lab
  services.
- Define effort as explicit token, planning, search, verification, and retry budgets.
- Add mode-specific permission defaults and visible transitions.

### Phase 4 — Hive remote workspace

- Implement authenticated bidirectional tool dispatch to the client project.
- Render worker graph, typed handoffs, shared plan, live workspace changes, verifier
  verdicts, and repair loops.
- Prove no server-side path can accidentally mutate a remote client's repository.

### Phase 5 — J-space and voice

- Emit and visualize certainty/recovery/convergence events.
- Integrate native terminal voice where available and web handoff elsewhere.
- Keep the same session across text, voice, CLI, and web reattachment.

### Phase 6 — hardening and distribution

- Per-device credentials, revoke/rotate, signed manifests, rollback, and fleet status.
- Native Windows, Linux x64/ARM64, and macOS x64/ARM64 releases.
- Small delta-aware updates or cached runtime layers so normal updates do not rewrite
  tens of megabytes unnecessarily.
- Compatibility tests across CMD, PowerShell, Windows Terminal, bash, zsh, SSH, and
  phone-based terminal/web handoff.

## Acceptance criteria for “LAL, not a clone”

- A new user sees no Qwen, Gemini, Alibaba, or OpenAI product/provider branding in the
  normal flow. Required upstream attribution remains in licenses/about.
- Running `lal` from any project on an enrolled Tailscale computer operates on that
  project locally and uses `main-pc` inference remotely.
- Model selection clearly represents Local AI Lab models without protocol leakage or
  mojibake.
- Thinking, tool work, code diffs, verification, and J-space events are live and
  truthful; decorative fake progress text is absent.
- Modes invoke distinct, tested capabilities and can be changed without losing the
  session.
- Chats resume by project after restart and survive `lal update`.
- Every connected device is visible and revocable without collecting project content.
- The CLI can be built, packaged, verified, deployed, and launched from repository
  commands documented next to the source.

## Immediate next implementation slice

The first coding slice should be deliberately narrow:

1. Replace the model picker rows with `name · family/role · status`, set ownership to
   `local-ai-lab`, and eliminate the broken middle-dot encoding path.
2. Remove provider onboarding from every managed startup and repair path.
3. Replace random phrases with a typed runtime-state component.
4. Introduce `/mode`, `/effort`, `/thinking`, and `/jspace` command shells backed by a
   versioned settings schema, even before every server capability is connected.
5. Add an event-stream adapter for visible thinking/tool/code deltas and test it
   against the existing OpenAI-compatible gateway.

That slice produces an unmistakably LAL opening experience while laying the protocol
foundation for Hive, research, J-space, and voice instead of hard-coding separate UI
paths for each feature.
