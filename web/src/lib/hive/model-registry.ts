import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { allModels, ensureServing, MODELS_DIR, readSettings, SERVE_PORT, servingLoraRequest, stopServing, type ServingLora } from "../lab";
import { recoverTextToolCalls } from "../toolloop";
import type { HiveSpecialistRole, ModelCapability, ModelProfile, SpecialistAdapter } from "./contracts";
import { evaluateSpecialistAdapterPromotion } from "./evaluation";
import { listModelProfiles, upsertModelProfile } from "./store";

export const SPECIALIST_MANIFEST_SUFFIX = ".hive-adapter.json";

function isSpecialistRole(value: unknown): value is HiveSpecialistRole {
  return ["coordinator_planner", "coder_repairer", "verifier"].includes(String(value));
}

function readSpecialistManifests(): SpecialistAdapter[] {
  const out: SpecialistAdapter[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(MODELS_DIR).filter((file) => file.endsWith(SPECIALIST_MANIFEST_SUFFIX)); } catch { return out; }
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, file), "utf8")) as Partial<SpecialistAdapter>;
      if (!raw.id || !isSpecialistRole(raw.role) || !raw.baseModel || !raw.baseVersionHash || !raw.adapterHash || !raw.adapterPath || !raw.adapterSize || !raw.adapterMtimeMs || !raw.trainingRunId || !raw.datasetManifestHash) continue;
      if (!["candidate", "promoted", "rejected"].includes(String(raw.promotionStatus)) || !raw.evaluation) continue;
      const adapterPath = path.resolve(raw.adapterPath);
      out.push({ ...raw, adapterPath } as SpecialistAdapter);
    } catch { /* malformed manifests never enter routing */ }
  }
  return out;
}

export function decideSpecialistPromotion(id: string, approved: boolean, evaluation: Partial<SpecialistAdapter["evaluation"]>): SpecialistAdapter {
  const entry = fs.readdirSync(MODELS_DIR).find((file) => {
    if (!file.endsWith(SPECIALIST_MANIFEST_SUFFIX)) return false;
    try { return JSON.parse(fs.readFileSync(path.join(MODELS_DIR, file), "utf8")).id === id; } catch { return false; }
  });
  if (!entry) throw new Error("specialist manifest not found");
  const manifestPath = path.join(MODELS_DIR, entry);
  const current = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as SpecialistAdapter;
  if (current.promotionStatus !== "candidate") throw new Error(`specialist is already ${current.promotionStatus}`);
  const nextEvaluation: SpecialistAdapter["evaluation"] = { ...current.evaluation, ...evaluation, evaluatedAt: evaluation.evaluatedAt || Date.now() };
  if (approved) {
    const gate = evaluateSpecialistAdapterPromotion(nextEvaluation);
    if (!gate.promotable) throw new Error(`specialist promotion gates failed: ${gate.gates.filter((item) => !item.passed).map((item) => item.code).join(", ")}`);
  }
  const updated: SpecialistAdapter = { ...current, evaluation: nextEvaluation, promotionStatus: approved ? "promoted" : "rejected" };
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(updated, null, 2) + "\n", { flag: "wx" });
  fs.renameSync(temporary, manifestPath);
  const old = listModelProfiles().find((profile) => profile.id === `adapter:${id}`);
  if (old) upsertModelProfile({ ...old, specialist: updated, ...(approved ? {} : { backendCompatible: false, probeStatus: "failed" as const, probeError: "specialist candidate was rejected" }) });
  return updated;
}

function modelVersionHash(modelPath: string): string {
  try {
    const stat = fs.statSync(modelPath);
    return crypto.createHash("sha256").update(`${modelPath}:${stat.size}:${stat.mtimeMs}`).digest("hex");
  } catch { return crypto.createHash("sha256").update(modelPath).digest("hex"); }
}

