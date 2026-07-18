# Gateway + HIVE capability inventory (explored 2026-07-18)

For CLI visibility + orchestrator/specialist plans. Paths relative to `web/src/`.

## Gateway (`app/api/llm/v1/chat/completions/route.ts`)
- Thin byte-passthrough proxy to llama.cpp (:8099) or Ollama (:11434), Bearer token auth (`lib/lal-cli.ts:33-52`, `LAL_CLI_TOKEN` / `.data/cli-token`), per-request model routing via `activatePublicModel` (`lib/lab.ts:351-389`), GPU lease mutex serializes CLI completions (`lal-cli.ts:148-160`).
- Streams raw `delta.tool_calls` through untouched; its `observeStream` (route.ts:129-154) parses only usage + logprobs → NO tool_progress mirroring from this path.
- **Logprobs requested only when `!hasTools && !isOllama`** (route.ts:193) → agentic CLI turns capture zero token_confidence. BUT `lib/toolloop.ts:388-451` proves llama.cpp tolerates logprobs+tools with a 400/422/501 retry-fallback (`top_logprobs:8`, p=exp(logprob), alts when p<0.8, per-round conf avg/min/low). The gateway's conservative comment is outdated — port the toolloop approach.
- Host observations appended to the client run ledger: `model_loading`, `model_ready`, `usage`, `token_confidence`, `error` (`appendHostObservationForClientDevice`, runs.ts:299-314).
- Dirty diff: `activatePublicModel` consolidation into lab.ts, browser tools added to `LAL_TERMINAL_TOOLS`, real `observedContext`.

## tool_progress primitive
`ToolLoopEvent` union in `lib/toolloop.ts:17-53`; `tool_progress {id,name,chars,preview(200-char tail)}` throttled ~1/s (toolloop.ts:467-470) — exists ONLY inside `runToolLoop` (server agent loops + hive workers), not the gateway. Run ledgers: `.data/runs/<id>.ndjson` (+`.json` meta, `.client.json` capability), managed by `lib/runs.ts`.

## HIVE (`lib/hive/`)
- Validated DAG + coordinator router, NOT free-form agents. `WorkflowSpec` nodes w/ dependsOn/retry/verificationGate (`contracts.ts:152-173`), Kahn topo-sort validation. Roles in `presets.ts:16-26` (coordinator, planner, researcher, coder, coder_repairer, verifier, …) each with permittedTools + evaluationSuite. Specs: `research-v1` (10 nodes), `coding-v2` (~14 nodes).
- Engine: `engine.ts` (92KB) — `startHiveWorkflow:1067`, `executeNode:818`, routing decisions JSON-schema-constrained (`contracts.ts:211-232`). `SpecialistHandoff` bounded payload between nodes (full outputs stay in SQLite).
- Storage: `.data/hive.db` (workflow_runs, hive_events, node_side_effects, model_profiles, training_examples, datasets, checkpoints…) + content-addressed artifacts `.data/hive/artifacts/`.
- Side-effect replay: sha256(tool+args) fingerprint → execute|replay|uncertain (`store.ts:317-325`, engine.ts:701-705).

## Specialists / model registry
- `allModels()` scans GGUFs + Ollama (`lab.ts:132-168`). Hive `ModelProfile`s probed for tools/structured-output/tok-s (`model-registry.ts:72-199`).
- Fine-tuned specialists = **LoRA adapters over base GGUF**, registered via `<name>.hive-adapter.json` manifests in MODELS_DIR, promotion-gated, content-hash verified. Per-request selection: llama.cpp `--lora` + per-request `lora:[{id,scale}]` in completion body (`toolloop.ts:244,338`; `lab.ts:204,452-456`). Role→model ranking in `model-registry.ts:224-278`.

## Gaps for CLI orchestrator goal
1. Streaming tool-args: CLI must parse `delta.tool_calls` itself (it already does — see cli-visibility-findings.md) OR gateway grows tool_progress host observations.
2. Logprobs during tool turns: port toolloop's retry-fallback into the gateway (route.ts:193) → token_confidence in CLI even in agentic mode. Ollama backend has no logprobs at all.
3. Orchestration endpoints are NOT CLI-reachable: `/api/hive/workflows` and `/api/agent/loop` (with `spawn_agent`, depth-1) lack `cliAuthorized` — browser-session only. Needed: token-authed spawn endpoint + streaming of `workflow_*`/tagged toolloop events over an authed CLI channel (today browser SSE + hive.db only).

## Tailnet
Web app binds :8770; tailnet access via `tailscale serve --https=8443 → 127.0.0.1:8770` (update-all.sh:79).
