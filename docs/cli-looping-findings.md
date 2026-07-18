# CLI tool-call looping — diagnosis (explored 2026-07-18)

Paths relative to `apps/cli/packages/`. Three ranked root causes with evidence; fix in this order.

## 1. Loop detection is mostly OFF in interactive mode
`cli/src/config/config.ts:2176`: `skipLoopDetection = settings.model?.skipLoopDetection ?? interactive` → **defaults true in the terminal**. Heuristic detectors (global-duplicate≥6, alternating ABAB, read-file-loop, action-stagnation≥8, shell-stagnation) are all skipped (`client.ts:2469`). Only guards left: 5 *byte-identical* consecutive calls, or 100 calls/turn. A model that varies args slightly loops freely up to 100.
Also: when detection fires, recent local mod (`client.ts:2423-2492`) injects one "change approach" nudge + `loopDetector.reset()` + one retry — then loops resume. And a mutation-boundary epoch reset (`loopDetectionService.ts:224-227`) zeroes duplicate counters after every write/edit/shell.

## 2. Semantic dedup returns an ERROR instead of the tool result
Local OpenAI servers reuse one providerCallId for every tool call, so dedup identity = `id\0name\0JSON(args)` (`turn.ts:220-234`). A *legitimate* repeat of the same read/ls with same args → NOT executed; model receives `"Duplicate provider tool call id … not executed again"` error part (`turn.ts:270-290`, `nonInteractiveCli.ts:1104-1123`). Model never gets its data → re-asks → loop. Only cleared by an intervening mutation (`resetSemanticToolCallDedupAfterMutation`, turn.ts:243-261).

## 3. Silent failures leave no trace in history → model repeats itself
- Qwen3 buried-tool-call recovery (`<tool_call>` in prose) exists (`converter.ts:219-280`) but is regex-dependent; misses end the turn silently.
- `extractCuratedHistory` (`geminiChat.ts:974`) + `isValidContentPart` (:941) silently DROP model turns containing empty-text parts (common local-model failure) — the model sees no record of its prior attempt next turn and redoes it. **This is also a direct amnesia mechanism.**

## Gateway notes (web/src/app/api/llm/v1/chat/completions/route.ts)
- `compactTools` trims tool descriptions to 700 chars / params 240 (lines 40-104).
- `LAL_TERMINAL_TOOLS` allowlist (lines 10-36) is defined but NEVER used.
- logprobs stripped whenever tools present (lines 178-193, llama.cpp limitation).
- No server-side repetition guard exists (CLI comments assume DashScope's; false locally) — client is the only backstop, and per §1 it's off.

## Mechanics reference
- Tool calls parsed only at finish_reason via StreamingToolCallParser; malformed JSON repaired, non-object args → `{}` (`streamingToolCallParser.ts:308-343`).
- Results → `functionResponse` parts → OpenAI `role:"tool"` (`converter.ts:856-910`); errors as `{error: message}`; tool output truncated at 25k chars (`config.ts:625`).
