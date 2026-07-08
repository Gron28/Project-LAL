import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { allModels, ensureServing, stopServing, saveConvo, newId, SERVE_PORT, rememberProject, readSettings } from "@/lib/lab";
import { makeAgentExecutor } from "@/lib/agent-tools";
import { runDeliberation } from "@/lib/deliberate";

export const dynamic = "force-dynamic";
export const maxDuration = 3600; // hard route ceiling — the minutes slider must stay comfortably under this

const DEFAULT_WORKSPACE = path.join(path.resolve(process.cwd(), ".."), "workspace");
const DEFAULT_MODEL = "gemma4:12b"; // user's call 2026-07-07: one strong model for every role, no swap cost

function resolveProject(raw: unknown): { root: string } | { error: string } {
  if (!raw) { fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true }); return { root: DEFAULT_WORKSPACE }; }
  const p = path.resolve(String(raw));
  try {
    if (!fs.statSync(p).isDirectory()) return { error: "not a directory: " + p };
  } catch { return { error: "directory not found: " + p }; }
  return { root: p };
}

// Same globalThis-keyed map /api/agent/loop's PATCH handler already resolves —
// sharing it (rather than a second map + a second PATCH route) means the client's
// existing approve/deny UI and its one PATCH call work unchanged for approvals
// raised from a deliberation too.
type Resolver = (allow: boolean) => void;
const g = globalThis as unknown as { __code_approvals?: Map<string, Resolver> };
if (!g.__code_approvals) g.__code_approvals = new Map();
const approvals = g.__code_approvals;

export async function GET() {
  return NextResponse.json({ defaultModel: DEFAULT_MODEL, minMinutes: 2, maxMinutes: 60, defaultMinutes: 10 });
}

// POST {query, minutes, project?, model?} -> streamed NDJSON DeliberateEvent log.
// Deliberately a separate endpoint from /api/agent/loop rather than another `mode`:
// this is a multi-phase, multi-role orchestration with its own time budget and
// on-disk artifacts, not a single tool-loop call — folding a time-limit concept into
// the generic loop would complicate a path that already works for everything else.
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const query = String(b.query || "").trim();
  if (!query) return new Response("no query", { status: 400 });
  const minutes = Math.max(1, Math.min(120, Number(b.minutes) || 10));
  const model = (b.model as string) || DEFAULT_MODEL;
  const autoApprove = !!b.autoApprove;

  const proj = resolveProject(b.project);
  if ("error" in proj) return new Response(proj.error, { status: 400 });
  const root = proj.root;
  rememberProject(root);

  // Same LLM settings the chat page's gear icon edits (num_ctx/temperature/top_p/
  // top_k/repeat_penalty) — this is what "play with temperature and context window"
  // (2026-07-07) plugs into; no separate deliberate-only settings store.
  const s = readSettings();
  const o = s.options;

  const mi = allModels().find((m) => m.name === model);
  let baseUrl: string;
  // Same gemma-routing gotcha as /api/agent/loop: llama-b9835's health check passes
  // for gemma archs it can't actually run, so go straight to the Ollama shim.
  if (mi?.source === "ollama" && /gemma/i.test(model)) {
    stopServing();
    baseUrl = "http://127.0.0.1:11434";
  } else {
    try {
      // 8192 floor, not 16384: ensureServing takes the MAX of this and the saved
      // num_ctx, so a user-raised setting actually wins instead of being clamped
      // to a hardcoded value regardless of what they configured.
      await ensureServing(model, Math.max(8192, o.num_ctx || 0));
      baseUrl = `http://127.0.0.1:${SERVE_PORT}`;
    } catch (e) {
      if (mi?.source === "ollama") { stopServing(); baseUrl = "http://127.0.0.1:11434"; }
      else return new Response("serve failed: " + (e as Error).message, { status: 500 });
    }
  }

  const cid = "deliberate-" + newId();
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => { try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch {} };
      send({ k: "project", v: { root } });
      send({ k: "query", v: { query, minutes, model } });
      const approve = async (call: { id: string; name: string; args: Record<string, unknown> }) => {
        if (autoApprove) return true;
        send({ k: "approval_needed", v: call });
        return await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => { approvals.delete(call.id); resolve(false); }, 10 * 60 * 1000);
          approvals.set(call.id, (allow) => { clearTimeout(timer); approvals.delete(call.id); resolve(allow); });
        });
      };
      // Full toolset (2026-07-07: "make sure I have all the tools in the system") —
      // no reason to withhold run_python/describe_image/spawn_agent/write_file/etc.
      // from a research role; write/edit/shell now go through the SAME approval gate
      // as the regular /code session instead of being blanket-denied by omission.
      const fullExec = makeAgentExecutor({ workspaceDir: root, baseUrl, model, think: true, onEvent: () => {}, approve });
      try {
        const dir = await runDeliberation({
          query, minutes, project: root, baseUrl, model,
          exec: fullExec, tools: fullExec.defs,
          sampling: { temperature: o.temperature, topP: o.top_p, topK: o.top_k, repeatPenalty: o.repeat_penalty },
          approve,
          onEvent: (e) => send(e),
        });
        try {
          saveConvo({
            id: cid, title: "Deliberate: " + query.slice(0, 60), ts: Date.now(), project: root,
            messages: [
              { role: "user", content: query },
              { role: "assistant", content: `Deliberation complete. Artifacts: ${dir}` },
            ],
          });
        } catch {}
      } catch (e) {
        send({ k: "error", v: (e as Error).message });
      }
      try { controller.close(); } catch {}
    },
    cancel() {
      for (const [id, r] of approvals) { r(false); approvals.delete(id); }
    },
  });

  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "x-conversation-id": cid } });
}