function contentHash(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function discoverModelProfiles(): ModelProfile[] {
  const stored = new Map(listModelProfiles().map((p) => [p.id, p]));
  const settings = readSettings();
  const models = allModels();
  for (const model of models) {
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
  for (const specialist of readSpecialistManifests()) {
    const base = models.find((model) => model.source === "local" && model.name === specialist.baseModel);
    if (!base) continue;
    const id = `adapter:${specialist.id}`;
    const old = stored.get(id);
    const compatibleBase = modelVersionHash(base.path) === specialist.baseVersionHash;
    const adapterExists = fs.existsSync(specialist.adapterPath);
    const adapterStat = adapterExists ? fs.statSync(specialist.adapterPath) : null;
    const adapterUnchanged = !!adapterStat && adapterStat.size === specialist.adapterSize && adapterStat.mtimeMs === specialist.adapterMtimeMs;
    const unchanged = old?.versionHash === specialist.adapterHash && old.specialist?.baseVersionHash === specialist.baseVersionHash;
    const profile: ModelProfile = unchanged ? { ...old, specialist } : {
      id, provider: "llama.cpp", model: specialist.baseModel, checkpoint: specialist.trainingRunId,
      adapter: specialist.adapterPath, versionHash: specialist.adapterHash, capabilities: [], structuredOutput: "none",
      contextCeiling: settings.options.num_ctx || 8_192, memoryGb: base.gb, backendCompatible: false, probeStatus: "discovered", specialist,
    };
    if (!compatibleBase || !adapterExists || !adapterUnchanged || specialist.promotionStatus === "rejected") {
      profile.backendCompatible = false;
      profile.probeStatus = "failed";
      profile.probeError = !compatibleBase ? "specialist base hash does not match the installed GGUF" : !adapterExists ? "specialist adapter file is missing" : !adapterUnchanged ? "specialist adapter bytes changed after registration" : "specialist candidate was rejected";
    }
    upsertModelProfile(profile);
    stored.set(id, profile);
  }
  const liveBaseIds = new Set(models.map((model) => `${model.source}:${model.name}`));
  return [...stored.values()].filter((profile) => liveBaseIds.has(profile.id) || (!!profile.specialist && fs.existsSync(profile.specialist.adapterPath)));
}

function adaptersForProfile(profile: ModelProfile): ServingLora[] {
  if (profile.provider !== "llama.cpp") return [];
  const peers = discoverModelProfiles()
    .filter((candidate) => candidate.specialist?.baseModel === profile.model)
    .filter((candidate) => candidate.specialist?.promotionStatus === "promoted" || candidate.id === profile.id)
    .filter((candidate) => candidate.specialist && fs.existsSync(candidate.specialist.adapterPath))
    .map((candidate) => ({ key: candidate.specialist!.id, path: candidate.specialist!.adapterPath }));
  return peers;
}

export async function prepareModelProfile(profile: ModelProfile, minCtx = 0): Promise<{ baseUrl: string; lora?: { id: number; scale: number }[]; loadMs: number }> {
  const started = Date.now();
  if (profile.provider === "ollama") {
    if (profile.specialist) throw new Error("specialist adapters require llama.cpp");
    if (/gemma/i.test(profile.model)) stopServing();
    return { baseUrl: "http://127.0.0.1:11434", loadMs: Date.now() - started };
  }
  await ensureServing(profile.model, minCtx, adaptersForProfile(profile));
  const lora = profile.specialist ? servingLoraRequest(profile.specialist.id) : servingLoraRequest();
  return { baseUrl: `http://127.0.0.1:${SERVE_PORT}`, ...(lora ? { lora } : {}), loadMs: Date.now() - started };
}

async function request(baseUrl: string, body: Record<string, unknown>, timeoutMs = 120_000, signal?: AbortSignal): Promise<{ ok: boolean; json: Record<string, unknown>; elapsed: number }> {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    const json = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { ok: response.ok, json, elapsed: Date.now() - started };
  } catch (e) { return { ok: false, json: { error: (e as Error).message }, elapsed: Date.now() - started }; }
}

export async function probeModel(profileId: string, signal?: AbortSignal): Promise<ModelProfile> {
  const profile = discoverModelProfiles().find((p) => p.id === profileId);
  if (!profile) throw new Error("model profile not found");
  if (profile.specialist?.promotionStatus === "rejected") throw new Error("rejected specialist adapters cannot be probed or routed");
  upsertModelProfile({ ...profile, probeStatus: "probing", probeError: undefined });
  try {
    if (profile.specialist && await contentHash(profile.specialist.adapterPath) !== profile.specialist.adapterHash) throw new Error("specialist adapter content hash does not match its immutable manifest");
    const prepared = await prepareModelProfile(profile, Math.min(profile.contextCeiling, 8_192));
    const baseUrl = prepared.baseUrl;
    const withAdapter = (body: Record<string, unknown>) => prepared.lora ? { ...body, lora: prepared.lora } : body;

    const basic = await request(baseUrl, withAdapter({ model: profile.model, messages: [{ role: "user", content: "Reply with exactly: probe-ok" }], temperature: 0, max_tokens: 16 }), 120_000, signal);
    if (!basic.ok) throw new Error(`backend probe failed: ${JSON.stringify(basic.json).slice(0, 300)}`);
    const structured = await request(baseUrl, withAdapter({
      model: profile.model, messages: [{ role: "user", content: "Return JSON with ok=true." }], temperature: 0, max_tokens: 40,
      response_format: { type: "json_schema", json_schema: { name: "probe", strict: true, schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } } },
    }), 120_000, signal);
    const tool = await request(baseUrl, withAdapter({
      // Reasoning-capable models may spend most of an 80-token allowance on
      // hidden thought before emitting an otherwise valid textual fallback call.
      // Keep this bounded but large enough to assess the capability honestly.
      model: profile.model, messages: [{ role: "user", content: 'Call the probe tool once with value "ok". If native function calls are unavailable, emit exactly <tool_call>{"name":"probe","arguments":{"value":"ok"}}</tool_call>.' }], temperature: 0, max_tokens: 192,
      tools: [{ type: "function", function: { name: "probe", description: "Probe structured tool calling", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } }],
      tool_choice: "required",
    }), 120_000, signal);
    const choices = tool.json.choices as { message?: { tool_calls?: unknown[]; content?: string; reasoning_content?: string } }[] | undefined;
    const message = choices?.[0]?.message;
    const textualCalls = recoverTextToolCalls(message?.content || "", message?.reasoning_content || "");
    const toolOk = tool.ok && (!!message?.tool_calls?.length || textualCalls.some((call) => call.name === "probe"));
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
    // Cancellation and a workflow deadline say nothing about a model's actual
    // capability.  Do not poison its persistent profile as "failed" merely
    // because an operator stopped a run or its budget expired.
    if (signal?.aborted) throw e;
    const failed: ModelProfile = { ...profile, backendCompatible: false, probeStatus: "failed", probedAt: Date.now(), probeError: (e as Error).message };
    upsertModelProfile(failed);
    return failed;
  }
}

