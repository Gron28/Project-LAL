# CLI amnesia between messages — diagnosis (explored 2026-07-18)

Paths relative to `apps/cli/packages/core/src/`. History is NOT reset between turns; the loss is in what's transmitted/kept. Ranked causes:

## 1. PRIMARY: prior reasoning is sent as `reasoning_content` — an output-only field the gateway ignores
- Thoughts ARE stored in history (`geminiChat.ts:3800-3989`, curation keeps them).
- On egress, prior thought parts become `assistantMessage.reasoning_content` (`openaiContentGenerator/converter.ts:649-652, 805-807`).
- `provider/default.ts:21-23,117-119` only remaps `reasoning_content`→`reasoning` for model names containing "qwen3"; `ensureReasoningContentOnAssistantMessage` (`provider/utils.ts:13-29`) is wired only into deepseek/mimo providers. Generic inference servers ignore `reasoning_content` on INPUT.
- Net: model never re-reads its own thinking; code written inside `<think>` blocks is lost every turn. Exact match for the symptom.
- Worse: `provider/mistral.ts:59` strips `reasoning_content` from history outright (total reasoning amnesia if endpoint classified as Mistral — relevant for Ministral).
- **Fix direction:** for the LAL gateway, inline prior reasoning back into content (or a provider that re-emits it in whatever field llama.cpp's chat template consumes), and/or gateway-side handling.

## 2. Auto-compaction fires absurdly early on small windows and is lossy
- `services/chatCompressionService.ts:159-194`: `SUMMARY_RESERVE=20_000`, `AUTOCOMPACT_BUFFER=13_000`, pct 0.85. On an 8k window auto fires at ~6.8k tokens; summary path REPLACES entire history with a summary written by the same weak local model (`:434-438`).
- `compressFast` (`geminiChat.ts:1768-1839`) strips ALL thought parts (`:1792-1795`) and blanks old tool results.

## 3. Microcompaction blanks old tool RESULTS
`services/microcompaction/microcompact.ts:14,20-30` — read/grep/shell outputs on older turns become `[Old tool result content cleared]`. Written file content survives (it lives in functionCall.args, `converter.ts:664-684`, never blanked — `microcompact.ts:44-49`).

## 4. Whole-turn drop in curation
`extractCuratedHistory` (`geminiChat.ts:974-1001`) drops an entire run of consecutive model turns if any part is invalid (empty text, no call, not thought — `:941-950`). Mainly bites resumed/external history.

Interactive mode keeps one persistent GeminiChat; no per-message reset (`client.ts:334-356,683`).
