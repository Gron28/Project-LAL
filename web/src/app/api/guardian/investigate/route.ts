import { NextRequest, NextResponse } from "next/server";
import { readGuardianAdapters } from "@/lib/guardian-adapters";
import { readGuardianEvidence } from "@/lib/guardian-evidence";
import { readGuardianStatus } from "@/lib/guardian-observer";
import { authorizeGuardianOwnerMutation } from "@/lib/guardian-owner-auth";
import { readGuardianCorrelation } from "@/lib/guardian-correlation";
import { buildGuardianInvestigatorMessages } from "@/lib/guardian-investigator";
import { activatePublicModel, allModels, modelRuntimeSettings, readSettings, resolvedContextTarget, SERVE_PORT } from "@/lib/lab";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function observationBundle() {
  const status = readGuardianStatus();
  const adapters = readGuardianAdapters().map(({ id, name, state, domain, capabilities }) => ({ id, name, state, domain, capabilities }));
  const evidence = readGuardianEvidence(30);
  return {
    collectedAt: Date.now(),
    coverage: status.coverage,
    errors: { process: status.error, network: status.networkError },
    processCount: status.processCount,
    connectionCount: status.connectionCount,
    recentEvents: status.events.slice(-30),
    adapters,
    findingsIntegrity: evidence.integrity,
    findings: evidence.findings,
    correlatedReviewCases: readGuardianCorrelation().cases,
  };
}

export async function POST(request: NextRequest) {
  const owner = authorizeGuardianOwnerMutation(request);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 4_000) : "";
  if (!question) return NextResponse.json({ error: "a question is required" }, { status: 400 });
  const settings = readSettings();
  const model = settings.model || allModels()[0]?.name;
  if (!model) return NextResponse.json({ error: "no local model is installed" }, { status: 409 });
  try {
    const runtime = await activatePublicModel(model, resolvedContextTarget(model));
    const runtimeSettings = modelRuntimeSettings(model);
    const messages = buildGuardianInvestigatorMessages(observationBundle(), question);
    if (runtime.backend === "ollama") {
      const response = await fetch("http://127.0.0.1:11434/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: runtime.runtimeProfile, messages, stream: false, think: false, options: { temperature: Math.min(runtimeSettings.temperature, 0.3), num_ctx: runtime.context, num_predict: 900 } }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Ollama HTTP ${response.status}`);
      return NextResponse.json({ model, answer: payload.message?.content || "The local model returned no answer.", observationCollectedAt: Date.now() });
    }
    const response = await fetch(`http://127.0.0.1:${SERVE_PORT}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: runtime.runtimeProfile, messages, temperature: Math.min(runtimeSettings.temperature, 0.3), max_tokens: 900, chat_template_kwargs: { enable_thinking: false } }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || `llama.cpp HTTP ${response.status}`);
    return NextResponse.json({ model, answer: payload.choices?.[0]?.message?.content || "The local model returned no answer.", observationCollectedAt: Date.now() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "investigation failed" }, { status: 503 });
  }
}
