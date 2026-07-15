// Streaming tool-call loop against an OpenAI-compatible /v1/chat/completions
// endpoint (llama-server --jinja, or Ollama's OpenAI shim). Confirmed working with
// native `tool_calls` streaming + finish_reason:"tool_calls" against Qwen3 (Phase 0
// spike) — no prompted-JSON fallback needed.
import type { Executor } from "./tools";
import { TOOL_DEFS, normalizeToolArgs, toolCallExample, validateToolArguments, type ToolDef } from "./tools";
import { managedPrompt } from "./lal-prompts";

export type ToolLoopMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
};

export type ToolLoopEvent =
  // p = the model's probability for the token(s) in this delta (0-1). alts = the
  // top competing tokens, attached when the choice has meaningful ambiguity (p < 0.8) —
  // this is tier 1 of "see inside the model's head": every run's ledger records
  // not just what the model said but how sure it was and what it almost said.
  | { k: "text"; v: string; p?: number; alts?: [string, number][] }
  | { k: "think"; v: string; p?: number }
  | { k: "tool_request"; v: { id: string; name: string; args: Record<string, unknown> } }
  // Live progress WHILE a tool call's arguments are still decoding. A code agent
  // spends most of its wall-clock inside write_file calls, and tool_request only
  // fires once the whole call has finished streaming — observed live 2026-07-09:
  // 80 seconds of dead air (GPU pinned, zero events) while gemma4:12b decoded one
  // write_file. Throttled to ~1/s; carries a tail preview, not cumulative content.
  | { k: "tool_progress"; v: { id: string; name: string; chars: number; preview: string } }
  | { k: "tool_result"; v: { id: string; name: string; ok: boolean; output: string } }
  | { k: "round" }
  | { k: "max_rounds"; v: number }
  | { k: "act_nudge" }
  | { k: "model_swap"; v: { from: string | null; to: string } }
  | { k: "think_recovered"; v: { count: number } }
  | { k: "forced_verify" }
  | { k: "mutation_required_nudge"; v: { count: number } }
  | { k: "stall_nudge" }
  | { k: "research_depth_nudge"; v: { count: number; min: number } }
  // Live meter: emitted after each round from llama-server's usage/timings so the
  // UI can show context fill (promptTokens+completionTokens vs ctx) and decode speed.
  | { k: "usage"; v: { promptTokens: number; completionTokens: number; totalTokens: number; tokPerSec: number | null; ctx: number; conf?: { avg: number; min: number; low: number } | null } }
  // The model's final answer was cut off by the per-round token cap (finish_reason
  // "length") rather than finishing — the "Continue" affordance keys off this.
  | { k: "truncated"; v: { round: number } }
  // Refuse a request before it reaches the inference backend when its estimated
  // input plus reserved output/tool-result space would overflow the context.
  | { k: "context_limit"; v: { estimatedTokens: number; reserveTokens: number; ctx: number } }
  // Older tool outputs were trimmed in place to fit the context window instead of
  // failing the run (deep-research died at round 12/64 from accumulated search
  // results, 2026-07-09). The most recent rounds are always kept intact.
  | { k: "context_compacted"; v: { trimmed: number } };

// Trim the bodies of old tool results, oldest first, keeping the newest
// `keepTail` messages untouched — the model keeps its recent working set and a
// stub of everything else. Mutates in place (the loop's transcript array), so the
// saved conversation carries the compacted form forward too.
function compactOldToolResults(messages: ToolLoopMsg[], keepTail = 10): number {
  let trimmed = 0;
  for (let i = 0; i < Math.max(0, messages.length - keepTail); i++) {
    const m = messages[i];
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > 500) {
      m.content = m.content.slice(0, 400) + "\n…[older tool output trimmed to save context — re-run the tool if this is needed again]";
      trimmed++;
    }
  }
  return trimmed;
}

// Ministral's chat template deliberately excludes assistant tool-call turns and
// tool-result turns from its user/assistant alternation counter.  A normal
// user-role nudge immediately after a tool result would therefore look like a
// second consecutive user turn and llama.cpp rejects the entire request.  Keep
// the instruction in the tool-result turn instead: the model still receives it
// on the next decode, without changing the conversation's role sequence.
export function appendToolResultNudge(messages: ToolLoopMsg[], nudge: string): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "tool") continue;
    message.content = `${message.content || ""}\n\n[Agent instruction]\n${nudge}`;
    return true;
  }
  return false;
}

