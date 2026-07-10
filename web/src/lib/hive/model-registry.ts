import crypto from "node:crypto";
import fs from "node:fs";
import { allModels, ensureServing, readSettings, SERVE_PORT, stopServing } from "../lab";
import type { ModelCapability, ModelProfile } from "./contracts";
import { listModelProfiles, upsertModelProfile } from "./store";

function modelVersionHash(modelPath: string): string {
  try {
    const stat = fs.statSync(modelPath);
    return crypto.createHash("sha256").update(`${modelPath}:${stat.size}:${stat.mtimeMs}`).digest("hex");
  } catch { return crypto.createHash("sha256").update(modelPath).digest("hex"); }
}

export function discoverModelProfiles(): ModelProfile[] {
  const stored = new Map(listModelProfiles().map((p) => [p.id, p]));
  const settings = readSettings();
  for (const model of allModels()) {
    const id = `${model.source}:${model.name}`;
    const versionHash = modelVersionHash(model.path);
    const old = stored.get(id);
    const profile: ModelProfile = old && old.versionHash === versionHash ? old : {
      id, provider: model.source === "ollama" ? "ollama" : "llama.cpp", model: model.name, versionHash,
      capabilities: [], structuredOutput: "none", contextCeiling: settings.options.num_ctx || 8_192,
      memoryGb: model.gb, backendCompatible: false, probeStatus: "discovered",
    };
    upsertModelProfile(profile);
    stored.set(id, profile);
  }
  return [...stored.values()];
}

async function request(baseUrl: string, body: Record<string, unknown>, timeoutMs = 120_000): Promise<{ ok: boolean; json: Record<string, unknown>; elapsed: number }> {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { ok: response.ok, json, elapsed: Date.now() - started };
  } catch (e) { return { ok: false, json: { error: (e as Error).message }, elapsed: Date.now() - started }; }
}

export async function probeModel(profileId: string): Promise<ModelProfile> {
  const profile = discoverModelProfiles().find((p) => p.id === profileId);
  if (!profile) throw new Error("model profile not found");
  upsertModelProfile({ ...profile, probeStatus: "probing", probeError: undefined });
  try {
    let baseUrl = `http://127.0.0.1:${SERVE_PORT}`;
    if (profile.provider === "ollama" && /gemma/i.test(profile.model)) { stopServing(); baseUrl = "http://127.0.0.1:11434"; }
    else await ensureServing(profile.model, Math.min(profile.contextCeiling, 8_192));

    const basic = await request(baseUrl, { model: profile.model, messages: [{ role: "user", content: "Reply with exactly: probe-ok" }], temperature: 0, max_tokens: 16 });
    if (!basic.ok) throw new Error(`backend probe failed: ${JSON.stringify(basic.json).slice(0, 300)}`);
    const structured = await request(baseUrl, {
      model: profile.model, messages: [{ role: "user", content: "Return JSON with ok=true." }], temperature: 0, max_tokens: 40,
      response_format: { type: "json_schema", json_schema: { name: "probe", strict: true, schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } } },
    });
    const tool = await request(baseUrl, {
      model: profile.model, messages: [{ role: "user", content: "Call the probe tool once." }], temperature: 0, max_tokens: 80,
      tools: [{ type: "function", function: { name: "probe", description: "Probe structured tool calling", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } }],
      tool_choice: "required",
    });
    const choices = tool.json.choices as { message?: { tool_calls?: unknown[] } }[] | undefined;
    const toolOk = tool.ok && !!choices?.[0]?.message?.tool_calls?.length;
    const usage = basic.json.usage as { completion_tokens?: number } | undefined;
    const capabilities: ModelCapability[] = ["chat", "research", "planning", "verification"];
    if (structured.ok) capabilities.push("structured_output");
    if (toolOk) capabilities.push("tools", "coding");
    const tokens = usage?.completion_tokens ?? 2;
    const verified: ModelProfile = {
      ...profile, capabilities, structuredOutput: structured.ok ? "json_schema" : "repair", backendCompatible: true,
      measuredTokensPerSecond: Math.round((tokens / Math.max(.001, basic.elapsed / 1_000)) * 10) / 10,
      probeStatus: "verified", probedAt: Date.now(), probeError: undefined,
    };
    upsertModelProfile(verified);
    return verified;
  } catch (e) {
    const failed: ModelProfile = { ...profile, backendCompatible: false, probeStatus: "failed", probedAt: Date.now(), probeError: (e as Error).message };
    upsertModelProfile(failed);
    return failed;
  }
}

export function selectModel(requirements: ModelCapability[], preferred?: string): ModelProfile | null {
  const eligible = discoverModelProfiles().filter((p) => p.probeStatus === "verified" && p.backendCompatible && requirements.every((c) => p.capabilities.includes(c)));
  if (preferred) {
    const exact = eligible.find((p) => p.id === preferred || p.model === preferred);
    if (exact) return exact;
  }
  return eligible.sort((a, b) => (b.measuredTokensPerSecond ?? 0) - (a.measuredTokensPerSecond ?? 0) || (a.memoryGb ?? 999) - (b.memoryGb ?? 999))[0] ?? null;
}

export async function ensureEligibleModel(requirements: ModelCapability[], preferred?: string): Promise<ModelProfile> {
  const selected = selectModel(requirements, preferred);
  if (selected) return selected;
  // New models are probed before receiving any role. Probe preferred first, then
  // discovered models in size order until one satisfies the role contract.
  const candidates = discoverModelProfiles().filter((p) => p.probeStatus !== "verified").sort((a, b) => (a.memoryGb ?? 999) - (b.memoryGb ?? 999));
  if (preferred) candidates.sort((a) => a.id === preferred || a.model === preferred ? -1 : 1);
  for (const candidate of candidates) {
    const probed = await probeModel(candidate.id);
    if (probed.probeStatus === "verified" && requirements.every((c) => probed.capabilities.includes(c))) return probed;
  }
  throw new Error(`no verified model satisfies capabilities: ${requirements.join(", ")}`);
}
