import { NextRequest, NextResponse } from "next/server";
import { activatePublicModel, allModels, contextProfileForModel, readSettings, resolvedContextTarget, getConvo, saveConvo, newId, webSearch, retrieveDocs, servingModel, modelRuntimeSettings, SERVE_PORT, type Convo } from "@/lib/lab";
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
  const incoming = ((b.messages || []) as { role: string; content: string }[]).map((m) => ({ ...m }));
  const attachments: string[] = Array.isArray(b.attachments) ? b.attachments.filter((x: unknown) => typeof x === "string") : [];
  const s = readSettings();
  const requestedTextModel = typeof b.model === "string" && allModels().some((m) => m.name === b.model) ? b.model : s.model;
  const settingsModel = attachments.length
    ? attachments.length > VISION_FAST_THRESHOLD ? VISION_MODEL_FAST : VISION_MODEL_QUALITY
    : requestedTextModel;
  const runtimeSettings = modelRuntimeSettings(settingsModel);
  const think = runtimeSettings.thinking;
  const continueIndex = Number.isInteger(b.continueIndex) ? Number(b.continueIndex) : -1;
  const continuing = continueIndex >= 0 && continueIndex === incoming.length - 1 && incoming[continueIndex]?.role === "assistant";
  if (continuing) {
    incoming.push({
      role: "user",
      content: "Continue exactly where the previous assistant message stopped. Do not repeat it or introduce the continuation.",
    });
  }

  // grounding: toggles (settings.web / settings.groundDocs) or one-off /web /docs commands
  let system = s.system;
  const lastUser = [...incoming].reverse().find((m) => m.role === "user");
  const raw = (lastUser?.content || "").trim();
  let doWeb = !continuing && s.web, doDocs = !continuing && s.groundDocs, query = raw;
  if (raw.toLowerCase().startsWith("/web ")) { doWeb = true; query = raw.slice(5).trim(); if (lastUser) lastUser.content = query; }
  else if (raw.toLowerCase().startsWith("/docs ")) { doDocs = true; query = raw.slice(6).trim(); if (lastUser) lastUser.content = query; }
  const extra: string[] = [];
  if (doWeb && query) extra.push("LIVE WEB RESULTS (cite by [number]):\n" + (await webSearch(query)));
  if (doDocs && query) extra.push("DOCUMENT EXCERPTS — answer only from these, cite by [number]:\n" + (retrieveDocs(query) || "(no relevant excerpts found)"));
  // The client sends the HTML artifact currently in effect (chat's ```html/```edit
  // flow) — but this route used to DROP it, so the model could neither see the code
  // it was asked to change nor knew ```edit existed. Observed live 2026-07-09:
  // "make the snake blue" produced a 450-char partial ```html block that replaced
  // the entire game. The artifact + the edit contract go into the system prompt.
  const artifact = typeof b.currentArtifact === "string" ? b.currentArtifact : "";
  if (artifact && !continuing) {
    const capped = artifact.length > 12000 ? artifact.slice(0, 12000) + "\n<!-- …truncated — edit only the part shown… -->" : artifact;
    extra.push(
      "CURRENT HTML ARTIFACT (the exact file the user is iterating on right now — its latest state, including edits already applied):\n```html\n" + capped + "\n```\n" +
      "To MODIFY it, reply with a ```edit block of SEARCH/REPLACE sections:\n" +
      "```edit\n<<<<<<< SEARCH\n<exact lines copied from the artifact above>\n=======\n<replacement lines>\n>>>>>>> REPLACE\n```\n" +
      "Rules: SEARCH must match the artifact text exactly. Use ```edit for any change or addition to this artifact. " +
      "Output a complete ```html file ONLY when creating something new or rewriting most of it — NEVER a partial file inside ```html.",
    );
  }
  if (extra.length) system = (s.system ? s.system + "\n\n" : "") + extra.join("\n\n");

  const cid = b.conversationId || newId();
  const convo: Convo = getConvo(cid) || { id: cid, title: "", ts: Date.now(), messages: [] };
  convo.messages = incoming.slice();
  convo.think = think;
  saveConvo(convo);

  const saveReply = (full: string) => {
    try {
      if (continuing) {
        const original = incoming[continueIndex]?.content || "";
        convo.messages = [...incoming.slice(0, continueIndex), { role: "assistant", content: original + full }];
      } else {
        convo.messages = [...incoming, { role: "assistant", content: full }];
      }
      saveConvo(convo);
    } catch {}
  };
  // A process restart skips `finally`, so waiting until a run settles loses the
  // whole reply from the conversation even though the run ledger has it. Keep a
  // compact, throttled checkpoint in the conversation; the durable event ledger
  // remains the detailed source, while this makes an interrupted chat resumable.
  const newReplyAccumulator = (): ReplyAccumulator => {
    let lastCheckpoint = 0;
    const acc: ReplyAccumulator = {
      full: "",
      checkpoint: () => {
        const now = Date.now();
        if (acc.full && now - lastCheckpoint >= 750) {
          saveReply(acc.full);
          lastCheckpoint = now;
        }
      },
    };
    return acc;
  };

  if (attachments.length) {
    const visionModel = attachments.length > VISION_FAST_THRESHOLD ? VISION_MODEL_FAST : VISION_MODEL_QUALITY;
    const visionCtx = resolvedContextTarget(visionModel);
    convo.model = visionModel;
    const meta = startRun({ kind: "chat", conversationId: cid, model: visionModel }, async (emit, signal) => {
      emit({ k: "model_loading", v: { model: visionModel, ctx: visionCtx, contextProfile: contextProfileForModel(visionModel) } });
      const parked = servingModel();
      const runtime = await activatePublicModel(visionModel, visionCtx);

      const ollamaMessages = incoming.map((m, i) =>
        i === incoming.length - 1 && m.role === "user"
          ? { role: m.role, content: m.content, images: attachments.map(stripDataUrl) }
          : { role: m.role, content: m.content });
      if (system) ollamaMessages.unshift({ role: "system", content: system });

      const acc = newReplyAccumulator();
      try {
        // Tell the UI which vision model actually answered — "fast" vs "quality" is
        // otherwise invisible; the user asked to be able to notice which one ran.
        emit({ k: "model", v: visionModel });
        const upstream = await fetch("http://127.0.0.1:11434/api/chat", {
          method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: runtime.runtimeProfile, messages: ollamaMessages, stream: true, think,
          options: { temperature: runtimeSettings.temperature, top_p: runtimeSettings.topP, top_k: runtimeSettings.topK, num_ctx: runtime.context, num_predict: runtimeSettings.maxOutputTokens },
        }),
          signal,
        });
        if (!upstream.ok || !upstream.body) throw new Error("vision upstream error: " + upstream.status);
        emit({ k: "context_profile", v: runtime.contextProfile });
        emit({ k: "model_ready", v: { model: visionModel, ctx: runtime.context, backend: runtime.backend, contextProfile: runtime.contextProfile, runtimeProfile: runtime.runtimeProfile } });
        await pumpOllama(upstream, emit, signal, acc, runtime.context);
      } finally {
        // A stopped/failed generation still persists whatever streamed so far —
        // same behavior the old inline stream had.
        if (acc.full) saveReply(acc.full);
        if (parked && parked !== visionModel) { try { await activatePublicModel(parked); } catch { /* next text message will surface it */ } }
      }
    });
    return NextResponse.json({ runId: meta.id, conversationId: cid }, { headers: { "x-conversation-id": cid } });
  }

  const requestedModel = requestedTextModel;
  if (!requestedModel) return new Response("no model available — train or install one", { status: 409 });
  convo.model = requestedModel;

  const requestedContext = resolvedContextTarget(requestedModel);
  const meta = startRun({ kind: "chat", conversationId: cid, model: requestedModel }, async (emit, signal) => {
    // Serving happens INSIDE the run — a cold model load can take a minute, and the
    // POST reply must not wait on it (the client is already attached and watching).
    emit({ k: "model_loading", v: { model: requestedModel, ctx: requestedContext, contextProfile: contextProfileForModel(requestedModel) } });
    const runtime = await activatePublicModel(requestedModel, requestedContext);
    const useOllama = runtime.backend === "ollama";

    const payload: Record<string, unknown> = {
      model: runtime.runtimeProfile,
      messages: system ? [{ role: "system", content: system }, ...incoming] : incoming,
      stream: true,
      // Required for llama-server to include usage on a streamed response — the
      // context meter is blind without it.
      stream_options: { include_usage: true },
      // Token-confidence capture. Supported HERE because chat sends no tools —
      // llama-server b9835 400s on logprobs + tools + stream (the /code loop's
      // combination), so the agent path can't have this until llama.cpp lifts it.
      logprobs: true,
      top_logprobs: 8,
      temperature: runtimeSettings.temperature,
      top_p: runtimeSettings.topP,
      top_k: runtimeSettings.topK,
      repeat_penalty: runtimeSettings.repeatPenalty,
    };
    if (runtimeSettings.maxOutputTokens > 0) payload.max_tokens = runtimeSettings.maxOutputTokens;
    if (!think) payload.chat_template_kwargs = { enable_thinking: false };

    const acc = newReplyAccumulator();
    try {
      if (useOllama) {
        const upstream = await fetch("http://127.0.0.1:11434/api/chat", {
          method: "POST", headers: { "content-type": "application/json" }, signal,
          body: JSON.stringify({ model: runtime.runtimeProfile, messages: system ? [{ role: "system", content: system }, ...incoming] : incoming, stream: true, think,
            options: { temperature: runtimeSettings.temperature, top_p: runtimeSettings.topP, top_k: runtimeSettings.topK, num_ctx: runtime.context, num_predict: runtimeSettings.maxOutputTokens },
          }),
        });
        if (!upstream.ok || !upstream.body) throw new Error("Ollama upstream error: " + upstream.status);
        emit({ k: "context_profile", v: runtime.contextProfile });
        emit({ k: "model_ready", v: { model: requestedModel, ctx: runtime.context, backend: runtime.backend, contextProfile: runtime.contextProfile, runtimeProfile: runtime.runtimeProfile } });
        await pumpOllama(upstream, emit, signal, acc, runtime.context);
        return;
      }
      let upstream = await fetch(`http://127.0.0.1:${SERVE_PORT}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      // Keep every configured text model usable even when its backend does not
      // implement streamed logprobs. The client renders a clear unavailable state
      // in that case rather than fabricating a confidence trace.
      if (!upstream.ok && [400, 422, 501].includes(upstream.status)) {
        const fallback = { ...payload };
        delete fallback.logprobs;
        delete fallback.top_logprobs;
        upstream = await fetch(`http://127.0.0.1:${SERVE_PORT}/v1/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fallback), signal,
        });
      }
    if (!upstream.ok || !upstream.body) throw new Error("upstream error: " + upstream.status);
      emit({ k: "context_profile", v: runtime.contextProfile });
      emit({ k: "model_ready", v: { model: requestedModel, ctx: runtime.context, backend: runtime.backend, contextProfile: runtime.contextProfile } });
      await pumpOpenAI(upstream, emit, acc, runtime.context);
    } finally {
      if (acc.full) saveReply(acc.full);
    }
  });

  return NextResponse.json({ runId: meta.id, conversationId: cid }, { headers: { "x-conversation-id": cid } });
}