// Mirrors the alternation guard in Ministral-3's shipped chat template.  Keeping
// this small predicate local gives the Hive self-test a regression check without
// needing a live inference server.
export function hasValidMinistralRoleOrder(messages: ToolLoopMsg[]): boolean {
  const loopMessages = messages[0]?.role === "system" ? messages.slice(1) : messages;
  let expectsUser = true;
  for (const message of loopMessages) {
    const countsForAlternation = message.role === "user" || (message.role === "assistant" && !message.tool_calls?.length);
    if (!countsForAlternation) continue;
    if ((message.role === "user") !== expectsUser) return false;
    expectsUser = !expectsUser;
  }
  return true;
}

export function dependencyOutputHasCriticalRisk(output: string): boolean {
  return (/\bcritical\b/i.test(output) && /\bvulnerabilit/i.test(output)) || /security vulnerability/i.test(output);
}

export function toolOutputSucceeded(toolName: string, output: string): boolean {
  const shellExitedNonZero = toolName === "run_shell" && /\[exit [1-9]\d*\]\s*$/.test(output);
  const shellTimedOut = toolName === "run_shell" && /\[timed out after \d+s\]\s*$/i.test(output);
  const criticalDependencyRisk = toolName === "install_dependencies" && dependencyOutputHasCriticalRisk(output);
  return !output.startsWith("error:") && output !== "denied by user" && !shellExitedNonZero && !shellTimedOut && !criticalDependencyRisk;
}

function mechanicalFailureHint(output: string): string {
  if (/ESLint couldn't find the config ["']next\/core-web-vitals/i.test(output)) {
    return " Keep the framework lint preset and declare/install the matching eslint-config-next package; removing the preset only disables project-aware linting.";
  }
  if (/Parsing error: The keyword ['"]const['"] is reserved/i.test(output)) {
    return " The lint configuration fell back to an obsolete ECMAScript parser mode. Restore the framework preset or configure a modern parser; do not patch application files to avoid this config error.";
  }
  if (/defined multiple times|duplicate identifier/i.test(output)) {
    return " Remove or alias the duplicate binding in the exact file named by the compiler before rerunning the check.";
  }
  if (/trying to use TypeScript but do not have the required package/i.test(output)) {
    return " Declare every package named by the compiler in devDependencies, then use install_dependencies before rebuilding.";
  }
  if (/Attempted import error:[\s\S]*is not exported/i.test(output)) {
    return " Check whether the symbol is a TypeScript-only interface/type. Import it with `import type` under a distinct local name; keep any runtime React component as a separate value import.";
  }
  return "";
}

// Motivated by a real failure (2026-07-07 snake-roguelike eval): victory9-8b wrote
// itself a detailed plan, implemented almost none of it, then reported full
// completion — the loop accepted "no more tool calls" as done without the model
// ever re-checking its output against what it claimed. This fires exactly once per
// session, only if the session actually wrote/edited a file, so a trivial no-write
// Q&A turn never pays the extra round.
const forcedVerifyNudge = () => managedPrompt("nudge-forced-verify");

// Companion to FORCED_VERIFY_NUDGE, at the opposite end of the same session: a real
// run (2026-07-07, same eval) looped list_files/read_file for 8-16 rounds straight
// without ever calling write_file, then ended in an empty completion — narrating/
// exploring instead of ever committing to action. Fires once per session, only
// when write_file/edit_file are actually available tools (a read-only planning
// session should never see this).
const STALL_ROUND_THRESHOLD = 3;
const stallNudge = () => managedPrompt("nudge-stall");

// Third failure in the same family, observed live 2026-07-09 (victory6-8b,
// orchestrator mode): the model ANNOUNCES its next actions ("I'll start by
// creating the necessary file structure.") and then ends its turn — the loop
// accepted that promise as a final answer and the run finished "done" having
// built nothing. Fires once, only when the session could write but never did
// and the reply's ending reads as a promise of future work.
const PROMISES_ACTION_RE = /\b(i(?:'|’)ll|i will|let(?:'|’)s|we(?:'|’)ll|we will|proceed to|start by|next,? (?:i|we)\b|i(?:'|’)m going to)\b/i;
const actNudge = () => managedPrompt("nudge-promised-action");

// Deep-research mode's actual complaint (2026-07-07): the model answers after 1-2
// web_search calls, the same shallow depth as a normal chat turn, when the point of
// the mode is Gemini/GPT/Perplexity-style breadth (many sub-questions, iterative
// follow-up, real time spent). Enforces a floor rather than trusting the model to
// know it's supposed to go deeper — same "remove the option" logic as the other
// nudges. Capped at 3 firings so a genuinely narrow question can't be forced into an
// infinite research loop.
const RESEARCH_DEPTH_NUDGE_CAP = 3;
function researchDepthNudge(count: number, min: number): string {
  return managedPrompt("nudge-research-depth").replaceAll("{{count}}", String(count)).replaceAll("{{min}}", String(min));
}

