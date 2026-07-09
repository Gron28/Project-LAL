// Streaming tool-call loop against an OpenAI-compatible /v1/chat/completions
// endpoint (llama-server --jinja, or Ollama's OpenAI shim). Confirmed working with
// native `tool_calls` streaming + finish_reason:"tool_calls" against Qwen3 (Phase 0
// spike) — no prompted-JSON fallback needed.
import type { Executor } from "./tools";
import { TOOL_DEFS, normalizeToolArgs, toolCallExample, validateToolArguments, type ToolDef } from "./tools";

export type ToolLoopMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
};

export type ToolLoopEvent =
  // p = the model's probability for the token(s) in this delta (0-1). alts = the
  // top competing tokens, attached only when the choice was UNCERTAIN (p < 0.6) —
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
  | { k: "model_swap"; v: { from: string | null; to: string } }
  | { k: "think_recovered"; v: { count: number } }
  | { k: "forced_verify" }
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
  | { k: "context_limit"; v: { estimatedTokens: number; reserveTokens: number; ctx: number } };

// Motivated by a real failure (2026-07-07 snake-roguelike eval): victory9-8b wrote
// itself a detailed plan, implemented almost none of it, then reported full
// completion — the loop accepted "no more tool calls" as done without the model
// ever re-checking its output against what it claimed. This fires exactly once per
// session, only if the session actually wrote/edited a file, so a trivial no-write
// Q&A turn never pays the extra round.
const FORCED_VERIFY_NUDGE = "Before you finish: re-read every file you wrote or edited this session (use read_file) and check it line-by-line against the task's stated requirements. Don't rely on your memory of what you intended to write — confirm the actual code does what you're about to claim it does. If anything required is missing, incomplete, or incorrect, fix it now with edit_file/write_file. If everything checks out, do NOT restate your earlier summary — reply with one short confirmation line only.";

// Companion to FORCED_VERIFY_NUDGE, at the opposite end of the same session: a real
// run (2026-07-07, same eval) looped list_files/read_file for 8-16 rounds straight
// without ever calling write_file, then ended in an empty completion — narrating/
// exploring instead of ever committing to action. Fires once per session, only
// when write_file/edit_file are actually available tools (a read-only planning
// session should never see this).
const STALL_ROUND_THRESHOLD = 3;
const STALL_NUDGE = "You've spent several rounds only reading or listing files without writing or editing anything. You already have enough context — make your first write_file or edit_file call this turn instead of reading further.";