// Both pumps accumulate into a caller-owned object so a mid-stream abort/error
// still leaves the partial text where the caller's `finally` can persist it.
// Ollama's /api/chat streams NDJSON, not SSE.
type ReplyAccumulator = { full: string; checkpoint: () => void };

async function pumpOllama(upstream: Response, emit: EmitFn, signal: AbortSignal, acc: ReplyAccumulator, ctx: number): Promise<void> {
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
        if (tok) { acc.full += tok; acc.checkpoint(); emit({ k: "text", v: tok }); }
        if (j.message?.thinking) emit({ k: "think", v: j.message.thinking });
        if (j.done) {
          const promptTokens = Number(j.prompt_eval_count) || 0;
          const completionTokens = Number(j.eval_count) || 0;
          const evalDuration = Number(j.eval_duration) || 0;
          emit({ k: "usage", v: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            tokPerSec: evalDuration > 0 ? Math.round((completionTokens / (evalDuration / 1e9)) * 10) / 10 : null,
            ctx,
          } });
          if (j.done_reason === "length") emit({ k: "truncated", v: { round: 0 } });
        }
      } catch {}
    }
  }
}

async function pumpOpenAI(upstream: Response, emit: EmitFn, acc: ReplyAccumulator, ctx: number): Promise<void> {
  const reader = upstream.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  // Certainty stats for the whole reply — every token's probability is also
  // recorded on its own event (p, plus alts when the choice was uncertain), so
  // the run ledger doubles as analysis data for the evolution loop.
  let confSum = 0, confN = 0, confMin = 1, confLow = 0;
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
        const j = JSON.parse(data);
        const choice = j.choices?.[0] || {};
        const delta = choice.delta || {};
        let p: number | undefined;
        let alts: [string, number][] | undefined;
        const lpArr = choice.logprobs?.content as { token?: string; logprob?: number; top_logprobs?: { token: string; logprob: number }[] }[] | undefined;
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
          if (p < 0.8 && lpArr[0]?.top_logprobs?.length) {
            alts = lpArr[0].top_logprobs
              .filter((t) => t.token !== lpArr[0].token)
              .slice(0, 5)
              .map((t) => [t.token, Math.round(Math.exp(t.logprob) * 1000) / 1000]);
          }
        }
        if (delta.reasoning_content) emit({ k: "think", v: delta.reasoning_content, ...(p !== undefined && !delta.content ? { p } : {}) });
        if (delta.content) { acc.full += delta.content; acc.checkpoint(); emit({ k: "text", v: delta.content, ...(p !== undefined ? { p } : {}), ...(alts ? { alts } : {}) }); }
        if (j.usage) {
          const promptTokens = Number(j.timings?.cache_n ?? 0) + Number(j.timings?.prompt_n ?? j.usage.prompt_tokens ?? 0);
          const completionTokens = Number(j.timings?.predicted_n ?? j.usage.completion_tokens ?? 0);
          emit({ k: "usage", v: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            tokPerSec: typeof j.timings?.predicted_per_second === "number" ? Math.round(j.timings.predicted_per_second * 10) / 10 : null,
            ctx,
            conf: confN ? { avg: Math.round((confSum / confN) * 1000) / 1000, min: Math.round(confMin * 1000) / 1000, low: confLow } : null,
          } });
        }
        if (choice.finish_reason === "length") emit({ k: "truncated", v: { round: 0 } });
      } catch {}
    }
  }
}