// Opposite failure, same day: a planning task (basic REST API layout) burned all 12
// of its rounds on web_search for things the model already knows cold, and never
// produced the plan at all — context exhaustion from search results left no budget
// to answer. A nudge alone isn't a hard enough boundary here (unlike the depth floor
// above, where MORE searching is exactly what's wanted); this is enforced by refusing
// the call outright once the ceiling is hit, same "remove the option" logic as the
// toolset restrictions elsewhere in this codebase.
function researchCeilingRefusal(count: number, max: number): string {
  return `error: research budget for this session (${max} web_search/web_fetch calls) is used up — you've made ${count}. Stop searching and answer directly from what you already found or already know; this task does not need unlimited research.`;
}

// Documented cross-version Qwen3 failure (Qwen3 GitHub #1817, vLLM #39056): the model
// sometimes drafts a well-formed <tool_call>{...}</tool_call> block as plain reasoning
// text instead of emitting the real structured tool_calls delta — the turn then ends
// in total silence (no error, no text, no tool call). Verified live 6 times in one
// eval battery, always this exact shape. No training-data fix is known to eliminate it
// (per 2026-07 research); the documented mitigation lives at the serving/parsing layer.
const BURIED_TOOL_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
const FUNCTION_TOOL_CALL_RE = /<function=([a-zA-Z0-9_-]+)>\s*(\{[\s\S]*?\})\s*<\/function>/g;

// Some Ollama templates (notably Gemma-family variants) return a perfectly
// usable textual call instead of OpenAI's delta.tool_calls.  Treat both common
// encodings as calls, but only inside explicit tool tags so normal prose can
// never be mistaken for an instruction to mutate the workspace.
export function recoverTextToolCalls(...texts: string[]): { name: string; arguments: string }[] {
  const out: { name: string; arguments: string }[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(BURIED_TOOL_CALL_RE)) {
      try {
        const parsed = JSON.parse(m[1]);
        if (parsed && typeof parsed.name === "string") out.push({ name: parsed.name, arguments: JSON.stringify(parsed.arguments ?? {}) });
      } catch { /* not valid JSON — skip, don't guess */ }
    }
    for (const m of text.matchAll(FUNCTION_TOOL_CALL_RE)) {
      try { out.push({ name: m[1], arguments: JSON.stringify(JSON.parse(m[2])) }); }
      catch { /* not valid JSON — skip, don't guess */ }
    }
  }
  return out.filter((call, index, all) => all.findIndex((other) => other.name === call.name && other.arguments === call.arguments) === index);
}

function estimateRequestTokens(body: Record<string, unknown>): number {
  // This is deliberately conservative and local. llama.cpp's exact count endpoint
  // is not present in every shipped build; character volume is still enough to
  // prevent the catastrophic case where a request begins with no room to finish.
  try { return Math.ceil(JSON.stringify(body).length / 3.5); } catch { return 0; }
}

export type ApproveFn = (req: { id: string; name: string; args: Record<string, unknown> }) => Promise<boolean>;

type ChoiceDelta = {
  content?: string;
  reasoning_content?: string;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
};
type LogprobEntry = { token?: string; logprob?: number; top_logprobs?: { token: string; logprob: number }[] };
type CompletionUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
type CompletionTimings = { predicted_per_second?: number; cache_n?: number; prompt_n?: number; predicted_n?: number };

