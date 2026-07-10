import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { allModels, ensureServing, stopServing, saveConvo, newId, SERVE_PORT, rememberProject, readSettings } from "@/lib/lab";
import { makeAgentExecutor } from "@/lib/agent-tools";
import { runDeliberation } from "@/lib/deliberate";
import { startRun, requestApproval } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const maxDuration = 3600; // hard route ceiling — a cycle-boxed run (no minutes budget) must stay under this

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

export async function GET() {
  return NextResponse.json({ defaultModel: DEFAULT_MODEL });
}

// POST {query, project?, model?} -> {runId, conversationId}; the deliberation
// itself runs detached in the run manager (like /api/agent/loop) and clients follow
// via GET /api/agent/runs/<id>/stream. Deliberately a separate endpoint from
// /api/agent/loop rather than another `mode`: this is a multi-phase, multi-role
// orchestration with its own cycle budget and on-disk artifacts, not a single
// tool-loop call.
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const query = String(b.query || "").trim();
  if (!query) return new Response("no query", { status: 400 });
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

  const cid = "deliberate-" + newId();
  const meta = startRun(
    { kind: "deliberate", conversationId: cid, project: root, model },
    async (emit, signal) => {
      emit({ k: "project", v: { root } });
      emit({ k: "query", v: { query, model } });

      // Serving happens inside the run — model load can take up to a minute and the
      // POST reply must not wait on it. Same gemma-routing gotcha as /api/agent/loop:
      // llama-b9835's health check passes for gemma archs it can't actually run, so
      // go straight to the Ollama shim.
      const mi = allModels().find((m) => m.name === model);
      // 8192 floor, not 16384: ensureServing takes the MAX of this and the saved
      // num_ctx, so a user-raised setting actually wins instead of being clamped to
      // a hardcoded value regardless of what they configured. Also the context
      // window runDeliberation reports to the UI's HUD meter, regardless of which
      // backend below actually ends up serving it.
      const ctx = Math.max(8192, o.num_ctx || 0);
      let baseUrl: string;
      if (mi?.source === "ollama" && /gemma/i.test(model)) {
        stopServing();
        baseUrl = "http://127.0.0.1:11434";
      } else {
        try {
          await ensureServing(model, ctx);
          baseUrl = `http://127.0.0.1:${SERVE_PORT}`;
        } catch (e) {
          if (mi?.source === "ollama") { stopServing(); baseUrl = "http://127.0.0.1:11434"; }
          else throw new Error("serve failed: " + (e as Error).message);
        }
      }

      const approve = async (call: { id: string; name: string; args: Record<string, unknown> }) => {
        if (autoApprove) return true;
        return requestApproval(meta.id, emit, call);
      };
      // Full toolset (2026-07-07: "make sure I have all the tools in the system") —
      // no reason to withhold run_python/describe_image/spawn_agent/write_file/etc.
      // from a research role; write/edit/shell go through the SAME approval gate
      // as the regular /code session instead of being blanket-denied by omission.
      const fullExec = makeAgentExecutor({ workspaceDir: root, baseUrl, model, think: true, onEvent: () => {}, approve, signal });
      const dir = await runDeliberation({
        query, project: root, baseUrl, model, ctx,
        exec: fullExec, tools: fullExec.defs,
        sampling: { temperature: o.temperature, topP: o.top_p, topK: o.top_k, repeatPenalty: o.repeat_penalty },
        approve,
        signal,
        onEvent: (e) => emit(e as unknown as Record<string, unknown> & { k: string }),
      });
      try {
        saveConvo({
          id: cid, title: "Deliberate: " + query.slice(0, 60), ts: Date.now(), project: root, model, mode: "deliberate", think: true,
          messages: [
            { role: "user", content: query },
            { role: "assistant", content: `Deliberation complete. Artifacts: ${dir}` },
          ],
        });
      } catch {}
    },
  );

  return NextResponse.json({ runId: meta.id, conversationId: cid }, { headers: { "x-conversation-id": cid } });
}
