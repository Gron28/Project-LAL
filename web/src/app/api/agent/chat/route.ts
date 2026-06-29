import { NextRequest } from "next/server";
import { ensureServing, readSettings, getConvo, saveConvo, newId, webSearch, retrieveDocs, SERVE_PORT } from "@/lib/lab";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const incoming = (b.messages || []) as { role: string; content: string }[];
  const s = readSettings();
  if (!s.model) return new Response("no model available — train or install one", { status: 409 });
  try {
    await ensureServing(s.model);
  } catch (e) {
    return new Response("serve failed: " + (e as Error).message, { status: 500 });
  }

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
  const enc = new TextEncoder();
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
