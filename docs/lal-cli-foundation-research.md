# LAL CLI foundation research

> Status: historical foundation research. Its separate-repository decision is
> superseded by `docs/plans/project-lal-repository-migration.md`; retain this
> document for the Qwen Code evaluation and local-tool execution proof.

Date: 2026-07-13

## Decision

Use [Qwen Code](https://github.com/QwenLM/qwen-code) as the upstream foundation for the full `lal` terminal client. Keep the current dependency-free `bin/lab-agent` as a recovery/bootstrap client until the replacement is proven on Linux, Windows, and Android.

Qwen Code is Apache-2.0, TypeScript/Node 22+, and already contains nearly every difficult terminal feature LAL needs: a rich interactive TUI, local file and shell tools, OpenAI-compatible providers, automatic project-scoped sessions, resume/search/branch/rewind/restore/export, model and effort selectors, approval modes, voice dictation, subagents, workflows, goals, memory, MCP, LSP, skills, hooks, worktrees, a daemon, and SDKs.

The selected upstream was cloned as the separate repository `lal-cli/`. That
separate-repository choice is superseded by the Project-LAL migration plan; this
record remains for the foundation evaluation and compatibility proof.

## Required execution model

The CLI must run on the computer that owns the project. Only inference runs on `main-pc`.

```text
client PC / Android terminal                         main-pc
┌──────────────────────────────────────┐            ┌─────────────────────────┐
│ cd project                           │            │ LAL inference gateway   │
│ lal                                  │  Tailscale │ model queue + profiles  │
│                                      ├───────────►│ llama.cpp / Ollama      │
│ TUI + session store                  │   HTTPS    │ Hive model registry     │
│ read/edit/write/bash/git/LSP/MCP     │◄───────────┤ streamed completions    │
└──────────────────────────────────────┘            └─────────────────────────┘
```

This is not an SSH folder-sync design. The client sends prompts, tool definitions, and tool results to `main-pc`; it executes file and shell tools locally. Consequently:

- paths remain native to the client computer;
- Git credentials and working-tree state remain on the client;
- no repository copy is required on `main-pc`;
- the same `lal` command works in any local directory;
- session history can be indexed by the local project path/repository identity.

Qwen Code already stores chats as project-scoped JSONL under `~/.qwen/projects/<sanitized-cwd>/chats`. The LAL fork will rename this root to `~/.lal` and add a stable repository identity so moving or renaming a checkout does not make its sessions disappear.

## Live compatibility proof

An unmodified published Qwen Code 0.19.9 client was installed in `/tmp` with lifecycle scripts disabled and pointed directly at LAL's llama.cpp OpenAI-compatible endpoint.

Tested configuration:

- client working directory: `/tmp/lal-qwen-project`;
- inference model: `qwen3-4b-stock` on `main-pc`;
- llama.cpp context: 32,768;
- client mode: headless, `approval-mode=yolo` only inside the disposable test directory;
- provider: OpenAI Chat Completions at `http://127.0.0.1:8099/v1`.

Observed results:

1. A full agent request containing 19,138 input tokens returned exactly `LAL_QWEN_OK`.
2. A second session produced a valid `write_file` tool call.
3. The Qwen client executed that tool locally and created `/tmp/lal-qwen-project/remote-proof.txt` containing exactly `TOOLS_RUN_ON_CLIENT\n`.
4. The model received the local tool result and returned exactly `TOOL_LOCAL_OK`.
5. The tool-call turn reported 19,114 cached input tokens; the complete two-round run took about 24 seconds.
6. Separate JSONL conversations were automatically written to the project-specific chats directory.

This proves the critical architecture: inference can stay on `main-pc` while tools and project mutations occur on another client machine.

The test also found two integration constraints:

- the complete client prompt/tool schema is roughly 19.5k tokens, so the present 8k LAL context is insufficient for the full client;
- an 8B model at 32k plus overlapping requests caused a Vulkan `ErrorDeviceLost` on this 8GB GPU.

The safe prototype profile is therefore the 4B model at 32k, one active GPU generation at a time. The production gateway must serialize GPU work, reject or queue incompatible workloads, select context-aware model profiles, and recover from backend failure. A raw unauthenticated reverse proxy is not sufficient.

## Candidate audit

### 1. Qwen Code — selected

- License: Apache-2.0.
- Provider fit: native custom OpenAI-compatible endpoints and documented local vLLM/Ollama/LM Studio configurations.
- Sessions: automatic project-scoped JSONL; `/resume`, search, rename/tag, branch, fork, rewind, restore, export, and CLI resume flags.
- Agent system: subagents with individual prompts/models/tool policies, background tasks, workflows, goals, Arena, and hooks.
- Safety: folder trust, plan/default/auto-edit/auto/yolo approval modes, permissions, and sandbox support.
- LAL UI parity: `/model`, `/effort`, `/voice`, `/plan`, `/approval-mode`, memory, skills, MCP, LSP, multi-directory/worktree support, and daemon/web surfaces.
- Cost: it is a large, rapidly moving monorepo and its complete prompt is expensive for small local contexts.

Primary references: [repository](https://github.com/QwenLM/qwen-code), [model providers](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/model-providers.md), [commands](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/commands.md), [subagents](https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/), [hooks](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md), [showcase/voice](https://qwenlm.github.io/qwen-code-docs/en/showcase/).

### 2. OpenCode — strongest runner-up

- License: MIT.
- Strengths: polished TUI, broad provider support, custom OpenAI-compatible providers, local models, sessions, agents/subagents, permissions, MCP, LSP, plugins, and client/server architecture.
- Important limitation: `opencode attach` attaches to the remote server's working directory. It does not make a remote backend operate on an unrelated local client folder. For LAL's requirement, OpenCode would still need to run locally and use `main-pc` only as its model provider.
- Cost: the current implementation is a large Bun/TypeScript monorepo in an active architecture migration. Native voice is not comparable to Qwen Code's current feature.

Primary references: [repository](https://github.com/anomalyco/opencode), [providers](https://opencode.ai/docs/providers/), [CLI documentation source](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/cli.mdx).

### 3. Pi — best small-core fallback

- License: MIT.
- Strengths: compact TypeScript agent/TUI, excellent extension API, local OpenAI-compatible providers, project-organized JSONL session trees, resume/fork/export, thinking levels, and Windows/Termux guidance.
- Limitation: Pi intentionally ships with no subagents and no permission popups. Both are delegated to extensions or external isolation, so substantial LAL functionality would have to be built.
- Best use: reference implementation or fallback if maintaining the Qwen fork becomes too expensive.

Primary references: [repository](https://github.com/badlogic/pi-mono), [coding-agent documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md), [custom providers](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md).

### 4. Goose

- License: Apache-2.0; now under the Agentic AI Foundation.
- Strengths: mature Rust agent, local/custom providers, extensions, sessions, and ACP integrations.
- Limitation: much larger checkout and less aligned with the exact terminal UI/voice/mode experience requested here. It offers less leverage than Qwen Code for LAL-specific work.

Primary reference: [repository](https://github.com/aaif/goose).

### 5. Codex CLI and Gemini CLI

Both are serious Apache-2.0 terminal agents with mature tool loops and resumable sessions. Codex is especially strong for sandboxing and code execution, while Gemini CLI is the ancestor of much of Qwen Code's architecture. They are less suitable foundations because their provider/product assumptions are tighter; Qwen Code already adds the OpenAI-compatible/local-provider layer and several requested features.

Primary references: [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli).

### 6. Aider

- License: Apache-2.0.
- Strengths: outstanding Git-native editing, repository maps, undo/commits, and OpenAI-compatible local endpoints.
- Limitation: it is primarily a pair-programming/edit protocol, not a general multi-agent terminal platform. Hive, voice, permission modes, daemon operation, and rich local tools would be a larger retrofit.

Primary references: [OpenAI-compatible APIs](https://aider.chat/docs/llms/openai-compat.html), [Git integration](https://aider.chat/docs/git.html).

### 7. Crush — rejected on license

Crush has an excellent Go/Bubble Tea interface, local OpenAI-compatible providers, SQLite project sessions, MCP, LSP, and hooks. Its current FSL-1.1-MIT license prohibits competing use until the future MIT conversion date. Building and distributing a similar LAL agent CLI on it would create avoidable license risk, so it is not an acceptable foundation.

Primary references: [repository](https://github.com/charmbracelet/crush), [license](https://github.com/charmbracelet/crush/blob/main/LICENSE.md).

## LAL feature mapping

| LAL concept | Foundation mechanism | LAL work required |
| --- | --- | --- |
| Default coding | Base Qwen agent and local tools | Rebrand prompts and defaults |
| Quick edit | Agent/profile with fast model and lower effort | Add `/mode quick` preset |
| Planning | Plan approval mode | LAL theme and mode selector |
| Deep research | Research agent, web tools, subagents | Port LAL deliberate/research policy |
| Orchestrator | Qwen subagents/background tasks | Ship LAL role definitions and telemetry |
| Hive | Workflows + subagents + LAL DAG engine | Port presets, provenance, steering, evaluation |
| Deliberate | Arena/subagents/workflows | Implement LAL debate/synthesis workflow |
| Chat | Tool-restricted agent | Add `/mode chat` preset |
| Model selection | `/model` and provider catalog | Dynamic catalog from LAL gateway |
| Effort | `/effort` | Map levels to local-model thinking/profile limits |
| Voice | `/voice`, push-to-talk, voice model | Connect LAL ASR/TTS or retain browser fallback |
| Resume by folder | Project-scoped JSONL and `/resume` | Rename storage and add stable repo identity |
| Safety | trust, permissions, approval modes, sandbox | LAL defaults and remote-token policy |

## Gateway contract

Expose a tailnet-only, bearer-authenticated OpenAI-compatible service from `main-pc`:

- `GET /api/llm/v1/models`: dynamic LAL model catalog and capabilities;
- `POST /api/llm/v1/chat/completions`: streaming completions and tool calls;
- model aliases instead of filesystem paths;
- per-model context, tool, thinking, vision, and concurrency metadata;
- a single GPU scheduler shared by CLI, web chat, Hive, benchmarks, and training;
- cancellation propagated to llama.cpp/Ollama;
- automatic backend restart after health failure;
- no generic server-side filesystem tools in this route;
- per-device tokens that can be revoked without changing the tailnet.

Tailscale protects network reachability, but it should not be the only authorization layer because the endpoint can spend GPU time and receive sensitive tool results.

## Delivery sequence

1. Add the authenticated LAL inference gateway and model catalog.
2. Create a thin `lal` distribution from the cloned upstream with LAL paths, branding, defaults, and provider auto-configuration.
3. Prove Linux-to-main-pc and Windows-to-main-pc editing with tools executed locally.
4. Add stable per-repository session identity and migration from the current CLI conversation store.
5. Port modes in order: default/chat/plan, deep research, deliberate, then Hive.
6. Connect voice and add Android Termux packaging.
7. Keep browser `/chat` as the no-install phone experience; use Termux for Android projects. iOS cannot safely expose arbitrary local folders and shell execution to a web page, so iPhone local-project operation needs SSH/web or a dedicated app.

## Installation expectation

A different computer does need a client binary or package installed once; Tailscale alone cannot create a `lal` command or grant a web page access to that computer's local shell. The target experience is still one command:

```text
install once -> cd any/project -> lal
```

Windows should receive a signed standalone executable/installer or a PowerShell bootstrap. Linux and Android Termux can use a standalone build or Node package. A phone browser requires no LAL CLI installation, but it operates on projects reachable by the server/SSH rather than arbitrary files stored locally on the phone.
