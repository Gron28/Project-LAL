import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { allModels, ensureServing, readSettings, stopServing, saveConvo, newId, SERVE_PORT, listProjects, rememberProject } from "@/lib/lab";
import { runToolLoop, type ToolLoopMsg } from "@/lib/toolloop";
import { makeAgentExecutor, makeOrchestratorExecutor, makePlannerExecutor, makeImplementerExecutor } from "@/lib/agent-tools";
import { recordSessionCard, maybeRollupDaily } from "@/lib/memory-pipeline";
import { startRun, requestApproval, resolveApproval } from "@/lib/runs";
import { managedPrompt } from "@/lib/lal-prompts";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

// Workflow modes define policy defaults and ceilings for a task shape. Persisted
// LLM settings still control the actual context, output, and sampling values used
// by a run; a mode must not silently make the settings panel lie.
type ModePreset = {
  label: string;
  maxRounds: number;
  maxTokens: number;
  ctx: number;
  think: boolean;
  temperature: number;
  addendum: string;
  defaultModel?: string;
  minResearchCalls?: number; // floor on web_search/web_fetch calls before "done" is accepted — see runToolLoop
  maxResearchCalls?: number; // ceiling on web_search/web_fetch calls — see runToolLoop
};

// Shared instruction fragment: any planning output (mode:"planning", toolset:"planner",
// or the orchestrator's PLAN stage) should be small, self-contained, delegable chunks —
// not prose a single implementer reads end-to-end. Motivated by 2026-07-07 usage: a
// plan good enough for one big implement call is NOT automatically usable by
// spawn_agent, which hands each sub-agent ONLY the text of its own step — a step that
// silently assumes context from earlier steps is invisible to whoever executes it.
const CHUNKED_PLAN_INSTRUCTION = `Structure the plan as a numbered list of small, self-contained steps. EVERY step must use exactly this format (all four fields, every time):

N. <short title>
   Goal: <what this step accomplishes>
   Files: <exact file path(s) this step creates or touches>
   Depends on: <step number(s) this needs first, or "none">
   Done when: <a concrete, checkable condition — not "it works", something a different agent could verify without asking you>

Write each step so a DIFFERENT agent could execute it correctly having seen ONLY that step's text — never assume the executor also read the rest of the plan or an earlier step's reasoning. Prefer more, smaller steps over fewer, large ones: if a step would require touching many files or several distinct behaviors, split it further.

Example of one correctly-formatted step:
3. Add the create-todo endpoint
   Goal: implement POST /todos that appends a new todo item to the JSON store
   Files: server.js
   Depends on: 1, 2
   Done when: POST /todos with {"title":"..."} returns 201 and the new item appears in todos.json`;