// Deep-research mode's actual complaint (2026-07-07): the model answers after 1-2
// web_search calls, the same shallow depth as a normal chat turn, when the point of
// the mode is Gemini/GPT/Perplexity-style breadth (many sub-questions, iterative
// follow-up, real time spent). Enforces a floor rather than trusting the model to
// know it's supposed to go deeper — same "remove the option" logic as the other
// nudges. Capped at 3 firings so a genuinely narrow question can't be forced into an
// infinite research loop.
const RESEARCH_DEPTH_NUDGE_CAP = 3;
function researchDepthNudge(count: number, min: number): string {
  return `Deep research means broad, iterative coverage — you've made ${count} web_search/web_fetch call(s) so far, well short of the ~${min} a question like this warrants. Identify what's still unclear, unconfirmed, or unexplored from what you've found, generate new follow-up sub-questions, and keep researching before finalizing your answer.`;
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

function recoverBuriedToolCalls(think: string): { name: string; arguments: string }[] {
  const out: { name: string; arguments: string }[] = [];
  for (const m of think.matchAll(BURIED_TOOL_CALL_RE)) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed && typeof parsed.name === "string") {
        out.push({ name: parsed.name, arguments: JSON.stringify(parsed.arguments ?? {}) });
      }
    } catch { /* not valid JSON — skip, don't guess */ }
  }
  return out;
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
  minResearchCalls?: number;  // deep-research mode's depth floor — see researchDepthNudge above
  maxResearchCalls?: number; // planning/default modes' depth ceiling — see researchCeilingRefusal above
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
  let maxTokens = opts.maxTokens ?? 1024;
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
  let stallNudgeDone = false;
  const canWrite = tools.some((t) => t.function.name === "write_file" || t.function.name === "edit_file");
  let researchCallCount = 0;
  let researchNudgeCount = 0;

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
    const body: Record<string, unknown> = { model, messages, tools, stream: true, stream_options: { include_usage: true }, temperature: opts.temperature ?? 0, max_tokens: maxTokens };
    if (opts.topP !== undefined) body.top_p = opts.topP;
    if (opts.topK !== undefined) body.top_k = opts.topK;
    if (opts.repeatPenalty !== undefined) body.repeat_penalty = opts.repeatPenalty;
    if (opts.think === false) {
      body.chat_template_kwargs = { enable_thinking: false }; // llama-server (Qwen3)
      if (baseUrl.includes(":11434")) body.think = false;     // Ollama-native (partially respected; harmless elsewhere)
    }
    // NO logprobs here: llama-server b9835 hard-400s on "logprobs is not supported
    // with tools + stream" (verified live 2026-07-09) — and this loop always uses
    // tools + stream. The parse path below stays: if a future build lifts the
    // restriction, re-adding the body params lights confidence capture back up.
    // Token confidence IS captured on the /chat path (no tools there — supported).
    if (opts.ctx) {
      const estimatedTokens = estimateRequestTokens(body);
      const reserveTokens = Math.min(maxTokens, Math.max(512, Math.floor(opts.ctx * 0.3))) + 1024;
      if (estimatedTokens + reserveTokens >= opts.ctx) {
        onEvent({ k: "context_limit", v: { estimatedTokens, reserveTokens, ctx: opts.ctx } });
        throw new Error(`context budget exhausted before round ${round + 1} (estimated ${estimatedTokens} input + ${reserveTokens} reserved > ${opts.ctx} context tokens)`);
      }
    }
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) throw new Error("tool loop upstream error: " + res.status);

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
          if (p < 0.6 && lpArr[0]?.top_logprobs?.length) {
            alts = lpArr[0].top_logprobs
              .filter((t) => t.token !== lpArr[0].token)
              .slice(0, 3)
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
      const recovered = recoverBuriedToolCalls(think);
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
        messages.push({ role: "user", content: FORCED_VERIFY_NUDGE, name: "nudge" });
        onEvent({ k: "forced_verify" });
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

    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
    });

    for (const c of calls) {
      throwIfAborted();
      let args: Record<string, unknown> = {};
      let parseError = false;
      try {
        const parsed: unknown = JSON.parse(c.args || "{}");
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") parseError = true;
        else args = normalizeToolArgs(c.name, parsed as Record<string, unknown>);
      } catch { parseError = true; }
      onEvent({ k: "tool_request", v: { id: c.id, name: c.name, args } });

      const isResearchCall = c.name === "web_search" || c.name === "web_fetch";
      let output: string;
      if (parseError) {
        // Malformed JSON almost always means maxTokens cut the round off mid-
        // argument (a big write_file's content, typically). Silently falling
        // back to {} and running the tool anyway is dangerous — for write_file
        // that's an empty-string content, for run_shell an empty command that
        // "succeeds" doing nothing — and the model never learns its own call
        // was truncated, so it can't retry correctly. Refuse to run and say why.
        // First occurrence also raises the per-round budget once, so the retry
        // has real headroom instead of hitting the identical wall.
        // Keep doubling the budget until the ceiling — a single one-time bump was
        // observed to leave big single-file tasks (a full game in one write_file)
        // re-truncating, with the model rewriting DIFFERENT code from scratch on
        // every retry until the context died.
        if (maxTokens < 16384) {
          maxTokens = Math.min(maxTokens * 2, 16384);
          output = `error: tool call arguments were truncated or malformed (hit the response token limit) — the tool was NOT run. The token budget has been raised to ${maxTokens} for your retry: repeat the SAME call completely (same file, same code — do not start a new design), or split large content across multiple write_file/edit_file calls.`;
        } else {
          output = "error: tool call arguments were truncated or malformed — the tool was NOT run. Split the content across multiple smaller write_file/edit_file calls, continuing the SAME file with edit_file.";
        }
      } else if (validateToolArguments(c.name, args)) {
        output = "error: invalid tool arguments — " + validateToolArguments(c.name, args) + ". The tool was NOT run; retry with the required fields." + toolCallExample(c.name);
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
      const ok = !output.startsWith("error:") && output !== "denied by user";
      if (ok) anySuccessfulTool = true;
      if (ok && (c.name === "write_file" || c.name === "edit_file")) wroteFiles = true;
      if (ok && (c.name === "web_search" || c.name === "web_fetch")) researchCallCount++;
      onEvent({ k: "tool_result", v: { id: c.id, name: c.name, ok, output } });
      messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: output });
      opts.onSnapshot?.(messages);
    }

    const mutated = calls.some((c) => c.name === "write_file" || c.name === "edit_file" || c.name === "run_shell");
    consecutiveReadOnlyRounds = mutated ? 0 : consecutiveReadOnlyRounds + 1;
    if (canWrite && !stallNudgeDone && consecutiveReadOnlyRounds >= STALL_ROUND_THRESHOLD) {
      stallNudgeDone = true;
      consecutiveReadOnlyRounds = 0;
      messages.push({ role: "user", content: STALL_NUDGE, name: "nudge" });
      onEvent({ k: "stall_nudge" });
    }
  }
  // Hit the round cap without the model producing a final (non-tool-call) reply —
  // without this, the loop just ends mid-task and the UI shows "done" with no
  // indication anything was cut off.
  onEvent({ k: "max_rounds", v: maxRounds });
  return messages;
}