function nameAffinity(profile: ModelProfile, roleId?: string): number {
  const name = `${profile.model} ${profile.checkpoint || ""} ${profile.adapter || ""}`.toLowerCase();
  const matches = (terms: RegExp) => terms.test(name) ? 1 : 0;
  if (roleId === "coder") return matches(/coder|code|swe|devin|openhands/) * 0.22;
  if (roleId === "researcher" || roleId === "query_generator" || roleId === "reader" || roleId === "synthesizer") return matches(/research|search|rag|reader|science/) * 0.22;
  if (roleId === "planner" || roleId === "comprehension") return matches(/plan|reason|instruct|think/) * 0.16;
  if (roleId === "verifier") return matches(/verify|judge|critic|math|reason/) * 0.18;
  return 0;
}

function specialistRole(roleId?: string): HiveSpecialistRole | null {
  if (["coordinator", "coordinator_planner", "planner", "comprehension"].includes(String(roleId))) return "coordinator_planner";
  if (["coder", "coder_repairer"].includes(String(roleId))) return "coder_repairer";
  if (roleId === "verifier") return "verifier";
  return null;
}

/**
 * Choose the smallest good specialist for one role. Explicit preferences remain
 * hard contracts; automatic routing combines persisted eval quality, adapter /
 * checkpoint affinity, throughput, and a small warm-model bonus to avoid a swap
 * that is not justified by expected quality.
 */