// Prompt-driven pipeline, not hardcoded stages in TypeScript: adjustable by editing
// this string, no redeploy of application logic. See docs/orchestrator-research.md.
const ORCHESTRATOR_PROMPT = `MODE: orchestrator — you are a COORDINATOR, not the worker. Direct work you may do yourself: read files, list directories, and maintain your own notes files. Everything else — research, drafting a plan, critiquing it, implementing, testing — is delegated with spawn_agent.

HARD CONSTRAINTS (this machine):
- One GPU, one model at a time. Every spawn_agent call with a different \`model\` costs a real unload+reload (seconds to about a minute). BATCH: group every sub-task that uses the same model and dispatch them consecutively before switching to a different model — never alternate models call-by-call.
- Sub-agents see NOTHING but the task text you write them. Every task must be self-contained: the goal, exact input file paths, what to produce, where to write it, and an instruction to report back in 300 words or less.

CONTEXT DISCIPLINE (write to offload, don't carry everything yourself):
- Keep durable state in files, not in your head: _orchestrator/plan.md, _orchestrator/findings.md, _orchestrator/log.md (append the stage, which model ran it, and the outcome after every stage — re-read these files when unsure instead of relying on memory of earlier turns).
- spawn_agent reports are recorded into findings.md automatically (deduped/merged so repeats don't pile up) — you don't need to copy them there yourself. For anything YOU discover directly (e.g. via read_file, not through a spawn_agent report), use record_finding rather than writing to findings.md by hand.
- Never paste a sub-agent's raw report further downstream — pass the artifact file path plus a digest of ten lines or fewer that you write yourself.

MODEL TIERS (assign per role; batch calls within a tier before switching):
- research / extraction / summarizing: qwen3-4b-stock (fast, cheap)
- implementation / final writing: victory6-8b (the strongest local model)
- red-team / critique: qwen3:8b (different weights than the planner, so it has different blind spots — but prefer tool-grounded checks, i.e. actually run the code or its tests, over another model's opinion wherever a check is possible)
(If a listed model isn't available, use the closest size/role match from the current model list and say so.)

DEFAULT PIPELINE (adapt the shape to the task and say when you deviate):
1. RESEARCH — split into independent questions, one spawn_agent per question, all on the research tier, dispatched as a batch. Append findings to findings.md.
2. PLAN — one spawn_agent (implementation tier): read findings.md, write plan.md as a numbered list of small, self-contained steps (exact goal, exact files, dependencies on other step numbers, concrete definition of done) — small enough that the ITERATE stage can hand any single step to a sub-agent with just that step's text and nothing else.
3. RED-TEAM — one or two spawn_agent calls (critique tier): attack plan.md for missing cases, wrong assumptions, failure modes. Write critique.md.
4. REPLAN — revise plan.md against critique.md (implementation tier).
5. ITERATE — implement plan.md step by step (implementation tier); after each step, verify it (a spawn_agent check or a direct run_shell/run_python test) before moving on. If a step fails twice in a row, stop and report rather than looping silently.
6. PRESENT — your final reply to the user: what was built, how it was verified, decisions made along the way, and any open risks. This IS the presentation step — there is no further hand-off.

PROGRESS RULE: after each stage completes, send one short line to the user naming the stage, its outcome, and what's next.`;

const MODES: Record<string, ModePreset> = {
  default: { label: "default", maxRounds: 24, maxTokens: 4096, ctx: 16384, think: true, temperature: 0, addendum: "", maxResearchCalls: 8 },
  "quick-edit": {
    label: "quick-edit", maxRounds: 8, maxTokens: 2048, ctx: 8192, think: false, temperature: 0,
    addendum: "MODE: quick-edit — make the smallest correct change. Read only what the edit requires. Prefer edit_file (a small exact search/replace) over write_file. Verify the change, then stop. Do not use spawn_agent or web_search/web_fetch in this mode — it's for fast, isolated edits only.",
  },
  planning: {
    label: "planning", maxRounds: 16, maxTokens: 8192, ctx: 16384, think: true, temperature: 0,
    addendum: "MODE: planning — explore the codebase read-only; do NOT call write_file, edit_file, or run_shell to modify anything. Your final reply must be a complete implementation plan, plus risks and how to verify the change once implemented. " + CHUNKED_PLAN_INSTRUCTION,
    maxResearchCalls: 6,
  },
  "deep-research": {
    label: "deep-research", maxRounds: 64, maxTokens: 4096, ctx: 16384, think: true, temperature: 0.3,
    // 6, not 10: a 16K window cannot survive a 10-search floor even with transcript
    // compaction (verified 2026-07-09 — context death at round 12 with no answer).
    minResearchCalls: 6,
    addendum: "MODE: deep-research — this is a genuine deep-research pass, not a quick lookup, and should take real time and many steps, the same way Gemini/GPT/Perplexity's deep-research modes do. Start by decomposing the question into as many distinct sub-questions and angles as it warrants (typically 8-15 for a substantial question) — write them out before searching. Research each one with web_search + web_fetch (a snippet alone is never enough to answer from — open the real page). As you read, generate NEW follow-up sub-questions from gaps, contradictions, or unexpected findings instead of stopping after your first pass; fan independent sub-questions out via spawn_agent when that saves rounds. Track sources as you go. Do not synthesize your final answer until you've covered the breadth you identified — a shallow 1-2 search pass is a WRONG answer in this mode, not merely an incomplete one. Your final reply cites URLs and synthesizes the findings into an answer, noting any disagreements or gaps in what you found.",
  },
  orchestrator: {
    label: "orchestrator", maxRounds: 120, maxTokens: 4096, ctx: 16384, think: true, temperature: 0.2,
    defaultModel: "victory6-8b", addendum: ORCHESTRATOR_PROMPT,
  },
};

