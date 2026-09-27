// One entry point for research-mode model calls on the local runtime: JSON calls
// for planning/extraction and streamed calls for narration. Uses the same
// activation path as the rest of LAL, so it runs on whichever model is chosen.
import { activatePublicModel, modelRuntimeSettings, resolvedContextTarget, SERVE_PORT } from "@/lib/lab";

export type Msg = { role: "system" | "user" | "assistant"; content: string };
type Opts = { json?: boolean; maxTokens?: number; temperature?: number; signal?: AbortSignal; onToken?: (t: string) => void };

const CONTEXT = 16_384;

export async function complete(model: string, messages: Msg[], opts: Opts = {}): Promise<string> {
  const runtime = await activatePublicModel(model, Math.min(resolvedContextTarget(model), CONTEXT));
  const settings = modelRuntimeSettings(model);
  const maxTokens = Math.min(opts.maxTokens ?? 800, settings.maxOutputTokens || 4096);
  const temperature = opts.temperature ?? 0.3;
  const stream = !!opts.onToken;
  if (runtime.backend === "ollama") {
    const r = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST", headers: { "content-type": "application/json" }, signal: opts.signal,
      body: JSON.stringify({ model: runtime.runtimeProfile, messages, stream, think: false, ...(opts.json ? { format: "json" } : {}), options: { temperature, num_ctx: runtime.context, num_predict: maxTokens } }),
    });
    if (!r.ok) throw new Error(`model error ${r.status}`);
    if (!stream) return ((await r.json()) as { message?: { content?: string } }).message?.content ?? "";
    let out = "";
    await readLines(r, (line) => {
      try { const j = JSON.parse(line) as { message?: { content?: string } }; const t = j.message?.content ?? ""; if (t) { out += t; opts.onToken!(t); } } catch {}
    });
    return out;
  }
  const body = {
    model: runtime.runtimeProfile, messages, stream, temperature, max_tokens: maxTokens,
    chat_template_kwargs: { enable_thinking: false },
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  };
  let r = await fetch(`http://127.0.0.1:${SERVE_PORT}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: opts.signal });
  if (!r.ok && opts.json) {
    // Some templates reject response_format; retry as plain text and parse leniently.
    const { response_format: _drop, ...plain } = body as typeof body & { response_format?: unknown };
    void _drop;
    r = await fetch(`http://127.0.0.1:${SERVE_PORT}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(plain), signal: opts.signal });
  }
  if (!r.ok) throw new Error(`model error ${r.status}`);
  if (!stream) return ((await r.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
  let out = "";
  await readLines(r, (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    try { const j = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }; const t = j.choices?.[0]?.delta?.content ?? ""; if (t) { out += t; opts.onToken!(t); } } catch {}
  });
  return out;
}

async function readLines(r: Response, onLine: (line: string) => void) {
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); }
  }
  if (buf.trim()) onLine(buf.trim());
}

/** Lenient JSON: fenced block, whole text, or the outermost {...}. */
export function parseJson<T>(raw: string): T | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const c of [fenced, raw, raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)]) {
    if (!c) continue;
    try { return JSON.parse(c) as T; } catch {}
  }
  return null;
}