export function rankEligibleModels(profiles: ModelProfile[], requirements: ModelCapability[], preferred?: string, roleId?: string, loadedModel?: string): ModelProfile[] {
  const wantedSpecialist = specialistRole(roleId);
  const eligible = profiles.filter((p) => p.probeStatus === "verified" && p.backendCompatible && requirements.every((c) => p.capabilities.includes(c)))
    .filter((profile) => !profile.specialist || (!!preferred || (profile.specialist.promotionStatus === "promoted" && profile.specialist.role === wantedSpecialist)));
  if (preferred) {
    const exact = eligible.find((p) => p.id === preferred || p.model === preferred);
    return exact ? [exact, ...eligible.filter((profile) => profile !== exact)] : [];
  }
  const utility = (profile: ModelProfile) => {
    const outcome = roleId ? profile.roleScores?.[roleId] : undefined;
    // One successful sample is informative but not strong enough to lock in a
    // model; confidence grows smoothly and remains below a measured suite score.
    const quality = outcome ? outcome.score * Math.min(1, outcome.samples / 8) : 0;
    const speed = Math.min(0.12, (profile.measuredTokensPerSecond ?? 0) / 1_000);
    // Swaps on this box are not just slow (1-3 min reload) — a gemma→llama.cpp
    // handoff wedged the GPU mid-mission (amdgpu ring reset, 2026-07-11). Staying
    // on the already-loaded model needs to beat everything except a real,
    // measured quality gap, so the warm bonus outweighs speed + name affinity.
    const warm = loadedModel === profile.model || loadedModel === profile.id ? 0.2 : 0;
    const sizePenalty = Math.min(0.06, (profile.memoryGb ?? 0) / 250);
    const roleAdapter = profile.specialist?.role === wantedSpecialist ? 0.35 : 0;
    return quality + roleAdapter + nameAffinity(profile, roleId) + speed + warm - sizePenalty;
  };
  return [...eligible].sort((a, b) => utility(b) - utility(a) || (b.measuredTokensPerSecond ?? 0) - (a.measuredTokensPerSecond ?? 0) || (a.memoryGb ?? 999) - (b.memoryGb ?? 999));
}

export function selectModel(requirements: ModelCapability[], preferred?: string, roleId?: string, loadedModel?: string): ModelProfile | null {
  return rankEligibleModels(discoverModelProfiles(), requirements, preferred, roleId, loadedModel)[0] ?? null;
}

export async function ensureEligibleModel(requirements: ModelCapability[], preferred?: string, signal?: AbortSignal, roleId?: string, loadedModel?: string): Promise<ModelProfile> {
  // A user/role explicitly selecting a model is an experiment contract, not a
  // hint.  The old code selected any already-verified model before probing the
  // requested one, so a Hive trace labelled Gemma could actually be Victory.
  // Probe and require the exact selection first; that gives role comparisons an
  // honest baseline and a useful incompatibility error when one is warranted.
  if (preferred) {
    const requested = discoverModelProfiles().find((p) => p.id === preferred || p.model === preferred);
    if (!requested) throw new Error(`preferred model not found: ${preferred}`);
    const profile = requested.probeStatus === "verified" ? requested : await probeModel(requested.id, signal);
    if (profile.probeStatus === "verified" && profile.backendCompatible && requirements.every((c) => profile.capabilities.includes(c))) return profile;
    const missing = requirements.filter((capability) => !profile.capabilities.includes(capability));
    throw new Error(`preferred model ${preferred} is not eligible (${profile.probeError || `missing capabilities: ${missing.join(", ")}`})`);
  }
  const selected = selectModel(requirements, preferred, roleId, loadedModel);
  if (selected) return selected;
  // New models are probed before receiving any role. Probe preferred first, then
  // discovered models in size order until one satisfies the role contract.
  const candidates = discoverModelProfiles().filter((p) => p.probeStatus !== "verified" && (!p.specialist || p.specialist.promotionStatus === "promoted")).sort((a, b) => (a.memoryGb ?? 999) - (b.memoryGb ?? 999));
  for (const candidate of candidates) {
    const probed = await probeModel(candidate.id, signal);
    if (probed.probeStatus === "verified" && requirements.every((c) => probed.capabilities.includes(c))) return probed;
  }
  throw new Error(`no verified model satisfies capabilities: ${requirements.join(", ")}`);
}

export function recordRoleOutcome(profileId: string, roleId: string, score: number): ModelProfile | null {
  const profile = discoverModelProfiles().find((candidate) => candidate.id === profileId);
  if (!profile || !Number.isFinite(score)) return null;
  const previous = profile.roleScores?.[roleId];
  const samples = (previous?.samples ?? 0) + 1;
  // A running mean keeps routing stable and makes every verified Hive outcome a
  // tiny local benchmark, without collecting prompts or user data.
  const bounded = Math.max(0, Math.min(1, score));
  const next = ((previous?.score ?? 0) * (samples - 1) + bounded) / samples;
  const updated: ModelProfile = { ...profile, roleScores: { ...profile.roleScores, [roleId]: { score: Math.round(next * 10_000) / 10_000, samples, updatedAt: Date.now() } } };
  upsertModelProfile(updated);
  return updated;
}
