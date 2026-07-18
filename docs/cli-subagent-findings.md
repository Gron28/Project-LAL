# CLI subagents — diagnosis (explored 2026-07-18)

Paths relative to `apps/cli/packages/core/src/`. Verdict: subagents are architecturally fine; they were killed by the provider tool-call-id dedup bug, and the uncommitted working-tree changes are the (in-progress) fix.

## Why they "don't work" — ranked
1. **PRIMARY: providerCallId reuse.** Local OpenAI-compat servers reuse one tool-call id for every call. Pre-fix, `AgentCore.processFunctionCalls` deduped on raw `providerCallId`, so a subagent's 2nd+ tool calls were suppressed as duplicates (synthetic "Duplicate provider tool call id … ignored" response, no execution) and `findRepeatedDuplicateProviderToolCall` could terminate it with LOOP_DETECTED → empty output. The **uncommitted diff** in `agents/runtime/agent-core.ts` (~1443-1527) + `core/turn.ts` (`getToolCallDedupIdentity`, `resetSemanticToolCallDedupAfterMutation`, `isMutationBoundaryTool`) switches identity to `id+name+args` and resets after mutations; `agent-headless.test.ts` expectations already flipped. **If the installed build predates these edits, subagents still fail — rebuild/finish this changeset first.**
2. **Quiet non-GOAL termination:** MAX_TURNS/TIMEOUT/LOOP_DETECTED or GOAL-with-empty-text returns thin text, `success = terminateMode===GOAL` (tools/agent/agent.ts:1893) — parent reads "did nothing", no error shown.
3. Bare mode doesn't register the Agent tool at all (cli config.ts:6546-6584); `excludeTools`/`coreTools` can also remove it.
4. Only misconfig risk: subagent frontmatter `model:` / `agents.builtin.exploreModel` resolving to an unconfigured provider builds a divergent ContentGenerator (subagents/subagent-manager.ts:1018-1038). Plain inherit shares parent auth/baseURL/model correctly.
5. Always-on safeties (5 byte-identical consecutive calls, 100/turn cap) still run inside subagents regardless of skipLoopDetection (agent-core.ts:773).

## Architecture map
- `AgentCore` (agents/runtime/agent-core.ts): reasoning loop, createChat:399, runReasoningLoop:751, processFunctionCalls:~1364.
- `AgentHeadless` (agent-headless.ts): create:165, execute:203 → result = getFinalText()+terminateMode.
- `SubagentManager.createAgentHeadless` (subagents/subagent-manager.ts:755).
- Model-facing tool `AgentTool` = `'agent'` (tools/agent/agent.ts:728), registered by default (cli config.ts:6581), param `prompt` (+optional `subagent_type`, default general-purpose). Depth cap `maxSubagentDepth` default 5.
- UI: `task_execution` cards in ToolMessage.tsx:198+, live views in background-view/LiveAgentPanel.tsx, agent-view/*, hooks/useAgentStreamingState.ts.
- Errors that THROW do surface as failed tool cards (agent.ts:1936-1955); early-terminations don't.