export async function runToolLoop(opts: {
  baseUrl: string;
  model: string;
  messages: ToolLoopMsg[];
  tools?: ToolDef[];
  exec: Executor;
  onEvent: (e: ToolLoopEvent) => void;
  approve?: ApproveFn;        // called only for exec.approve[name]===true; omit to auto-approve everything
  maxRounds?: number;
  maxTokens?: number;         // per-round generation cap — a runaway reasoning chain must not eat the whole context
  think?: boolean;            // false -> chat_template_kwargs.enable_thinking:false (Qwen3)
  temperature?: number;       // default 0 — deterministic tool-calling; research modes may want diversity
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  lora?: { id: number; scale: number }[]; // llama.cpp per-request specialist selection
  minResearchCalls?: number;  // deep-research mode's depth floor — see researchDepthNudge above
  maxResearchCalls?: number; // planning/default modes' depth ceiling — see researchCeilingRefusal above
  requireMutation?: boolean; // reject text-only completion in implementation stages
  initialForceMutation?: boolean; // start with only write/edit tools when an external gate already proves mutation is required
  ctx?: number;               // serving context window, for the UI's context-fill meter (denominator)
  signal?: AbortSignal;       // real server-side stop: aborts the upstream fetch (llama-server
  // stops decoding when the socket closes) and is checked between rounds and before
  // every tool execution — without it, "Stop" could only ever abort the client's own
  // connection while the loop kept running unattended.
  onSnapshot?: (messages: ToolLoopMsg[]) => void; // called after each round — lets the
  // caller persist progress incrementally. The loop itself always runs to
  // completion server-side even if the client disconnects (confirmed: killing the
  // client mid-tool-call still lets a sleep+file-write finish and the model give
  // its final reply) — but without this, nothing gets saved until the WHOLE loop
  // returns, so a client that reconnects mid-task has nothing fresher to resync to.
}): Promise<ToolLoopMsg[]> {
  const { baseUrl, model, exec, onEvent } = opts;
  const tools = opts.tools ?? TOOL_DEFS;
  const maxRounds = opts.maxRounds ?? 15;
  const maxTokens = opts.maxTokens ?? 1024;
  const messages = opts.messages.slice();
  // Silence detector: if the whole run produces neither visible text nor one
  // successful tool call, ending "done" would be a lie the user experiences as
  // "the agent did nothing and said nothing" (observed live 2026-07-09, gemma4:12b
  // deep-research: three empty turns, three nudges, empty final reply, no output).
  let anyContentEver = false;
  let anySuccessfulTool = false;
  let wroteFiles = false;
  let forcedVerifyDone = false;
  let consecutiveReadOnlyRounds = 0;
  let stallNudgeCount = 0;
  let actNudgeDone = false;
  let mutationNudgeCount = 0;
  // Once an implementation worker has gathered enough evidence (or has run a
  // failing check), prose alone is not enough to move it out of an inspect/check
  // rut. Restrict the next decode to mutation tools so the backend grammar makes
  // the required state transition enforceable instead of merely suggested.
  let forceMutationTool = !!opts.initialForceMutation;
  const canWrite = tools.some((t) => t.function.name === "write_file" || t.function.name === "edit_file");
  let researchCallCount = 0;
  let researchNudgeCount = 0;
  // A model pushed past its natural stopping point by minResearchCalls (a hard
  // floor on tool calls before its answer counts) was observed to satisfy the floor
  // by literally repeating the exact same web_search query 5 times in a row rather
  // than generating a new angle — no prompt wording talked it out of this, it's a
  // decoding-level rut, not a comprehension gap. Track exact (tool, args) repeats
  // and refuse to re-run or re-count them, so padding the floor with a duplicate
  // stops working and the model has to actually diversify (observed 2026-07-10).
  const seenResearchCalls = new Set<string>();
  // Same decoding-rut family, mutation flavor (observed 2026-07-10, hive repair
  // node): at temperature 0 a coder repeated one identical edit_file 12 rounds
  // straight — an exact-repeat write_file/edit_file is deterministic, so re-
  // running it can never produce new information. Refuse the repeat with a
  // corrective error instead, exactly like duplicate research calls above.
  const seenMutationCalls = new Set<string>();
  // Exact read/list repeats before any intervening mutation provide no new
  // information and are a common local-model rut. Clear after a successful
  // write/edit so rereading the changed file remains valid verification.
  const seenReadCalls = new Set<string>();
  // Read/list/shell calls can get stuck in the same deterministic failure just
  // like edits do. Remember the original error, refuse one exact repeat, then
  // fail fast with actionable retry context if the model attempts it a third
  // time. A successful mutation clears this map because a later check may then
  // legitimately have a different result.
  const failedCalls = new Map<string, { count: number; originalOutput: string }>();

  const throwIfAborted = () => {
    if (opts.signal?.aborted) {
      const e = new Error("stopped by user");
      e.name = "AbortError";
      throw e;
    }
  };

  for (let round = 0; round < maxRounds; round++) {
    throwIfAborted();
    onEvent({ k: "round" });
    // stream_options is what makes llama-server put usage on the final chunk of a
    // STREAMED response (OpenAI semantics) — without it the UI's context/tok-s meter
    // never receives a single usage event (observed live 2026-07-09).
    const roundTools = forceMutationTool
      ? tools.filter((tool) => tool.function.name === "write_file" || tool.function.name === "edit_file")
      : tools;
    const body: Record<string, unknown> = { model, messages, tools: roundTools, stream: true, stream_options: { include_usage: true }, temperature: opts.temperature ?? 0, max_tokens: maxTokens };
    // A mutation-stage contract is not satisfied by prose.  Coder v2 proved it
    // can emit native calls when required, but otherwise sometimes describes the
    // intended edit and stops.  Require a tool turn until the first successful
    // write/edit; after that, allow a normal final response and verification.
    if (opts.requireMutation && canWrite && (!wroteFiles || forceMutationTool)) body.tool_choice = "required";
    if (opts.lora?.length) body.lora = opts.lora;
    if (opts.topP !== undefined) body.top_p = opts.topP;
    if (opts.topK !== undefined) body.top_k = opts.topK;
    if (opts.repeatPenalty !== undefined) body.repeat_penalty = opts.repeatPenalty;
    if (opts.think === false) {
      body.chat_template_kwargs = { enable_thinking: false }; // llama-server (Qwen3)
      if (baseUrl.includes(":11434")) body.think = false;     // Ollama-native (partially respected; harmless elsewhere)
    }
    // Request token probabilities for every code model. Older backends can reject
    // this combination with streamed tools; the request below retries without it
    // so an unavailable visualization never prevents the agent from running.
    if (opts.ctx) {
      let estimatedTokens = estimateRequestTokens(body);
      const reserveTokens = Math.min(maxTokens, Math.max(512, Math.floor(opts.ctx * 0.3))) + 1024;
      if (estimatedTokens + reserveTokens >= opts.ctx) {
        // Try shrinking before failing: old tool outputs are the bulk of a long
        // transcript and the least valuable part of it.
        const trimmed = compactOldToolResults(messages);
        if (trimmed) {
          onEvent({ k: "context_compacted", v: { trimmed } });
          estimatedTokens = estimateRequestTokens(body); // body.messages is the same array
        }
      }
      if (estimatedTokens + reserveTokens >= opts.ctx) {
        onEvent({ k: "context_limit", v: { estimatedTokens, reserveTokens, ctx: opts.ctx } });
        throw new Error(`context budget exhausted before round ${round + 1} (estimated ${estimatedTokens} input + ${reserveTokens} reserved > ${opts.ctx} context tokens)`);
      }
    }
    // llama-server occasionally returns a transient 5xx immediately after a
    // long/truncated tool-call turn. Retrying the exact idempotent inference
    // request is safe (no tool has executed yet) and avoids discarding an entire
    // coding mission for one overloaded decode.
    const request = async (requestBody: Record<string, unknown>) => {
      let response!: Response;
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody), signal: opts.signal,
        });
        if (response.ok || response.status < 500 || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
      return response;
    };
    let res = await request({ ...body, logprobs: true, top_logprobs: 8 });
    if (!res.ok && [400, 422, 501].includes(res.status)) res = await request(body);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`tool loop upstream error: ${res.status}${detail ? ` — ${detail.slice(0, 2_000)}` : ""}`);
    }
    if (!res.body) throw new Error("tool loop upstream error: response body missing");

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let content = "";
    let think = "";
    const callAcc: Record<number, { id: string; name: string; args: string }> = {};
    let lastToolProgress = 0;   // throttle clock for tool_progress events
    let lastToolDeltaIdx = -1;  // which call the most recent argument delta belonged to
    let confSum = 0, confN = 0, confMin = 1, confLow = 0; // per-round certainty stats
    let finishReason: string | null = null;
    let usage: CompletionUsage | null = null;
    let timings: CompletionTimings | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        // llama-server puts usage + timings on the FINAL chunk (top level, not in
        // choices); Ollama's OpenAI shim omits them. Capture when present.
        let j: { choices?: { delta?: ChoiceDelta; finish_reason?: string; logprobs?: { content?: LogprobEntry[] } }[]; usage?: CompletionUsage; timings?: CompletionTimings };
        try { j = JSON.parse(data); } catch { continue; }
        if (j.usage) usage = j.usage;
        if (j.timings) timings = j.timings;
        const choice = j.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) continue;
        // Confidence for this delta's token(s). Streamed chunks carry one token
        // almost always; average defensively if a backend batches several.
        let p: number | undefined;
        let alts: [string, number][] | undefined;
        const lpArr = choice?.logprobs?.content;
        if (Array.isArray(lpArr) && lpArr.length) {
          let sum = 0;
          for (const ent of lpArr) {
            const pe = Math.exp(ent.logprob ?? 0);
            sum += pe;
            confSum += pe; confN++;
            if (pe < confMin) confMin = pe;
            if (pe < 0.5) confLow++;
          }
          p = Math.round((sum / lpArr.length) * 1000) / 1000;
          if (p < 0.8 && lpArr[0]?.top_logprobs?.length) {
            alts = lpArr[0].top_logprobs
              .filter((t) => t.token !== lpArr[0].token)
              .slice(0, 5)
              .map((t) => [t.token, Math.round(Math.exp(t.logprob) * 1000) / 1000]);
          }
        }
        if (delta.content) { content += delta.content; onEvent({ k: "text", v: delta.content, ...(p !== undefined ? { p } : {}), ...(alts ? { alts } : {}) }); }
        if (delta.reasoning_content) { think += delta.reasoning_content; onEvent({ k: "think", v: delta.reasoning_content, ...(p !== undefined && !delta.content ? { p } : {}) }); }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!callAcc[idx]) callAcc[idx] = { id: tc.id || "", name: "", args: "" };
            if (tc.id) callAcc[idx].id = tc.id;
            if (tc.function?.name) callAcc[idx].name += tc.function.name;
            if (tc.function?.arguments) {
              callAcc[idx].args += tc.function.arguments;
              lastToolDeltaIdx = idx;
            }
          }
          const now = Date.now();
          const acc = lastToolDeltaIdx >= 0 ? callAcc[lastToolDeltaIdx] : undefined;
          if (acc?.name && now - lastToolProgress > 1000) {
            lastToolProgress = now;
            onEvent({ k: "tool_progress", v: { id: acc.id, name: acc.name, chars: acc.args.length, preview: acc.args.slice(-200) } });
          }
        }
      }
    }

    // Emit the live meter once per round. prompt_tokens is the running context the
    // model just consumed; completion is what it produced — together they're the
    // best signal of "how full is the window right now" the UI has.
    if (usage && opts.ctx) {
      const promptTokens = timings?.cache_n != null || timings?.prompt_n != null
        ? (timings.cache_n ?? 0) + (timings.prompt_n ?? 0)
        : (usage.prompt_tokens ?? 0);
      const completionTokens = timings?.predicted_n ?? usage.completion_tokens ?? 0;
      onEvent({ k: "usage", v: {
        promptTokens, completionTokens,
        totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
        tokPerSec: timings?.predicted_per_second != null ? Math.round(timings.predicted_per_second * 10) / 10 : null,
        ctx: opts.ctx,
        conf: confN ? { avg: Math.round((confSum / confN) * 1000) / 1000, min: Math.round(confMin * 1000) / 1000, low: confLow } : null,
      } });
    }

    if (content.trim()) anyContentEver = true;
    let calls = Object.values(callAcc);
    if (!calls.length) {
      const recovered = recoverTextToolCalls(think, content);
      if (recovered.length) {
        onEvent({ k: "think_recovered", v: { count: recovered.length } });
        calls = recovered.map((c, i) => ({ id: `recovered_${round}_${i}`, name: c.name, args: c.arguments }));
      }
    }
    if (!calls.length) {
      if (opts.minResearchCalls && researchCallCount < opts.minResearchCalls && researchNudgeCount < RESEARCH_DEPTH_NUDGE_CAP) {
        researchNudgeCount++;
        messages.push({ role: "assistant", content });
        // name:"nudge" marks every loop-injected user-role message so the UI can
        // render it as a system intervention — unmarked, these were rendered back
        // as messages the USER supposedly wrote (observed live 2026-07-09).
        messages.push({ role: "user", content: researchDepthNudge(researchCallCount, opts.minResearchCalls), name: "nudge" });
        onEvent({ k: "research_depth_nudge", v: { count: researchCallCount, min: opts.minResearchCalls } });
        continue;
      }
      if (wroteFiles && !forcedVerifyDone) {
        forcedVerifyDone = true;
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: forcedVerifyNudge(), name: "nudge" });
        onEvent({ k: "forced_verify" });
        continue;
      }
      if (opts.requireMutation && canWrite && !wroteFiles) {
        mutationNudgeCount++;
        if (mutationNudgeCount > 2) throw new Error("the worker claimed completion three times without making a required file mutation");
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: "Rejected: this implementation stage has made zero file mutations. Inspect the actual source now, then call write_file or edit_file. A text-only completion claim cannot pass this stage.", name: "nudge" });
        onEvent({ k: "mutation_required_nudge", v: { count: mutationNudgeCount } });
        continue;
      }
      if (canWrite && !wroteFiles && !actNudgeDone && PROMISES_ACTION_RE.test(content.slice(-400))) {
        actNudgeDone = true;
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: actNudge(), name: "nudge" });
        onEvent({ k: "act_nudge" });
        continue;
      }
      // The model produced a final answer with no tool calls — but if the round
      // hit the token cap (finish_reason "length") the answer is CUT MID-THOUGHT,
      // not finished. Surface it so the UI can offer Continue (and auto-continue
      // can resume) instead of silently presenting half an answer as complete.
      if (finishReason === "length") onEvent({ k: "truncated", v: { round } });
      if (!anyContentEver && !anySuccessfulTool) {
        throw new Error(
          "the model produced no output this entire run — no reply text and no successful tool call. " +
          "It likely doesn't handle tool calling on this backend (gemma via the Ollama shim is a known case); " +
          "try a qwen3/victory model, or a non-agent chat for this question.",
        );
      }
      messages.push({ role: "assistant", content });
      return messages;
    }

    // Never feed malformed JSON arguments back into the next model request.
    // Ministral's Jinja template parses prior tool arguments; a truncated
    // write_file argument therefore turned a recoverable tool error into an
    // immediate backend 500 on the following round.
    const malformedCallIds = new Set(calls.filter((call) => {
      try {
        const parsed = JSON.parse(call.args || "{}");
        return !parsed || Array.isArray(parsed) || typeof parsed !== "object";
      } catch { return true; }
    }).map((call) => call.id));
    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: malformedCallIds.has(c.id) ? "{}" : c.args } })),
    });

    let failedMechanicalCheckThisRound = false;
    let failedMechanicalOutput = "";
    let dependencySecurityFailureThisRound = false;
    for (const c of calls) {
      throwIfAborted();
      let args: Record<string, unknown> = {};
      let parseError = malformedCallIds.has(c.id);
      if (!parseError) {
        try {
          const parsed: unknown = JSON.parse(c.args || "{}");
          if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") parseError = true;
          else args = normalizeToolArgs(c.name, parsed as Record<string, unknown>);
        } catch { parseError = true; }
      }
      onEvent({ k: "tool_request", v: { id: c.id, name: c.name, args } });

      const isResearchCall = c.name === "web_search" || c.name === "web_fetch";
      const callSig = `${c.name}:${JSON.stringify(args)}`;
      const priorFailure = failedCalls.get(callSig);
      if (priorFailure && priorFailure.count >= 2) {
        throw new Error(`repeated_tool_failure: ${c.name} ${JSON.stringify(args)} has already failed twice. Original result: ${priorFailure.originalOutput}. Do not call it again on retry; change strategy. If a required path is missing, create it with a small write_file call.`);
      }
      const researchCallSig = isResearchCall ? `${c.name}:${JSON.stringify(args)}` : null;
      const isDuplicateResearchCall = !!researchCallSig && seenResearchCalls.has(researchCallSig);
      const isReadCall = ["read_file", "read_file_outline", "list_files", "grep"].includes(c.name);
      const isDuplicateReadCall = isReadCall && seenReadCalls.has(callSig);
      const isMutationCall = c.name === "write_file" || c.name === "edit_file";
      const mutationCallSig = isMutationCall ? `${c.name}:${JSON.stringify(args)}` : null;
      const isDuplicateMutationCall = !!mutationCallSig && seenMutationCalls.has(mutationCallSig);
      let output: string;
      if (parseError) {
        // Malformed JSON almost always means maxTokens cut the round off mid-
        // argument (a big write_file's content, typically). Silently falling
        // back to {} and running the tool anyway is dangerous — for write_file
        // that's an empty-string content, for run_shell an empty command that
        // "succeeds" doing nothing — and the model never learns its own call
        // was truncated, so it can't retry correctly. Refuse to run and say why.
        output = "error: tool call arguments were truncated, malformed, or repetitive — the tool was NOT run. Keep each write_file content below 6000 characters. Split the implementation into smaller files/components, or write a short valid base file and extend it with bounded edit_file calls. Do not repeat the same oversized call.";
      } else if (priorFailure) {
        output = `error: this exact ${c.name} call already failed and repeating it cannot produce new information. Original result: ${priorFailure.originalOutput}. Change strategy now. If the path was missing, do not read it again—create the required file with write_file (under 6000 characters).`;
      } else if (validateToolArguments(c.name, args)) {
        output = "error: invalid tool arguments — " + validateToolArguments(c.name, args) + ". The tool was NOT run; retry with the required fields." + toolCallExample(c.name);
      } else if (isDuplicateMutationCall) {
        output = `error: you already made this exact ${c.name} call this session — the file already reflects it (or it deterministically failed), so repeating it cannot change anything. Re-read the file to see its ACTUAL current state, re-run your check command for fresh output, and take a different action: a different edit, or rewrite the whole file with write_file.`;
      } else if (isDuplicateReadCall) {
        output = `error: you already made this exact ${c.name} call and no file has changed since then, so it cannot reveal anything new. Use the result already in context and make a write_file/edit_file call or run a mechanical check.`;
      } else if (isDuplicateResearchCall) {
        output = `error: you already ran this exact ${c.name} call earlier in this research pass — repeating it wastes a round without learning anything new. Try a genuinely different query or angle, or if you're out of new angles, stop researching and write your findings now.`;
      } else if (isResearchCall && opts.maxResearchCalls && researchCallCount >= opts.maxResearchCalls) {
        output = researchCeilingRefusal(researchCallCount, opts.maxResearchCalls);
      } else {
        const rule = exec.approve[c.name];
        const ruleSaysApprove = typeof rule === "function" ? rule(args) : !!rule;
        const needsApproval = ruleSaysApprove && !!opts.approve;
        if (needsApproval) {
          const allowed = await opts.approve!({ id: c.id, name: c.name, args });
          output = allowed ? await exec.run(c.name, args) : "denied by user";
        } else {
          output = await exec.run(c.name, args);
        }
      }
      const ok = toolOutputSucceeded(c.name, output);
      if (c.name === "run_shell" && !ok) {
        failedMechanicalCheckThisRound = true;
        failedMechanicalOutput = output;
      }
      if (c.name === "install_dependencies" && !ok && dependencyOutputHasCriticalRisk(output)) {
        dependencySecurityFailureThisRound = true;
      }
      if (ok) anySuccessfulTool = true;
      if (ok && (c.name === "write_file" || c.name === "edit_file")) {
        wroteFiles = true;
        forceMutationTool = false;
        failedCalls.clear();
        seenReadCalls.clear();
      } else if (!ok) {
        failedCalls.set(callSig, {
          count: (priorFailure?.count ?? 0) + 1,
          originalOutput: priorFailure?.originalOutput ?? output,
        });
      }
      // Failed mutations count too: an edit_file whose search text wasn't found
      // fails identically every time — the retry that must be blocked most.
      if (mutationCallSig && !isDuplicateMutationCall) seenMutationCalls.add(mutationCallSig);
      if (ok && isReadCall) seenReadCalls.add(callSig);
      if (ok && isResearchCall) { researchCallCount++; if (researchCallSig) seenResearchCalls.add(researchCallSig); }
      onEvent({ k: "tool_result", v: { id: c.id, name: c.name, ok, output } });
      messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: output });
      opts.onSnapshot?.(messages);
    }

    // A check is evidence, not a mutation. Counting run_shell as progress let a
    // coder alternate reads and the same failing build forever without ever
    // reaching the mutation escalation.
    const mutated = calls.some((c) => c.name === "write_file" || c.name === "edit_file");
    consecutiveReadOnlyRounds = mutated ? 0 : consecutiveReadOnlyRounds + 1;
    if (opts.requireMutation && failedMechanicalCheckThisRound) {
      forceMutationTool = true;
      appendToolResultNudge(messages, `The mechanical check failed. Your next tool call MUST be write_file or edit_file to repair the reported source/config error; do not rerun checks or inspect unrelated files first.${mechanicalFailureHint(failedMechanicalOutput)}`);
    }
    if (opts.requireMutation && dependencySecurityFailureThisRound) {
      forceMutationTool = true;
      appendToolResultNudge(messages, "Dependency installation exposed a critical or explicitly vulnerable package. Your next call MUST edit package.json to use supported compatible versions, then reinstall; this cannot be accepted as a successful dependency state.");
    }
    // Never in research modes (minResearchCalls set): there, many read-only
    // rounds IS the assignment — this nudge told a deep-research run to stop
    // researching and write files (observed 2026-07-09).
    if (canWrite && !opts.minResearchCalls && consecutiveReadOnlyRounds >= STALL_ROUND_THRESHOLD) {
      stallNudgeCount++;
      consecutiveReadOnlyRounds = 0;
      forceMutationTool = !!opts.requireMutation;
      // Do not add a user turn after tool output.  Ministral's template sees
      // that as user → user because tool-call/result messages do not advance
      // its alternation counter.  The fallback remains for a defensive path
      // where no tool result was recorded.
      const nudge = stallNudgeCount > 1
        ? `${stallNudge()} This is escalation ${stallNudgeCount}: your next tool call MUST be write_file or edit_file; do not make another read/list call.`
        : stallNudge();
      if (!appendToolResultNudge(messages, nudge)) {
        messages.push({ role: "user", content: nudge, name: "nudge" });
      }
      onEvent({ k: "stall_nudge" });
    }
  }
  // Hit the round cap without the model producing a final (non-tool-call) reply —
  // without this, the loop just ends mid-task and the UI shows "done" with no
  // indication anything was cut off.
  onEvent({ k: "max_rounds", v: maxRounds });
  return messages;
}