// Default mini-claude-code workspace. Any directory can be a project: the client
// passes `project` (absolute path) and the executor confines all file access to it.
const DEFAULT_WORKSPACE = path.join(path.resolve(process.cwd(), ".."), "workspace");

function resolveProject(raw: unknown): { root: string } | { error: string } {
  if (!raw) { fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true }); return { root: DEFAULT_WORKSPACE }; }
  const p = path.resolve(String(raw));
  try {
    if (!fs.statSync(p).isDirectory()) return { error: "not a directory: " + p };
  } catch { return { error: "directory not found: " + p }; }
  return { root: p };
}

// Project instruction files, same convention as Claude Code: CLAUDE.md is the
// project's standing instructions; AGENTS.md is the tool-agnostic variant.
function projectInstructions(root: string): { text: string; files: string[] } {
  const files: string[] = [];
  let text = "";
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    try {
      const t = fs.readFileSync(path.join(root, name), "utf8").trim();
      if (t) { files.push(name); text += `\n\n--- ${name} (project instructions — follow these) ---\n` + t.slice(0, 6000); }
    } catch {}
  }
  return { text, files };
}

// Core-memory blocks (agent-tools.ts's memory_read/memory_write): small, agent-editable
// notes that persist across separate sessions on this project, unlike the conversation
// history which starts fresh every time. Each block is already capped by memory_write
// (~1000 tokens); read defensively here too in case a block was ever hand-edited outside
// the tool and exceeds that.
const CORE_MEMORY_BLOCKS = ["project_conventions", "known_gotchas", "current_task_state"];
const CORE_MEMORY_CAP_PER_BLOCK = 6000; // bytes — matches projectInstructions' own defensive cap
function coreMemoryText(root: string): string {
  let text = "";
  for (const block of CORE_MEMORY_BLOCKS) {
    try {
      const t = fs.readFileSync(path.join(root, ".agent-memory", block + ".md"), "utf8").trim();
      if (t) text += `\n\n--- memory: ${block} ---\n` + t.slice(0, CORE_MEMORY_CAP_PER_BLOCK);
    } catch {}
  }
  return text;
}

export function GET() {
  fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true });
  const modes = Object.entries(MODES).map(([id, m]) => ({ id, label: m.label, think: m.think }));
  return NextResponse.json({ workspace: DEFAULT_WORKSPACE, projects: listProjects(), modes });
}

