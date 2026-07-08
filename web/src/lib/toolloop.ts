// Streaming tool-call loop against an OpenAI-compatible /v1/chat/completions
// endpoint (llama-server --jinja, or Ollama's OpenAI shim). Confirmed working with
// native `tool_calls` streaming + finish_reason:"tool_calls" against Qwen3 (Phase 0
// spike) — no prompted-JSON fallback needed.
import type { Executor } from "./tools";
import { TOOL_DEFS, type ToolDef } from "./tools";

export type ToolLoopMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
};

export type ToolLoopEvent =
  | { k: "text"; v: string }
  | { k: "think"; v: string }
  | { k: "tool_request"; v: { id: string; name: string; args: Record<string, unknown> } }
  | { k: "tool_result"; v: { id: string; name: string; ok: boolean; output: string } }
  | { k: "round" }
  | { k: "max_rounds"; v: number }
  | { k: "model_swap"; v: { from: string | null; to: string } }
  | { k: "think_recovered"; v: { count: number } }
  | { k: "forced_verify" }
  | { k: "stall_nudge" }
  | { k: "research_depth_nudge"; v: { count: number; min: number } };

// Motivated by a real failure (2026-07-07 snake-roguelike eval): victory9-8b wrote
// itself a detailed plan, implemented almost none of it, then reported full
// completion — the loop accepted "no more tool calls" as done without the model
// ever re-checking its output against what it claimed. This fires exactly once per
// session, only if the session actually wrote/edited a file, so a trivial no-write
// Q&A turn never pays the extra round.
const FORCED_VERIFY_NUDGE = "Before you finish: re-read every file you wrote or edited this session (use read_file) and check it line-by-line against the task's stated requirements. Don't rely on your memory of what you intended to write — confirm the actual code does what you're about to claim it does. If anything required is missing, incomplete, or incorrect, fix it now with edit_file/write_file. Only give your final summary once you've actually verified this against the real file contents.";

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

export type ApproveFn = (req: { id: string; name: string; args: Record<string, unknown> }) => Promise<boolean>;

type ChoiceDelta = {
  content?: string;
  reasoning_content?: string;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
};

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
  let wroteFiles = false;
  let forcedVerifyDone = false;
  let consecutiveReadOnlyRounds = 0;
  let stallNudgeDone = false;
  const canWrite = tools.some((t) => t.function.name === "write_file" || t.function.name === "edit_file");
  let researchCallCount = 0;
  let researchNudgeCount = 0;

  for (let round = 0; round < maxRounds; round++) {
    onEvent({ k: "round" });
    const body: Record<string, unknown> = { model, messages, tools, stream: true, temperature: opts.temperature ?? 0, max_tokens: maxTokens };
    if (opts.topP !== undefined) body.top_p = opts.topP;
    if (opts.topK !== undefined) body.top_k = opts.topK;
    if (opts.repeatPenalty !== undefined) body.repeat_penalty = opts.repeatPenalty;
    if (opts.think === false) {
      body.chat_template_kwargs = { enable_thinking: false }; // llama-server (Qwen3)
      if (baseUrl.includes(":11434")) body.think = false;     // Ollama-native (partially respected; harmless elsewhere)
    }
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) throw new Error("tool loop upstream error: " + res.status);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let content = "";
    let think = "";
    const callAcc: Record<number, { id: string; name: string; args: string }> = {};
    let finishReason: string | null = null;

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
        let j: { choices?: { delta?: ChoiceDelta; finish_reason?: string }[] };
        try { j = JSON.parse(data); } catch { continue; }
        const choice = j.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) continue;
        if (delta.content) { content += delta.content; onEvent({ k: "text", v: delta.content }); }
        if (delta.reasoning_content) { think += delta.reasoning_content; onEvent({ k: "think", v: delta.reasoning_content }); }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!callAcc[idx]) callAcc[idx] = { id: tc.id || "", name: "", args: "" };
            if (tc.id) callAcc[idx].id = tc.id;
            if (tc.function?.name) callAcc[idx].name += tc.function.name;
            if (tc.function?.arguments) callAcc[idx].args += tc.function.arguments;
          }
        }
      }
    }

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
        messages.push({ role: "user", content: researchDepthNudge(researchCallCount, opts.minResearchCalls) });
        onEvent({ k: "research_depth_nudge", v: { count: researchCallCount, min: opts.minResearchCalls } });
        continue;
      }
      if (wroteFiles && !forcedVerifyDone) {
        forcedVerifyDone = true;
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: FORCED_VERIFY_NUDGE });
        onEvent({ k: "forced_verify" });
        continue;
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
      let args: Record<string, unknown> = {};
      let parseError = false;
      try { args = JSON.parse(c.args || "{}"); } catch { parseError = true; }
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
        output = "error: tool call arguments were truncated or malformed (likely hit the response token limit) — the tool was NOT run. Retry with a smaller edit, or split large content across multiple write_file/edit_file calls.";
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
      messages.push({ role: "user", content: STALL_NUDGE });
      onEvent({ k: "stall_nudge" });
    }
  }
  // Hit the round cap without the model producing a final (non-tool-call) reply —
  // without this, the loop just ends mid-task and the UI shows "done" with no
  // indication anything was cut off.
  onEvent({ k: "max_rounds", v: maxRounds });
  return messages;
}
