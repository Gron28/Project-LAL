import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { allModels, ensureServing, readSettings, stopServing, saveConvo, newId, SERVE_PORT } from "@/lib/lab";
import { runToolLoop, type ToolLoopMsg } from "@/lib/toolloop";
import { makeAgentExecutor, makeOrchestratorExecutor } from "@/lib/agent-tools";
import { recordSessionCard, maybeRollupDaily } from "@/lib/memory-pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

// Workflow modes: each preset trades round/token budget, thinking, and sampling
// for a task shape. `default` is byte-identical to this file's pre-mode behavior
// (empty addendum, same maxRounds/maxTokens/ctx/think) so existing sessions and
// callers that never pass `mode` see no change.
type ModePreset = {
  label: string;
  maxRounds: number;
  maxTokens: number;
  ctx: number;
  think: boolean;
  temperature: number;
  addendum: string;
  defaultModel?: string;
};

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
- implementation / final writing: victory4-8b (the strongest local model)
- red-team / critique: qwen3:8b (different weights than the planner, so it has different blind spots — but prefer tool-grounded checks, i.e. actually run the code or its tests, over another model's opinion wherever a check is possible)
(If a listed model isn't available, use the closest size/role match from the current model list and say so.)

DEFAULT PIPELINE (adapt the shape to the task and say when you deviate):
1. RESEARCH — split into independent questions, one spawn_agent per question, all on the research tier, dispatched as a batch. Append findings to findings.md.
2. PLAN — one spawn_agent (implementation tier): read findings.md, write plan.md.
3. RED-TEAM — one or two spawn_agent calls (critique tier): attack plan.md for missing cases, wrong assumptions, failure modes. Write critique.md.
4. REPLAN — revise plan.md against critique.md (implementation tier).
5. ITERATE — implement plan.md step by step (implementation tier); after each step, verify it (a spawn_agent check or a direct run_shell/run_python test) before moving on. If a step fails twice in a row, stop and report rather than looping silently.
6. PRESENT — your final reply to the user: what was built, how it was verified, decisions made along the way, and any open risks. This IS the presentation step — there is no further hand-off.

PROGRESS RULE: after each stage completes, send one short line to the user naming the stage, its outcome, and what's next.`;

const MODES: Record<string, ModePreset> = {
  default: { label: "default", maxRounds: 24, maxTokens: 4096, ctx: 16384, think: true, temperature: 0, addendum: "" },
  "quick-edit": {
    label: "quick-edit", maxRounds: 8, maxTokens: 2048, ctx: 8192, think: false, temperature: 0,
    addendum: "MODE: quick-edit — make the smallest correct change. Read only what the edit requires. Prefer edit_file (a small exact search/replace) over write_file. Verify the change, then stop. Do not use spawn_agent or web_search/web_fetch in this mode — it's for fast, isolated edits only.",
  },
  planning: {
    label: "planning", maxRounds: 16, maxTokens: 8192, ctx: 16384, think: true, temperature: 0,
    addendum: "MODE: planning — explore the codebase read-only; do NOT call write_file, edit_file, or run_shell to modify anything. Your final reply must be a complete implementation plan: phases, the exact files to touch, risks, and how to verify the change once implemented.",
  },
  "deep-research": {
    label: "deep-research", maxRounds: 48, maxTokens: 4096, ctx: 16384, think: true, temperature: 0.3,
    addendum: "MODE: deep-research — fan independent sub-questions out via spawn_agent rather than researching everything serially yourself, when that saves rounds. Track sources as you go. Your final reply cites URLs and synthesizes the findings into an answer, noting any disagreements or gaps in what you found.",
  },
  orchestrator: {
    label: "orchestrator", maxRounds: 120, maxTokens: 4096, ctx: 16384, think: true, temperature: 0.2,
    defaultModel: "victory4-8b", addendum: ORCHESTRATOR_PROMPT,
  },
};

// Default mini-claude-code workspace. Any directory can be a project: the client
// passes `project` (absolute path) and the executor confines all file access to it.
const DEFAULT_WORKSPACE = path.join(path.resolve(process.cwd(), ".."), "workspace");
const PROJECTS_FILE = path.join(process.cwd(), ".data", "code_projects.json");

function listProjects(): string[] {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8")); } catch { return []; }
}
function rememberProject(p: string) {
  const rec = [p, ...listProjects().filter((x) => x !== p)].slice(0, 12);
  try { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(rec, null, 2)); } catch {}
}
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

// Pending approval resolvers, keyed by tool-call id. Module-global via globalThis so
// the approve endpoint (separate request) can resolve a wait held by the loop request
// (same Node process — the same trick lab.ts uses for the llama-server singleton).
type Resolver = (allow: boolean) => void;
const g = globalThis as unknown as { __code_approvals?: Map<string, Resolver> };
if (!g.__code_approvals) g.__code_approvals = new Map();
const approvals = g.__code_approvals;

export function GET() {
  fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true });
  const modes = Object.entries(MODES).map(([id, m]) => ({ id, label: m.label }));
  return NextResponse.json({ workspace: DEFAULT_WORKSPACE, projects: listProjects(), modes });
}

