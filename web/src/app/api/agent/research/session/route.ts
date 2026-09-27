import { NextRequest, NextResponse } from "next/server";
import { allModels, readSettings } from "@/lib/lab";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";
import { startRun, isRunLive } from "@/lib/runs";
import { loadMemory, newMemory, saveMemory } from "@/lib/research/memory";
import { runResearch, say, sessionInbox } from "@/lib/research/engine";

export const dynamic = "force-dynamic";

// POST { text, sessionId?, model?, language? }
//  - no sessionId (or unknown): start a new conversational research session
//  - live session: the utterance goes into its inbox and is handled between steps
//  - finished session: continue it (same memory) with the utterance as a follow-up
// Returns { sessionId, runId, queued }. Stream progress from /api/agent/runs/<runId>/stream.
export async function POST(req: NextRequest) {
  const auth = authorizeBrowserMutation(req);
  if (!auth.ok) return NextResponse.json({ error: "browser mutation rejected", code: auth.code }, { status: auth.status });
  const body = await req.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
  if (text.length < 2) return NextResponse.json({ error: "say what you want to research" }, { status: 400 });
  const language = body.language === "es" ? "es" : "en";
  const settings = readSettings();
  const model = typeof body.model === "string" && allModels().some((m) => m.name === body.model) ? body.model : settings.model;
  if (!model) return NextResponse.json({ error: "no model is installed" }, { status: 409 });

  const requested = typeof body.sessionId === "string" ? body.sessionId : "";
  const existing = requested ? loadMemory(requested) : null;
  if (existing) {
    const box = sessionInbox(existing.id);
    if (box.runId && isRunLive(box.runId) && say(existing.id, text)) {
      return NextResponse.json({ sessionId: existing.id, runId: box.runId, queued: true });
    }
    box.queue.push(text); // picked up by handleUser() as the run starts
    let runId = "";
    const meta = startRun({ kind: "deliberate", conversationId: `research-${existing.id}`, model, mode: "call-research" },
      (emit, signal) => runResearch(existing, model, null, emit, signal, () => runId));
    runId = meta.id;
    return NextResponse.json({ sessionId: existing.id, runId: meta.id, queued: false });
  }

  const id = `rs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const mem = newMemory(id, text, language);
  saveMemory(mem);
  let runId = "";
  const meta = startRun({ kind: "deliberate", conversationId: `research-${id}`, model, mode: "call-research" },
    (emit, signal) => runResearch(mem, model, text, emit, signal, () => runId));
  runId = meta.id;
  return NextResponse.json({ sessionId: id, runId: meta.id, queued: false });
}

// GET ?id= → the session's memory (facts, sources, images, threads, transcript),
// so a reopened call can restore what was already found.
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") || "";
  const mem = loadMemory(id);
  if (!mem) return NextResponse.json({ error: "unknown research session" }, { status: 404 });
  return NextResponse.json(mem);
}
