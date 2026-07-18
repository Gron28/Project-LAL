# CLI tool-call visibility — code map (explored 2026-07-18)

All paths relative to `apps/cli/packages/`. Findings from a deep read; use these seams instead of re-exploring.

## How it works today

- Pipeline: `CoreToolScheduler` → `cli/src/ui/hooks/useReactToolScheduler.ts` → `mapToDisplay()` (line ~285) → `tool_group` history item → `ToolGroupMessage` → `ToolMessage`.
- Statuses: Pending/Executing/Success/Confirming/Canceled/Error; glyphs in `cli/src/ui/constants.ts:22-30` (`TOOL_STATUS`). **No per-tool-type icons** — only per-status glyphs + name map in `cli/src/ui/utils/tool-display-map.ts`.
- **Bash IS live-streamed** (`outputUpdateHandler` → `liveOutput`, useReactToolScheduler.ts:115-129, 377-386) but **capped to 5 lines** (`ToolMessage.tsx:73` `DEFAULT_SHELL_OUTPUT_MAX_LINES=5`, cap logic 752-774, setting `ui.shellOutputMaxLines`).
- **Streaming tool-call args ALREADY exist in core** (fork feature): `core/src/core/openaiContentGenerator/converter.ts:1478-1526` parses partial `tool_calls[].function.arguments` → `ToolCallProgressUpdate {name, argsChars, deltaChars, argsTail}` (types.ts:104-113) → `turn.ts:608-619` emits `GeminiEventType.ToolCallProgress` → `useGeminiStream.ts:2067-2083` reduces it to a **one-line status** (`▶ write_file · 3.4k chars · …tail48`) shown only in the composer spinner (`AppContainer.tsx:3477` → `LoadingIndicator.tsx:79`).
- File writes: nothing shown until args complete → `FileDiff` result (`ToolMessage.tsx:881-888`). No incremental content view.
- Thinking: full think blocks ARE retained in UI history (`gemini_thought_content`, `ThinkMessage` in `ConversationMessages.tsx:335-390`, Alt+T/Ctrl+O expand).
- Ctrl+O transcript view exists (`AppContainer.tsx:603-616`, `TranscriptView.tsx`) but `detailedDisplay` (exact tool result text) is stored **only for collapsible read/search tools** (gated by `isCollapsibleTool` in mapToDisplay ~342 and `ToolMessage.tsx:788-792`). Edit/write/command/MCP results are never inspectable verbatim. Raw args JSON is never rendered anywhere.
- Footer already shows GPU/VRAM/model-resident/loop/ctx% via `useGatewayStats.ts` polling `/api/sysinfo` every 5s.

## Fix seams (ranked)

1. **Live code-as-it's-written**: plumb the full partial-args buffer (not the 48-char tail) through `ToolCallProgressUpdate` and render as a live pending tool card; seams: `converter.ts:1518-1523` (tail truncation), `useGeminiStream.ts:2067-2083` (status-string reduction), new branch in `mapToDisplay` parallel to `liveOutput`.
2. **Inspect exact model↔tool round-trip**: widen `detailedDisplay` past `isCollapsibleTool`, add raw `args` field to `IndividualToolCallDisplay` (`ui/types.ts:71-78`) + renderer branch in `ToolMessage`.
3. **Live bash**: relax the 5-line cap during Executing state.
4. **Per-tool icons**: extend `tool-display-map.ts` + `ToolStatusIndicator.tsx:25-64`.