// PATCH {id, allow} -> resolve a pending tool approval
export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const r = approvals.get(String(b.id || ""));
  if (!r) return NextResponse.json({ ok: false, error: "no pending approval with that id" }, { status: 404 });
  r(!!b.allow);
  return NextResponse.json({ ok: true });
}

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

  // Serve through OUR llama-server whenever the architecture allows (works for qwen3
  // incl. Ollama-pulled blobs, read-only): Ollama's OpenAI shim runs at the model's
  // default 4096 ctx, which truncates the agent's system prompt + tool results mid-
  // session — a first field test produced a "start button stops the game" snake this
  // way. Fall back to the shim only for archs b9835 can't load (gemma4).
  const mi = allModels().find((m) => m.name === model);
  let baseUrl: string;
  try {
    await ensureServing(model, preset.ctx);
    baseUrl = `http://127.0.0.1:${SERVE_PORT}`;
  } catch (e) {
    if (mi?.source === "ollama") {
      stopServing();
      baseUrl = "http://127.0.0.1:11434";
    } else {
      return new Response("serve failed: " + (e as Error).message, { status: 500 });
    }
  }

  const proj = resolveProject(b.project);
  if ("error" in proj) return new Response(proj.error, { status: 400 });
  const root = proj.root;
  rememberProject(root);
  const instructions = projectInstructions(root);
  const memoryText = coreMemoryText(root);
  const cid = (b.conversationId as string) || "code-" + newId();
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => { try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch {} };
      send({ k: "project", v: { root, instructionFiles: instructions.files } });
      // Hoisted so spawn_agent's inner sub-loop (agent-tools.ts) can pass the SAME
      // approve gate to helper agents — previously helpers ran write_file/edit_file/
      // run_shell with no approval callback at all, bypassing the user's approval
      // setting entirely regardless of autoApprove.
      const approve = async (call: { id: string; name: string; args: Record<string, unknown> }) => {
        if (autoApprove) return true;
        send({ k: "approval_needed", v: call });
        return await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => { approvals.delete(call.id); resolve(false); }, 10 * 60 * 1000);
          approvals.set(call.id, (allow) => { clearTimeout(timer); approvals.delete(call.id); resolve(allow); });
        });
      };
      const fullExec = makeAgentExecutor({
        workspaceDir: root, baseUrl, model, think,
        onEvent: (e) => send(e), approve,
        orchestratorMode: modeId === "orchestrator",
      });
      // See makeOrchestratorExecutor's own comment (agent-tools.ts) for why this is a
      // shared helper rather than an inline filter here.
      const exec = modeId !== "orchestrator" ? fullExec : makeOrchestratorExecutor(fullExec);
      // Base text: unchanged from before modes existed, plus a mention of the core-memory
      // tools added since. mode:"default" still has an empty addendum, so its system
      // content differs from the pre-memory-blocks string only by this one addition —
      // an intentional feature addition, not a regression of the earlier byte-identical
      // mode-refactor invariant (which was specifically about the modes system itself).
      const base =
        "You are a coding agent working in the user's project directory. " +
        "Use your tools to actually do the work — read before you edit, verify after you change. " +
        "To modify an existing file, prefer edit_file with a small exact search/replace — " +
        "rewrite a whole file with write_file only when creating it or changing most of it. " +
        "For research: web_search first, then web_fetch any result whose snippet looks relevant — a snippet tells you WHERE to look, not the answer itself; don't answer a specific question from search snippets alone. Use describe_image for images, spawn_agent for isolated subtasks. " +
        "You have standing project memory across sessions via memory_read/memory_write (project conventions, known gotchas, current task state) — check it if unsure what's already known about this project, and update it when you learn something worth remembering. " +
        "Keep replies focused on what you did and found. ";
      const system: ToolLoopMsg = {
        role: "system",
        content: base + (preset.addendum ? preset.addendum + "\n\n" : "") + "Current project: " + root +
          instructions.text + memoryText,
      };
      const messages: ToolLoopMsg[] = incoming[0]?.role === "system" ? incoming.slice() : [system, ...incoming];
      const title = String(incoming.find((m) => m.role === "user")?.content || "code session").slice(0, 60);
      // The loop runs to completion server-side even after the client disconnects
      // (verified: killing the client mid-tool-call still let an 8s shell command
      // finish and the model give its final reply) — but without saving as we go,
      // a client that reconnects mid-task (tab closed and reopened, or just
      // backgrounded — mobile browsers throttle/kill background tab connections)
      // has nothing fresher than the state before this turn started to resync to,
      // and looks "stopped" even though it never was.
      const snapshot = (msgs: ToolLoopMsg[]) => {
        try { saveConvo({ id: cid, title, ts: Date.now(), project: root, messages: msgs as { role: string; content: string }[] }); } catch {}
      };
      try {
        const finalMessages = await runToolLoop({
          baseUrl, model, messages, tools: exec.defs, exec,
          maxRounds: preset.maxRounds, maxTokens: preset.maxTokens, think, temperature: preset.temperature,
          onEvent: (e) => send(e),
          onSnapshot: snapshot,
          approve,
        });
        snapshot(finalMessages);
        send({ k: "done", v: { conversationId: cid } });
        // Session card is cheap (no model call) — write it inline. The daily rollup
        // isn't: it's a real completion call when actually due, so it's fired AFTER the
        // response has already been sent (fire-and-forget, not awaited) rather than
        // blocking the request that triggered it — avoids adding live-model latency to
        // what the user experiences as "the agent replied."
        try { recordSessionCard(root, cid, title, finalMessages as { role: string; content: string | null }[]); } catch {}
        maybeRollupDaily(root, baseUrl, model).catch(() => {});
      } catch (e) {
        send({ k: "error", v: (e as Error).message });
      }
      try { controller.close(); } catch {}
    },
    cancel() {
      // client went away: deny anything still waiting so the loop unwinds
      for (const [id, r] of approvals) { r(false); approvals.delete(id); }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8", "x-conversation-id": cid },
  });
}
