import { NextRequest, NextResponse } from "next/server";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";
import { activatePublicModel, modelRuntimeSettings, OPENVINO_PORT, publicModels, SERVE_PORT } from "@/lib/lab";
import {
  listPruningExperiments,
  PRUNING_MODELS,
  pruningDatasets,
  pruningPlan,
  pruningRuntimeStatus,
  readPruningLog,
  savePruningPlan,
  startPruningExperiment,
  stopPruningExperiment,
} from "@/lib/pruning-lab";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  return NextResponse.json({
    runtime: pruningRuntimeStatus(),
    targets: PRUNING_MODELS,
    installedModels: publicModels(),
    datasets: pruningDatasets(),
    experiments: listPruningExperiments(),
    ...(id ? { log: readPruningLog(id) } : {}),
  });
}

async function quickTest(body: Record<string, unknown>) {
  const model = String(body.model || "");
  const prompt = String(body.prompt || "").trim();
  if (!publicModels().some((item) => item.name === model)) throw new Error("installed model not found");
  if (!prompt) throw new Error("prompt is required");
  const runtime = await activatePublicModel(model);
  const settings = modelRuntimeSettings(model);
  const maxTokens = Math.min(1024, Math.max(1, Number(body.maxTokens) || 256));
  const started = performance.now();
  let response: Response;
  if (runtime.backend === "ollama") {
    response = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: runtime.runtimeProfile,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: settings.thinking,
        options: { num_ctx: runtime.context, num_predict: maxTokens, temperature: settings.temperature },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const value = await response.json() as { message?: { content?: string }; eval_count?: number; eval_duration?: number };
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    return {
      model,
      backend: runtime.backend,
      text: value.message?.content || "",
      elapsedMs: Math.round(performance.now() - started),
      tokensPerSecond: value.eval_count && value.eval_duration ? +(value.eval_count / (value.eval_duration / 1e9)).toFixed(2) : null,
    };
  }
  const port = runtime.backend === "openvino" ? OPENVINO_PORT : SERVE_PORT;
  response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: runtime.runtimeProfile,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      max_tokens: maxTokens,
      temperature: settings.temperature,
      chat_template_kwargs: { enable_thinking: settings.thinking },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const value = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(value.error?.message || `runtime returned HTTP ${response.status}`);
  return {
    model,
    backend: runtime.backend,
    text: value.choices?.[0]?.message?.content || "",
    elapsedMs: Math.round(performance.now() - started),
    tokensPerSecond: null,
  };
}

export async function POST(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  try {
    if (body.action === "preview") return NextResponse.json({ ok: true, experiment: pruningPlan(body) });
    if (body.action === "plan") return NextResponse.json({ ok: true, experiment: savePruningPlan(body) });
    if (body.action === "start") {
      const result = startPruningExperiment(String(body.id || ""));
      return NextResponse.json(result, { status: result.ok ? 200 : 400 });
    }
    if (body.action === "stop") {
      const result = stopPruningExperiment();
      return NextResponse.json(result, { status: result.ok ? 200 : 400 });
    }
    if (body.action === "test") return NextResponse.json({ ok: true, result: await quickTest(body) });
    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
