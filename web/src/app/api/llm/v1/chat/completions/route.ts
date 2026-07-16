import { allModels, ensureServing, SERVE_PORT, stopServing, touchServing } from "@/lib/lab";
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

const OLLAMA_CLI_CONTEXT = 16384;
const OLLAMA_CLI_PROFILE_SUFFIX = "-lal-cli-16k";

/** The OpenAI-compatible Ollama endpoint has no request-level context option.
 * A model created from a tiny Modelfile is the documented persistent way to
 * keep an agent's tool schemas and output budget out of the 4K default. */
function managedOllamaModel(model: string): string {
  const candidate = `${model}${OLLAMA_CLI_PROFILE_SUFFIX}`;
  return allModels().some((item) => item.name === candidate) ? candidate : model;
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
  const modelInfo = allModels().find((item) => item.name === model);
  const available = Boolean(modelInfo);
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

  appendHostObservationForClientDevice(deviceId, { k: "model_loading", v: { model, ctx: modelInfo?.source === "ollama" ? 16384 : 32768 } });
  const release = await acquireCliGpuLease();
  try {
    const isOllama = modelInfo?.source === "ollama";
    const upstreamModel = isOllama ? managedOllamaModel(model) : model;
    if (isOllama) {
      // Gemma and other Ollama-only architectures must never be handed to the
      // pinned llama.cpp build. Stop our server so Ollama owns the GPU, then
      // use Ollama's OpenAI-compatible endpoint below.
      stopServing();
    } else {
      await ensureServing(model, 32768);
    }
    touchServing();
    appendHostObservationForClientDevice(deviceId, { k: "model_ready", v: { model, ctx: isOllama ? 16384 : 32768, backend: isOllama ? "ollama" : "llama.cpp" } });
    // llama.cpp rejects logprobs together with streamed tool definitions. Keep
    // the terminal agent's tool loop working first; request token confidence
    // only for plain streamed turns where this backend supports it.
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
    const payloadWithoutLogprobs = { ...payload };
    // Do not pass through a client-provided flag either: tool-capable streams
    // must remain valid even if an older managed config requested it.
    delete payloadWithoutLogprobs.logprobs;
    delete payloadWithoutLogprobs.top_logprobs;
    const upstreamPayload = payload.stream === true
      ? {
          ...payloadWithoutLogprobs,
          ...(hasTools ? { tools: compactTools(payload.tools) } : {}),
          // Ollama's OpenAI compatibility layer does not reliably accept or
          // return logprobs; only ask llama.cpp for the J-space signal.
          ...(!hasTools && !isOllama ? { logprobs: true, top_logprobs: 3 } : {}),
          stream_options: {
            ...(typeof payload.stream_options === "object" && payload.stream_options ? payload.stream_options as Record<string, unknown> : {}),
            include_usage: true,
          },
        }
      : payloadWithoutLogprobs;
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
