import { NextRequest } from "next/server";
import { ensureServing, readSettings, getConvo, saveConvo, newId, webSearch, retrieveDocs, servingModel, stopServing, SERVE_PORT } from "@/lib/lab";

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

  const enc = new TextEncoder();

  if (attachments.length) {
    const visionModel = attachments.length > VISION_FAST_THRESHOLD ? VISION_MODEL_FAST : VISION_MODEL_QUALITY;
    // GPU is single-tenant: park our own llama-server (if resident) before Ollama
    // loads Gemma — HANDOFF bug #1 was exactly this pair of backends colliding.
    const parked = servingModel();
    if (parked) stopServing();

    const ollamaMessages = incoming.map((m, i) =>
      i === incoming.length - 1 && m.role === "user"
        ? { role: m.role, content: m.content, images: attachments.map(stripDataUrl) }
        : { role: m.role, content: m.content });
    if (system) ollamaMessages.unshift({ role: "system", content: system });

    let upstream: Response;
    try {
      upstream = await fetch("http://127.0.0.1:11434/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: visionModel, messages: ollamaMessages, stream: true, options: { temperature: s.options.temperature } }),
      });
    } catch (e) {
      if (parked) { try { await ensureServing(parked); } catch {} }
      return new Response("vision call failed: " + (e as Error).message, { status: 502 });
    }
    if (!upstream.ok || !upstream.body) {
      if (parked) { try { await ensureServing(parked); } catch {} }
      return new Response("vision upstream error: " + upstream.status, { status: 502 });
    }

    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let full = "";
    const stream = new ReadableStream({
      async start(controller) {
        // Tell the UI which vision model actually answered — "fast" vs "quality" is
        // otherwise invisible; the user asked to be able to notice which one ran.
        controller.enqueue(enc.encode(JSON.stringify({ k: "model", v: visionModel }) + "\n"));
        let buf = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(i + 1);
              if (!line) continue;
              try {
                const j = JSON.parse(line); // Ollama's /api/chat streams NDJSON, not SSE
                const tok = j.message?.content || "";
                if (tok) { full += tok; controller.enqueue(enc.encode(JSON.stringify({ k: "text", v: tok }) + "\n")); }
              } catch {}
            }
          }
        } catch {}
        try { convo.messages = [...incoming, { role: "assistant", content: full }]; saveConvo(convo); } catch {}
        if (parked) { try { await ensureServing(parked); } catch { /* next text message will surface it */ } }
        try { controller.close(); } catch {}
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/plain; charset=utf-8", "x-conversation-id": cid, "x-generation-id": newId() },
    });
  }

  if (!s.model) return new Response("no model available — train or install one", { status: 409 });
  try {
    await ensureServing(s.model);
  } catch (e) {
    return new Response("serve failed: " + (e as Error).message, { status: 500 });
  }

  const payload: Record<string, unknown> = {
    messages: system ? [{ role: "system", content: system }, ...incoming] : incoming,
    stream: true,
    temperature: s.options.temperature,
    top_p: s.options.top_p,
    top_k: s.options.top_k,
    repeat_penalty: s.options.repeat_penalty,
  };
  if (s.options.num_predict > 0) payload.max_tokens = s.options.num_predict;

  const upstream = await fetch(`http://127.0.0.1:${SERVE_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!upstream.ok || !upstream.body) return new Response("upstream error", { status: 502 });

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let full = "";

  const stream = new ReadableStream({
    async start(controller) {
      let buf = "";
      try {
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
              const tok = JSON.parse(data).choices?.[0]?.delta?.content || "";
              if (tok) { full += tok; controller.enqueue(enc.encode(JSON.stringify({ k: "text", v: tok }) + "\n")); }
            } catch {}
          }
        }
      } catch {}
      try { convo.messages = [...incoming, { role: "assistant", content: full }]; saveConvo(convo); } catch {}
      try { controller.close(); } catch {}
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8", "x-conversation-id": cid, "x-generation-id": newId() },
  });
}
