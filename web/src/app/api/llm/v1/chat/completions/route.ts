import { allModels, ensureServing, SERVE_PORT, touchServing } from "@/lib/lab";
import { appendHostObservationForClientDevice } from "@/lib/runs";
import { acquireCliGpuLease, cliAuthenticatedDeviceId, cliAuthorized, recordCliAccess, streamWithRelease, unauthorizedResponse } from "@/lib/lal-cli";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

type Usage = { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
type Logprob = { logprob?: unknown; token?: unknown; top_logprobs?: Array<{ token?: unknown; logprob?: unknown }> };

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export async function POST(request: Request) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "chat completion", authorized);
  if (!authorized) return unauthorizedResponse();
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload) return Response.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, { status: 400 });

  const model = typeof payload.model === "string" ? payload.model : "";
  const deviceId = cliAuthenticatedDeviceId(request);
  const available = allModels().some((item) => item.source === "local" && item.name === model);
  if (!available) {
    return Response.json(
      { error: { message: `Unknown or unsupported CLI model: ${model}`, type: "invalid_request_error" } },
      { status: 404 },
    );
  }

  const startedAt = Date.now();
  let streamText = "";
  let lastUsage: Usage | null = null;
  const decoder = new TextDecoder();
  const observeStream = (chunk?: Uint8Array, final = false) => {
    if (chunk) streamText += decoder.decode(chunk, { stream: true });
    if (final) streamText += decoder.decode();
    const lines = streamText.split("\n");
    streamText = final ? "" : (lines.pop() ?? "");
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as { usage?: Usage; choices?: Array<{ logprobs?: { content?: Logprob[] } }> };
        if (parsed.usage) lastUsage = parsed.usage;
        for (const item of parsed.choices?.[0]?.logprobs?.content ?? []) {
          const logprob = typeof item.logprob === "number" ? item.logprob : null;
          if (logprob == null || !Number.isFinite(logprob)) continue;
          const p = Math.max(0, Math.min(1, Math.exp(logprob)));
          const alts = (item.top_logprobs ?? []).flatMap((candidate): [string, number][] => {
            if (typeof candidate.token !== "string" || typeof candidate.logprob !== "number" || !Number.isFinite(candidate.logprob)) return [];
            return [[candidate.token, Math.max(0, Math.min(1, Math.exp(candidate.logprob)))]];
          });
          appendHostObservationForClientDevice(deviceId, { k: "token_confidence", v: { ...(typeof item.token === "string" ? { token: item.token } : {}), p, ...(alts.length ? { alts } : {}) } });
        }
      } catch { /* malformed provider frames remain visible to the client unchanged */ }
    }
  };
  const publishUsage = () => {
    if (!lastUsage) return;
    const promptTokens = asCount(lastUsage.prompt_tokens);
    const completionTokens = asCount(lastUsage.completion_tokens);
    const totalTokens = asCount(lastUsage.total_tokens) || promptTokens + completionTokens;
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    appendHostObservationForClientDevice(deviceId, {
      k: "usage",
      v: { promptTokens, completionTokens, totalTokens, tokPerSec: completionTokens ? Number((completionTokens / elapsedSeconds).toFixed(1)) : null, ctx: 32768, conf: null },
    });
  };

  appendHostObservationForClientDevice(deviceId, { k: "model_loading", v: { model, ctx: 32768 } });
  const release = await acquireCliGpuLease();
  try {
    await ensureServing(model, 32768);
    touchServing();
    appendHostObservationForClientDevice(deviceId, { k: "model_ready", v: { model, ctx: 32768, backend: "llama.cpp" } });
    const upstreamPayload = payload.stream === true
      ? { ...payload, logprobs: true, top_logprobs: 3, stream_options: { ...(typeof payload.stream_options === "object" && payload.stream_options ? payload.stream_options as Record<string, unknown> : {}), include_usage: true } }
      : payload;
    const upstream = await fetch(`http://127.0.0.1:${SERVE_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: request.headers.get("accept") ?? "application/json" },
      body: JSON.stringify(upstreamPayload),
      signal: request.signal,
    });
    if (!upstream.body) {
      release();
      return new Response(null, { status: upstream.status, headers: upstream.headers });
    }
    const headers = new Headers(upstream.headers);
    headers.set("cache-control", "no-store");
    return new Response(streamWithRelease(upstream.body, release, {
      onChunk: (chunk) => observeStream(chunk),
      onClose: () => { observeStream(undefined, true); publishUsage(); },
    }), { status: upstream.status, headers });
  } catch (error) {
    release();
    const message = error instanceof Error ? error.message : String(error);
    appendHostObservationForClientDevice(deviceId, { k: "error", v: message });
    return Response.json({ error: { message, type: "server_error" } }, { status: 503 });
  }
}