// PATCH {id, allow} -> resolve a pending tool approval (looked up across live runs
// by tool-call id — the approval banner only carries the call id)
export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const ok = resolveApproval(String(b.id || ""), !!b.allow);
  if (!ok) return NextResponse.json({ ok: false, error: "no pending approval with that id" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

// POST starts the run and returns {runId, conversationId} IMMEDIATELY — the loop
// itself executes detached inside the run manager (lib/runs.ts) and appends its
// events to the run's log. Clients (any number, any tab, any device) follow along
// via GET /api/agent/runs/<id>/stream, which replays from any sequence number and
// then tails live. This is what decouples a run's life from the browser connection
// that happened to start it.
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const incoming = (b.messages || []) as ToolLoopMsg[];
  if (!incoming.length) return new Response("no messages", { status: 400 });
  const autoApprove = !!b.autoApprove;
  const s = readSettings();
  const modeId = typeof b.mode === "string" && MODES[b.mode] ? b.mode : "default";
  const preset = MODES[modeId];
  const model = (b.model as string) || preset.defaultModel || s.model;
  if (!model) return new Response("no model available", { status: 409 });
  // An explicit client value wins (matches model resolution above); otherwise the
  // mode's own default applies — this is what makes quick-edit's think:false and
  // orchestrator's think:true actually take effect for callers that don't set it.
  const think = typeof b.think === "boolean" ? b.think : preset.think;
  const configuredCtx = Number.isFinite(s.options.num_ctx) ? s.options.num_ctx : preset.ctx;
  // Modes establish a proven minimum. A user-raised context is honored, and a
  // smaller setting never silently undercuts a mode's system/tools footprint.
  const ctx = Math.max(2048, preset.ctx, configuredCtx);
  // -1 means "use the mode default". A positive saved setting is honored but
  // bounded to avoid a single response reserving an unworkable context window.
  const maxTokens = s.options.num_predict > 0 ? Math.min(Math.floor(s.options.num_predict), 16384) : preset.maxTokens;

  const proj = resolveProject(b.project);
  if ("error" in proj) return new Response(proj.error, { status: 400 });
  const root = proj.root;
  rememberProject(root);
  const instructions = projectInstructions(root);
  const memoryText = coreMemoryText(root);
  const cid = (b.conversationId as string) || "code-" + newId();
  const toolset = typeof b.toolset === "string" ? b.toolset : undefined;
  const title = String(incoming.find((m) => m.role === "user")?.content || "code session").slice(0, 60);

  // Persist immediately, before a cold model load or the first tool call. A page
  // reload must be able to recover a newly created session even while the model is
  // still loading and has not produced a single event yet.
  try { saveConvo({ id: cid, title, ts: Date.now(), project: root, messages: incoming as { role: string; content: string }[], model, mode: modeId, think, autoApprove }); } catch {}

  const meta = startRun(
    { kind: "code", conversationId: cid, project: root, model, mode: modeId },
    async (emit, signal) => {
      emit({ k: "project", v: { root, instructionFiles: instructions.files } });
      // Turn boundary for reattaching clients: the first `base` messages of the
      // saved transcript (history coordinates — no system message) are what existed
      // BEFORE this run; everything after is reproducible by replaying this run's
      // events. A client that reopens mid-run rebuilds its view as
      // reconstruct(saved[..base]) + replay(events).
      emit({ k: "turn", v: { base: incoming.length } });
      emit({ k: "model_loading", v: { model, ctx } });

      // Model serving happens INSIDE the run (it can take up to a minute for a big
      // model — the POST reply must not wait on it). A serve failure becomes a run
      // error event, not an HTTP status.
      //
      // Serve through OUR llama-server whenever the architecture allows (works for
      // qwen3 incl. Ollama-pulled blobs, read-only): Ollama's OpenAI shim runs at the
      // model's default 4096 ctx, which truncates the agent's system prompt + tool
      // results mid-session. Fall back to the shim only for archs b9835 can't load.
      // llama-b9835's /health endpoint reports ready once the process is up and *a*
      // computation graph is loaded — it doesn't validate that graph matches the
      // model's real architecture; for gemma archs "ensureServing" was observed to
      // succeed while every REAL completion then 500'd. Skip straight to the Ollama
      // shim for gemma models instead of trusting a health check that can't see this
      // failure mode.
      const mi = allModels().find((m) => m.name === model);
      let baseUrl: string;
      if (mi?.source === "ollama" && /gemma/i.test(model)) {
        stopServing();
        baseUrl = "http://127.0.0.1:11434";
      } else {
        try {
          await ensureServing(model, ctx);
          baseUrl = `http://127.0.0.1:${SERVE_PORT}`;
        } catch (e) {
          if (mi?.source === "ollama") {
            stopServing();
            baseUrl = "http://127.0.0.1:11434";
          } else {
            throw new Error("serve failed: " + (e as Error).message);
          }
        }
      }
      emit({ k: "model_ready", v: { model, ctx, backend: baseUrl.includes(":11434") ? "ollama" : "llama.cpp" } });

      const approve = async (call: { id: string; name: string; args: Record<string, unknown> }) => {
        if (autoApprove) return true;
        return requestApproval(meta.id, emit, call);
      };
      const fullExec = makeAgentExecutor({
        workspaceDir: root, baseUrl, model, think,
        onEvent: (e) => emit(e), approve, signal,
        orchestratorMode: modeId === "orchestrator",
      });
      // See makeOrchestratorExecutor's own comment (agent-tools.ts) for why this is a
      // shared helper rather than an inline filter here. `toolset` is an explicit opt-in
      // override (any caller, any mode) for driving a plan/implement split — omitted,
      // behavior is byte-identical to before this param existed.
      const exec =
        toolset === "planner" ? makePlannerExecutor(fullExec)
        : toolset === "implementer" ? makeImplementerExecutor(fullExec)
        : toolset === "full" ? fullExec
        : modeId !== "orchestrator" ? fullExec : makeOrchestratorExecutor(fullExec);
      const base = managedPrompt("agent-core") + " ";
      const toolsetAddendum =
        toolset === "planner" ? "You are in a PLANNING-ONLY phase: you have no write_file/edit_file/run_shell/spawn_agent this turn (by design, not by mistake) — produce your plan as your final text reply, not a file. " + CHUNKED_PLAN_INSTRUCTION + " " :
        toolset === "implementer" ? "You are in an IMPLEMENTATION-ONLY phase: you have no web_search/web_fetch/spawn_agent this turn (by design, not by mistake) — act directly on the plan you were given instead of researching further. " :
        "";
      const system: ToolLoopMsg = {
        role: "system",
        content: base + toolsetAddendum + (preset.addendum ? preset.addendum + "\n\n" : "") + "Current project: " + root +
          instructions.text + memoryText,
      };
      const messages: ToolLoopMsg[] = incoming[0]?.role === "system" ? incoming.slice() : [system, ...incoming];
      const snapshot = (msgs: ToolLoopMsg[]) => {
        try { saveConvo({ id: cid, title, ts: Date.now(), project: root, messages: msgs as { role: string; content: string }[], model, mode: modeId, think, autoApprove }); } catch {}
      };
      // A planner-toolset call almost never needs more than a couple of confirmatory
      // searches (it's usually planning against a well-understood codebase/stack) —
      // tighter than any mode's own default, and wins regardless of mode since
      // toolset is an explicit override elsewhere too.
      const maxResearchCalls = toolset === "planner" ? 5 : preset.maxResearchCalls;
      const finalMessages = await runToolLoop({
        baseUrl, model, messages, tools: exec.defs, exec,
        maxRounds: preset.maxRounds, maxTokens, think,
        temperature: s.options.temperature, topP: s.options.top_p, topK: s.options.top_k, repeatPenalty: s.options.repeat_penalty,
        minResearchCalls: preset.minResearchCalls, maxResearchCalls,
        ctx,
        onEvent: (e) => emit(e),
        onSnapshot: snapshot,
        approve,
        signal,
      });
      snapshot(finalMessages);
      emit({ k: "done", v: { conversationId: cid } });
      // Session card is cheap (no model call) — write it inline. The daily rollup
      // isn't: it's a real completion call when actually due, so it's fire-and-forget
      // rather than holding the run open.
      try { recordSessionCard(root, cid, title, finalMessages as { role: string; content: string | null }[]); } catch {}
      maybeRollupDaily(root, baseUrl, model).catch(() => {});
    },
  );

  return NextResponse.json({ runId: meta.id, conversationId: cid }, {
    headers: { "x-conversation-id": cid },
  });
}
