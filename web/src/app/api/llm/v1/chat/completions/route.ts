import { activatePublicModel, allModels, contextProfileForModel, isPublicModelName, modelRuntimeSettings, SERVE_PORT, touchServing } from "@/lib/lab";
import { appendHostObservationForClientDevice } from "@/lib/runs";
import { acquireCliGpuLease, cliAuthenticatedDeviceId, cliAuthorized, recordCliAccess, streamWithRelease, unauthorizedResponse } from "@/lib/lal-cli";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

type Usage = { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
type Logprob = { logprob?: unknown; token?: unknown; top_logprobs?: Array<{ token?: unknown; logprob?: unknown }> };
const LAL_TERMINAL_TOOLS = new Set([
  "read_file",
  "edit",
  "write_file",
  "run_shell_command",
  // Orientation tools: without list/search the model cannot discover the
  // project it is asked to change, which manifested as repeat-loops instead
  // of tool calls.
  "grep_search",
  "glob",
  "list_directory",
  "todo_write",
  // One-chat project orchestration. These are deliberately the only larger
  // synthetic schemas admitted for managed terminals; teams/workflows/CUA
  // remain outside this small-model boundary.
  "tool_search",
  "agent",
  "task_stop",
  "web_search",
  "web_fetch",
  // Browser acceptance tools remain lazy behind tool_search; admitting them
  // here lets their eventual schemas and results stay in the same turn.
  "launch_app",
  "list_windows",
  "get_window_state",
  "page",
  "screenshot",
]);

// Budget guards, not documentation removal: a small local model needs the
// real tool contract to emit correct native tool_calls, but inherited prose
// must not consume most of a 32k turn.
const TOOL_DESCRIPTION_MAX_CHARS = 700;
const PARAM_DESCRIPTION_MAX_CHARS = 240;

function trimDescription(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return `${boundary > max * 0.5 ? cut.slice(0, boundary + 1) : cut}…`;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Keep the executable tool contract AND its meaning. Tool names, parameter
 * names, types, required fields, enums, and structural constraints are
 * preserved; descriptions are kept but length-bounded, and purely decorative
 * annotations (title/examples/$schema) are removed. Stripping descriptions
 * entirely left 4B models with undocumented tools they could not use —
 * the direct cause of buried/looping tool calls. */
function compactToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactToolSchema);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "title" || key === "examples" || key === "$schema") continue;
    if (key === "description") {
      const trimmed = trimDescription(child, PARAM_DESCRIPTION_MAX_CHARS);
      if (trimmed) compact[key] = trimmed;
      continue;
    }
    compact[key] = compactToolSchema(child);
  }
  return compact;
}

function compactTools(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const entry = tool as Record<string, unknown>;
    const fn = entry.function;
    if (!fn || typeof fn !== "object") return tool;
    const functionDef = fn as Record<string, unknown>;
    const name = typeof functionDef.name === "string" ? functionDef.name : "tool";
    // This is the product boundary, not merely a client preference: old
    // managed settings cannot quietly reintroduce agent teams, generic
    // clarification dialogs, MCP, or workflow tools into a small-model turn.
    if (!LAL_TERMINAL_TOOLS.has(name)) return [];
    return {
      ...entry,
      function: {
        ...functionDef,
        description: trimDescription(functionDef.description, TOOL_DESCRIPTION_MAX_CHARS) ?? `Use ${name} when needed.`,
        ...(Object.hasOwn(functionDef, "parameters") ? { parameters: compactToolSchema(functionDef.parameters) } : {}),
      },
    };
  });
}

