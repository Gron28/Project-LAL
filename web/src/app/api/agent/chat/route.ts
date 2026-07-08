import { NextRequest, NextResponse } from "next/server";
import { ensureServing, readSettings, getConvo, saveConvo, newId, webSearch, retrieveDocs, servingModel, stopServing, SERVE_PORT } from "@/lib/lab";
import { startRun, type EmitFn } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

// Images route to Gemma via Ollama — the local model that can actually see (same
// decision as the /code agent's describe_image tool). Our own serving model is
// text-only Qwen3; sending it images would just silently ignore them.
//
// gemma4:12b's 7.6GB weights leave too little of the 8GB card for its own KV cache,
// forcing most layers onto CPU (12-15 tok/s even with flash-attn + q8_0 KV — see
// HANDOFF.md 2026-07-06/07). The smaller MatFormer variants fit on-GPU and run
// 3-6x faster (measured: e4b 47-62 tok/s) at a real but smaller quality cost.
// Speed only matters when there's a lot of decoding to do — a single image still
// gets the better model; a batch large enough to actually feel slow gets the fast one.
const VISION_MODEL_QUALITY = "gemma4:12b";
const VISION_MODEL_FAST = "gemma4:e4b";
const VISION_FAST_THRESHOLD = 5; // more than this many images in one turn -> fast model

function stripDataUrl(s: string): string {
  const m = /^data:[^;]+;base64,(.+)$/.exec(s);
  return m ? m[1] : s;
}

// Chat generations run through the run manager like /code loops do: POST returns
// {runId, conversationId} immediately and the generation continues server-side
// regardless of what the browser does. The client (or any later client) follows
// via GET /api/agent/runs/<id>/stream; Stop is POST /api/agent/runs/<id>/stop —
// which actually cancels the upstream decode, unlike the old no-op stop.
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const incoming = (b.messages || []) as { role: string; content: string }[];
  const attachments: string[] = Array.isArray(b.attachments) ? b.attachments.filter((x: unknown) => typeof x === "string") : [];
  const s = readSettings();

  // grounding: toggles (settings.web / settings.groundDocs) or one-off /web /docs commands
  let system = s.system;
  const lastUser = [...incoming].reverse().find((m) => m.role === "user");
  const raw = (lastUser?.content || "").trim();
  let doWeb = s.web, doDocs = s.groundDocs, query = raw;
  if (raw.toLowerCase().startsWith("/web ")) { doWeb = true; query = raw.slice(5).trim(); if (lastUser) lastUser.content = query; }
  else if (raw.toLowerCase().startsWith("/docs ")) { doDocs = true; query = raw.slice(6).trim(); if (lastUser) lastUser.content = query; }
  const extra: string[] = [];
  if (doWeb && query) extra.push("LIVE WEB RESULTS (cite by [number]):\n" + (await webSearch(query)));
  if (doDocs && query) extra.push("DOCUMENT EXCERPTS — answer only from these, cite by [number]:\n" + (retrieveDocs(query) || "(no relevant excerpts found)"));
  if (extra.length) system = (s.system ? s.system + "\n\n" : "") + extra.join("\n\n");

  const cid = b.conversationId || newId();
  const convo = getConvo(cid) || { id: cid, title: "", ts: Date.now(), messages: [] };
  convo.messages = incoming.slice();
  saveConvo(convo);

  const saveReply = (full: string) => {
    try { convo.messages = [...incoming, { role: "assistant", content: full }]; saveConvo(convo); } catch {}
  };

  if (attachments.length) {
    const visionModel = attachments.length > VISION_FAST_THRESHOLD ? VISION_MODEL_FAST : VISION_MODEL_QUALITY;
    const meta = startRun({ kind: "chat", conversationId: cid, model: visionModel }, async (emit, signal) => {
      // GPU is single-tenant: park our own llama-server (if resident) before Ollama
      // loads Gemma — HANDOFF bug #1 was exactly this pair of backends colliding.
      const parked = servingModel();
      if (parked) stopServing();

      const ollamaMessages = incoming.map((m, i) =>
        i === incoming.length - 1 && m.role === "user"
          ? { role: m.role, content: m.content, images: attachments.map(stripDataUrl) }
          : { role: m.role, content: m.content });
      if (system) ollamaMessages.unshift({ role: "system", content: system });

      const acc = { full: "" };
      try {
        // Tell the UI which vision model actually answered — "fast" vs "quality" is
        // otherwise invisible; the user asked to be able to notice which one ran.
        emit({ k: "model", v: visionModel });
        const upstream = await fetch("http://127.0.0.1:11434/api/chat", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: visionModel, messages: ollamaMessages, stream: true, options: { temperature: s.options.temperature } }),
          signal,
        });
        if (!upstream.ok || !upstream.body) throw new Error("vision upstream error: " + upstream.status);
        await pumpOllama(upstream, emit, signal, acc);
      } finally {
        // A stopped/failed generation still persists whatever streamed so far —
        // same behavior the old inline stream had.
        if (acc.full) saveReply(acc.full);
        if (parked) { try { await ensureServing(parked); } catch { /* next text message will surface it */ } }
      }
    });
    return NextResponse.json({ runId: meta.id, conversationId: cid }, { headers: { "x-conversation-id": cid } });
  }

  if (!s.model) return new Response("no model available — train or install one", { status: 409 });

  const meta = startRun({ kind: "chat", conversationId: cid, model: s.model }, async (emit, signal) => {
    // Serving happens INSIDE the run — a cold model load can take a minute, and the
    // POST reply must not wait on it (the client is already attached and watching).
    await ensureServing(s.model);

    const payload: Record<string, unknown> = {
      messages: system ? [{ role: "system", content: system }, ...incoming] : incoming,
      stream: true,
      temperature: s.options.temperature,
      top_p: s.options.top_p,
      top_k: s.options.top_k,
      repeat_penalty: s.options.repeat_penalty,
    };
    if (s.options.num_predict > 0) payload.max_tokens = s.options.num_predict;

    const acc = { full: "" };
    try {
      const upstream = await fetch(`http://127.0.0.1:${SERVE_PORT}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      if (!upstream.ok || !upstream.body) throw new Error("upstream error: " + upstream.status);
      await pumpOpenAI(upstream, emit, acc);
    } finally {
      if (acc.full) saveReply(acc.full);
    }
  });

  return NextResponse.json({ runId: meta.id, conversationId: cid }, { headers: { "x-conversation-id": cid } });
}

// Both pumps accumulate into a caller-owned object so a mid-stream abort/error
// still leaves the partial text where the caller's `finally` can persist it.
// Ollama's /api/chat streams NDJSON, not SSE.
async function pumpOllama(upstream: Response, emit: EmitFn, signal: AbortSignal, acc: { full: string }): Promise<void> {
  const reader = upstream.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    if (signal.aborted) { try { await reader.cancel(); } catch {} break; }
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        const tok = j.message?.content || "";
        if (tok) { acc.full += tok; emit({ k: "text", v: tok }); }
      } catch {}
    }
  }
}

async function pumpOpenAI(upstream: Response, emit: EmitFn, acc: { full: string }): Promise<void> {
  const reader = upstream.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
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
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta || {};
        if (delta.reasoning_content) emit({ k: "think", v: delta.reasoning_content });
        if (delta.content) { acc.full += delta.content; emit({ k: "text", v: delta.content }); }
      } catch {}
    }
  }
}