export async function POST(request: Request) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "chat completion", authorized);
  if (!authorized) return unauthorizedResponse();
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload) return Response.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, { status: 400 });

  const model = typeof payload.model === "string" ? payload.model : "";
  const deviceId = cliAuthenticatedDeviceId(request);
  const modelInfo = isPublicModelName(model) ? allModels().find((item) => item.name === model) : undefined;
  const available = Boolean(modelInfo);
  if (!available) {
    return Response.json(
      { error: { message: `Unknown or unsupported CLI model: ${model}`, type: "invalid_request_error" } },
      { status: 404 },
    );
  }

  const startedAt = Date.now();
  const managedSettings = modelRuntimeSettings(model);
  const plannedContext = contextProfileForModel(model);
  let observedContext = plannedContext.activeTokens ?? plannedContext.verifiedTokens ?? plannedContext.requestedTokens;
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
      v: { promptTokens, completionTokens, totalTokens, tokPerSec: completionTokens ? Number((completionTokens / elapsedSeconds).toFixed(1)) : null, ctx: observedContext, conf: null },
    });
  };

  appendHostObservationForClientDevice(deviceId, { k: "model_loading", v: { model, ctx: observedContext, contextProfile: plannedContext } });
  const release = await acquireCliGpuLease();
  try {
    const runtime = await activatePublicModel(model);
    const isOllama = runtime.backend === "ollama";
    const upstreamModel = runtime.runtimeProfile;
    const runtimeContext = runtime.context;
    const runtimeOffload = runtime.gpuOffload;
    observedContext = runtimeContext;
    touchServing();
    appendHostObservationForClientDevice(deviceId, { k: "context_profile", v: runtime.contextProfile });
    appendHostObservationForClientDevice(deviceId, { k: "model_ready", v: { model, ctx: runtimeContext, backend: runtime.backend, contextProfile: runtime.contextProfile, gpuOffload: runtimeOffload, ...(upstreamModel !== model ? { runtimeProfile: upstreamModel } : {}) } });
    // llama.cpp rejects logprobs together with streamed tool definitions. Keep
    // the terminal agent's tool loop working first; request token confidence
    // only for plain streamed turns where this backend supports it.
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
    const payloadWithoutLogprobs = { ...payload };
    // Do not pass through a client-provided flag either: tool-capable streams
    // must remain valid even if an older managed config requested it.
    delete payloadWithoutLogprobs.logprobs;
    delete payloadWithoutLogprobs.top_logprobs;
    const clientMaxTokens = typeof payloadWithoutLogprobs.max_tokens === "number" && payloadWithoutLogprobs.max_tokens > 0
      ? Math.floor(payloadWithoutLogprobs.max_tokens)
      : null;
    const managedMaxTokens = managedSettings.maxOutputTokens > 0
      ? clientMaxTokens == null ? managedSettings.maxOutputTokens : Math.min(clientMaxTokens, managedSettings.maxOutputTokens)
      : clientMaxTokens;
    const priorTemplate = payloadWithoutLogprobs.chat_template_kwargs && typeof payloadWithoutLogprobs.chat_template_kwargs === "object"
      ? payloadWithoutLogprobs.chat_template_kwargs as Record<string, unknown>
      : {};
    const managedPayload = {
      ...payloadWithoutLogprobs,
      temperature: managedSettings.temperature,
      top_p: managedSettings.topP,
      top_k: managedSettings.topK,
      repeat_penalty: managedSettings.repeatPenalty,
      ...(managedMaxTokens != null ? { max_tokens: managedMaxTokens } : {}),
      chat_template_kwargs: { ...priorTemplate, enable_thinking: managedSettings.thinking },
      ...(isOllama ? { think: managedSettings.thinking } : {}),
    };
    const upstreamPayload = payload.stream === true
      ? {
          ...managedPayload,
          ...(hasTools ? { tools: compactTools(payload.tools) } : {}),
          // Ollama's OpenAI compatibility layer does not reliably accept or
          // return logprobs; only ask llama.cpp for the J-space signal.
          // llama.cpp's OAI layer 400s on `logprobs` + tools + stream, but its
          // native `n_probs` param bypasses that validation and still returns
          // OAI-shaped logprobs on streamed deltas (verified against b9835,
          // 2026-07-19) — so tool-carrying turns get the J-space signal too.
          ...(!isOllama
            ? hasTools
              ? { n_probs: 3 }
              : { logprobs: true, top_logprobs: 3 }
            : {}),
          stream_options: {
            ...(typeof payload.stream_options === "object" && payload.stream_options ? payload.stream_options as Record<string, unknown> : {}),
            include_usage: true,
          },
        }
      : managedPayload;
    const upstream = await fetch(`${isOllama ? "http://127.0.0.1:11434" : `http://127.0.0.1:${SERVE_PORT}`}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: request.headers.get("accept") ?? "application/json" },
      body: JSON.stringify({ ...upstreamPayload, model: upstreamModel }),
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
