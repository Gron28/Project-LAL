// Local AI Lab backend: model discovery, llama.cpp/Vulkan serving, file storage.
// Independent of Ollama's daemon (reuses its GGUF files read-only).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, ChildProcess, execSync } from "node:child_process";
import { gradeItem, stripThink, type BenchItem } from "./graders";
import { resolvePlatformDirectories } from "./host-profile";
import { ContextProfileStore, contextCandidates, contextHardwareFingerprint, makeContextProfile, readGgufContextLength } from "./context-profile";
import type { ContextProfile } from "@project-lal/protocol";
export type { BenchItem } from "./graders";
export type ModelRuntimeSettings = {
  contextTokens: number;
  maxOutputTokens: number;
  gpuLayers: number | null;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  thinking: boolean;
  updatedAt: string | null;
};

const ROOT = path.resolve(process.cwd(), "..");
export const MODELS_DIR = path.join(ROOT, "models");
/** Legacy checkout models remain readable during migration. New verified imports
 * live in the external owner-data root and are discovered by every existing
 * chat/code/HIVE selector through this one function. */
export function modelDirectories(): string[] {
  return [...new Set([MODELS_DIR, path.join(resolvePlatformDirectories().data, "models")])];
}
export type ModelScanRoot = {
  kind: "gguf" | "ollama";
  path: string;
  exists: boolean;
  readable: boolean;
  detail?: string;
};

/** Human-readable discovery facts for the Models UI. Discovery remains
 * read-only: a missing owner-data directory is a valid empty state, while a
 * present-but-unreadable directory is surfaced as a failure instead of being
 * silently converted to "0 models". */
export function modelScanRoots(): ModelScanRoot[] {
  const roots: ModelScanRoot[] = modelDirectories().map((directory) => {
    const exists = fs.existsSync(directory);
    if (!exists) return { kind: "gguf", path: directory, exists: false, readable: true };
    try { fs.accessSync(directory, fs.constants.R_OK); return { kind: "gguf", path: directory, exists: true, readable: true }; }
    catch (error) { return { kind: "gguf", path: directory, exists: true, readable: false, detail: error instanceof Error ? error.message : String(error) }; }
  });
  const exists = fs.existsSync(OLLAMA_STORE);
  if (!exists) roots.push({ kind: "ollama", path: OLLAMA_STORE, exists: false, readable: true });
  else {
    try { fs.accessSync(OLLAMA_STORE, fs.constants.R_OK); roots.push({ kind: "ollama", path: OLLAMA_STORE, exists: true, readable: true }); }
    catch (error) { roots.push({ kind: "ollama", path: OLLAMA_STORE, exists: true, readable: false, detail: error instanceof Error ? error.message : String(error) }); }
  }
  return roots;
}
const LLAMA_DIR = path.join(ROOT, "llama", "llama-b9835");
const LLAMA_SERVER = path.join(LLAMA_DIR, "llama-server");
const OLLAMA_STORE = "/usr/share/ollama/.ollama/models";
const DATA = path.join(process.cwd(), ".data");
const CONVOS_DIR = path.join(DATA, "conversations");
const EXPERIMENTS_DIR = path.join(DATA, "experiments");
const SETTINGS_FILE = path.join(DATA, "settings.json");
export const SERVE_PORT = 8099;
export function localRuntimeAvailability() {
  return {
    llamaServer: fs.existsSync(LLAMA_SERVER) ? "available" as const : "missing" as const,
    ollamaStore: fs.existsSync(OLLAMA_STORE) ? "available" as const : "missing" as const,
  };
}

// Training env vars — defaults target this project's dev box (AMD RDNA2 on Linux via
// ROCm/HIP). HSA_* vars are ROCm-specific and are simply ignored by CUDA/CPU torch, so
// this is safe to leave as-is on other setups; override any of it per-environment (e.g.
// a different AMD generation, or unset entirely on NVIDIA/CPU) without touching the code:
//   GPU_TRAIN_ENV='{"HSA_OVERRIDE_GFX_VERSION":"11.0.0"}' — JSON, merged over the default.
function gpuTrainEnv(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    HSA_OVERRIDE_GFX_VERSION: process.env.HSA_OVERRIDE_GFX_VERSION ?? "10.3.0",
    HSA_ENABLE_SDMA: process.env.HSA_ENABLE_SDMA ?? "0",
    PYTORCH_HIP_ALLOC_CONF: process.env.PYTORCH_HIP_ALLOC_CONF ?? "expandable_segments:True",
  };
  if (process.env.GPU_TRAIN_ENV) {
    try { Object.assign(base, JSON.parse(process.env.GPU_TRAIN_ENV)); } catch {}
  }
  return base;
}
fs.mkdirSync(CONVOS_DIR, { recursive: true });
fs.mkdirSync(EXPERIMENTS_DIR, { recursive: true });

export type Options = {
  num_ctx: number; num_predict: number; num_gpu: number | null;
  temperature: number; top_p: number; top_k: number; repeat_penalty: number;
};
export const DEFAULT_OPTIONS: Options = {
  num_ctx: 8192, num_predict: -1, num_gpu: null,
  temperature: 0.6, top_p: 0.9, top_k: 40, repeat_penalty: 1.1,
};
type SettingsFile = {
  model?: string;
  options?: Partial<Options>;
  modelSettings?: Record<string, Partial<ModelRuntimeSettings>>;
  system?: string;
  web?: boolean;
  groundDocs?: boolean;
  serveIdleMinutes?: number;
};
const CONTEXT_PROFILES_FILE = path.join(DATA, "context-profiles.json");
const contextProfiles = new ContextProfileStore(CONTEXT_PROFILES_FILE);

// serveIdleMinutes: llama-server auto-unloads after this long with no model use
// and no live run (0 = never). Before this existed, the singleton stayed GPU-
// resident forever after any chat — a constant idle power drain on the card.
const DEFAULT_SERVE_IDLE_MINUTES = 10;

export function readSettings() {
  let s: SettingsFile = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch {}
  const models = publicModels();
  const model = s.model && models.find((m) => m.name === s.model) ? s.model! : models[0]?.name ?? "";
  return {
    model, options: { ...DEFAULT_OPTIONS, ...(s.options || {}) }, modelSettings: s.modelSettings ?? {}, system: s.system ?? "", web: !!s.web, groundDocs: !!s.groundDocs,
    serveIdleMinutes: typeof s.serveIdleMinutes === "number" ? s.serveIdleMinutes : DEFAULT_SERVE_IDLE_MINUTES,
  };
}
export function writeSettings(patch: SettingsFile) {
  let s: SettingsFile = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch {}
  if (patch.model !== undefined) s.model = patch.model;
  if (patch.system !== undefined) s.system = patch.system;
  if (patch.web !== undefined) s.web = patch.web;
  if (patch.groundDocs !== undefined) s.groundDocs = patch.groundDocs;
  if (patch.serveIdleMinutes !== undefined) s.serveIdleMinutes = patch.serveIdleMinutes;
  if (patch.options) s.options = { ...(s.options || {}), ...patch.options };
  if (patch.modelSettings) {
    s.modelSettings = { ...(s.modelSettings || {}) };
    for (const [model, values] of Object.entries(patch.modelSettings)) {
      s.modelSettings[model] = { ...(s.modelSettings[model] || {}), ...values };
    }
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  return s;
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

/** The one durable per-model policy read by Web, CLI, and the runtime gateway. */
export function modelRuntimeSettings(model: string): ModelRuntimeSettings {
  const settings = readSettings();
  const saved = settings.modelSettings[model] ?? {};
  const nativeMaximum = nativeContextLimit(model);
  const info = publicModels().find((item) => item.name === model);
  const safeUnsavedDefault = info?.source === "local" ? Math.min(32_768, nativeMaximum ?? 32_768) : OLLAMA_CLI_CONTEXT;
  const fallbackContext = Math.max(safeUnsavedDefault, settings.options.num_ctx || DEFAULT_OPTIONS.num_ctx);
  const contextMaximum = nativeMaximum ?? 1_048_576;
  return {
    contextTokens: Math.round(finiteNumber(saved.contextTokens, fallbackContext, 2_048, contextMaximum)),
    maxOutputTokens: Math.round(finiteNumber(saved.maxOutputTokens, settings.options.num_predict, -1, 262_144)),
    gpuLayers: saved.gpuLayers === null ? null : Math.round(finiteNumber(saved.gpuLayers, settings.options.num_gpu ?? 99, 0, 999)),
    temperature: finiteNumber(saved.temperature, settings.options.temperature, 0, 2),
    topP: finiteNumber(saved.topP, settings.options.top_p, 0, 1),
    topK: Math.round(finiteNumber(saved.topK, settings.options.top_k, 0, 10_000)),
    repeatPenalty: finiteNumber(saved.repeatPenalty, settings.options.repeat_penalty, 0, 2),
    thinking: typeof saved.thinking === "boolean" ? saved.thinking : true,
    updatedAt: typeof saved.updatedAt === "string" ? saved.updatedAt : null,
  };
}

export function writeModelRuntimeSettings(model: string, patch: Partial<ModelRuntimeSettings>): ModelRuntimeSettings {
  if (!publicModels().some((item) => item.name === model)) throw new Error(`unknown model: ${model}`);
  const current = modelRuntimeSettings(model);
  const nativeMaximum = nativeContextLimit(model) ?? 1_048_576;
  const next: ModelRuntimeSettings = {
    contextTokens: Math.round(finiteNumber(patch.contextTokens, current.contextTokens, 2_048, nativeMaximum)),
    maxOutputTokens: Math.round(finiteNumber(patch.maxOutputTokens, current.maxOutputTokens, -1, 262_144)),
    gpuLayers: patch.gpuLayers === null ? null : patch.gpuLayers === undefined ? current.gpuLayers : Math.round(finiteNumber(patch.gpuLayers, current.gpuLayers ?? 99, 0, 999)),
    temperature: finiteNumber(patch.temperature, current.temperature, 0, 2),
    topP: finiteNumber(patch.topP, current.topP, 0, 1),
    topK: Math.round(finiteNumber(patch.topK, current.topK, 0, 10_000)),
    repeatPenalty: finiteNumber(patch.repeatPenalty, current.repeatPenalty, 0, 2),
    thinking: typeof patch.thinking === "boolean" ? patch.thinking : current.thinking,
    updatedAt: new Date().toISOString(),
  };
  writeSettings({ modelSettings: { [model]: next } });
  return next;
}

export function allModelRuntimeSettings(): Record<string, ModelRuntimeSettings> {
  return Object.fromEntries(publicModels().map((model) => [model.name, modelRuntimeSettings(model.name)]));
}

export function modelSettingsRevision(): string {
  const settings = readSettings();
  return crypto.createHash("sha256").update(JSON.stringify({ model: settings.model, models: allModelRuntimeSettings() })).digest("hex").slice(0, 16);
}

// A local model is one or both of <name>-q4.gguf / <name>-f16.gguf. q4 is preferred
// everywhere (serving, benching): an 8B f16 is 16GB and spills the 8GB card, while
// its q4 fits VRAM entirely. The f16 is kept as the requantization source.
const GGUF_SUFFIXES = ["-q4.gguf", "-f16.gguf"] as const;
export function modelFile(name: string): string | null {
  for (const directory of modelDirectories()) for (const suf of GGUF_SUFFIXES) {
    const p = path.join(directory, name + suf); if (fs.existsSync(p)) return p;
  }
  return null;
}
export function deleteModel(name: string, source: "local" | "ollama" = "local") {
  if (source === "ollama") {
    if (servingModel() === name) stopServing();
    try { execSync(`ollama rm ${JSON.stringify(name)}`, { stdio: "ignore" }); } catch {}
    return;
  }
  if (servingModel() === name) stopServing();
  for (const directory of modelDirectories()) for (const suf of GGUF_SUFFIXES) try { fs.unlinkSync(path.join(directory, name + suf)); } catch {}
}
export function renameModel(oldName: string, newName: string): { ok: boolean; error?: string } {
  const clean = newName.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!clean) return { ok: false, error: "invalid name" };
  const pairs = modelDirectories().flatMap((directory) => GGUF_SUFFIXES
    .map((suf) => ({ src: path.join(directory, oldName + suf), dst: path.join(directory, clean + suf) }))
    .filter((p) => fs.existsSync(p.src)));
  if (!pairs.length) return { ok: false, error: "model not found" };
  if (pairs.some((p) => fs.existsSync(p.dst))) return { ok: false, error: "name already taken" };
  if (servingModel() === oldName) stopServing();
  try {
    for (const p of pairs) fs.renameSync(p.src, p.dst);
    const s = readSettings();
    if (s.model === oldName) writeSettings({ model: clean });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type ModelInfo = { name: string; source: "local" | "ollama"; path: string; gb: number };
export const MANAGED_MODEL_PROFILE_SUFFIX = "-lal-cli-16k";
export const OLLAMA_CLI_CONTEXT = 16384;
export function isPublicModelName(name: string): boolean {
  return !name.endsWith(MANAGED_MODEL_PROFILE_SUFFIX);
}
export function publicModels(): ModelInfo[] {
  return allModels().filter((model) => isPublicModelName(model.name));
}
function preferredRuntimeBackend(model: ModelInfo | undefined): "ollama" | "llama.cpp" {
  return model?.source === "ollama" && /gemma/i.test(model.name) ? "ollama" : "llama.cpp";
}
export type ServingLora = { key: string; path: string };
export type LoraRequest = { id: number; scale: number }[];
export function allModels(): ModelInfo[] {
  const out: ModelInfo[] = [];
  try {
    const seen = new Set<string>();
    for (const directory of modelDirectories()) {
      let files: string[] = []; try { files = fs.readdirSync(directory); } catch { continue; }
      for (const suf of GGUF_SUFFIXES)               // q4 first — it wins when both exist
      for (const f of files)
        if (f.endsWith(suf)) {
          const name = f.slice(0, -suf.length);
          if (seen.has(name)) continue;
          seen.add(name);
          const p = path.join(directory, f);
          out.push({ name, source: "local", path: p, gb: +(fs.statSync(p).size / 1e9).toFixed(1) });
        }
    }
  } catch {}
  const base = path.join(OLLAMA_STORE, "manifests");
  const walk = (d: string) => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try {
        const man = JSON.parse(fs.readFileSync(p, "utf8"));
        const rel = path.relative(base, p).split(path.sep);
        const name = rel.slice(-2).join(":");
        for (const l of man.layers || [])
          if (String(l.mediaType).includes("model")) {
            const blob = path.join(OLLAMA_STORE, "blobs", String(l.digest).replace(":", "-"));
            if (fs.existsSync(blob)) out.push({ name, source: "ollama", path: blob, gb: +((l.size || 0) / 1e9).toFixed(1) });
          }
      } catch {}
    }
  };
  walk(base);
  return out;
}

// ---- llama-server singleton (persists across requests in one Node process) ----
type Srv = { proc: ChildProcess | null; model: string | null; ollamaModel: string | null; ollamaCtx?: number; ollamaOffload?: string | null; lastUsedAt?: number; loras: ServingLora[]; ctx: number; offload?: string | null };
const g = globalThis as unknown as { __lab_srv?: Srv; __lab_idle_reaper?: ReturnType<typeof setInterval> };
if (!g.__lab_srv) g.__lab_srv = { proc: null, model: null, ollamaModel: null, loras: [], ctx: 0 };
const srv = g.__lab_srv;
if (!Array.isArray(srv.loras)) srv.loras = [];
if (!Number.isFinite(srv.ctx)) srv.ctx = 0;

async function health(): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${SERVE_PORT}/health`)).ok; } catch { return false; }
}
export function servingModel() { return srv.model ?? srv.ollamaModel; }
export function stopServing() {
  try { srv.proc?.kill("SIGKILL"); } catch {}
  try { execSync(`pkill -9 -f "llama-server.*--port ${SERVE_PORT}"`); } catch {}
  srv.proc = null; srv.model = null; srv.loras = []; srv.ctx = 0; srv.offload = null;
}

export function markOllamaServing(model: string, context: number, offload: string | null) {
  srv.ollamaModel = model;
  srv.ollamaCtx = context;
  srv.ollamaOffload = offload;
  touchServing();
}

export function clearOllamaServing() {
  srv.ollamaModel = null;
  srv.ollamaCtx = undefined;
  srv.ollamaOffload = null;
}

// llama.cpp assigns adapter ids in command-line order. Supplying the complete
// scale vector per request avoids global /lora-adapters state leaking between a
// Hive specialist and an unrelated chat request using the same resident base.
export function servingLoraRequest(activeKey?: string): LoraRequest | undefined {
  if (!srv.loras.length) return undefined;
  if (activeKey && !srv.loras.some((adapter) => adapter.key === activeKey)) throw new Error(`LoRA adapter is not loaded: ${activeKey}`);
  return srv.loras.map((adapter, id) => ({ id, scale: activeKey === adapter.key ? 1 : 0 }));
}

// ---- GPU idle policy ----
// Mark the serving model as "in use right now". Called by ensureServing, per bench
// item, and by the run manager on every run event — so the idle clock only counts
// genuinely quiet time, not time spent generating.
export function touchServing() { srv.lastUsedAt = Date.now(); }

// The run manager registers a hold here ("a run is live") without lab.ts importing
// runs.ts — that import would be circular (runs.ts already imports lab.ts).
let idleHold: (() => boolean) | null = null;
export function setIdleHold(fn: () => boolean) { idleHold = fn; }
// Same cycle-avoidance, other direction: lets agent tools ask "is any run live?"
// without importing runs.ts into a module lab.ts already imports.
export function runsAreLive(): boolean { return idleHold?.() ?? false; }

export function servingInfo(): { model: string | null; idleSec: number | null; idleLimitMin: number; loras: string[] } {
  const idleLimitMin = readSettings().serveIdleMinutes;
  const model = servingModel();
  return {
    model,
    idleSec: model && srv.lastUsedAt ? Math.round((Date.now() - srv.lastUsedAt) / 1000) : null,
    idleLimitMin, loras: srv.loras.map((adapter) => adapter.key),
  };
}

// Read-only lifecycle snapshot for the host status API.  This deliberately
// exposes what this Node process actually owns without claiming ownership of a
// matching process discovered elsewhere on the machine.
export function servingRuntimeStatus() {
  return {
    pid: srv.proc?.pid ?? null,
    alive: (!!srv.proc && srv.proc.exitCode === null) || !!srv.ollamaModel,
    model: servingModel(),
    context: srv.model ? srv.ctx || null : srv.ollamaCtx ?? null,
    backend: srv.model ? "llama.cpp" : srv.ollamaModel ? "ollama" : null,
    gpuOffload: srv.model ? srv.offload ?? null : srv.ollamaOffload ?? null,
    loras: srv.loras.map((adapter) => adapter.key),
    lastUsedAt: srv.lastUsedAt ?? null,
    logPath: path.join(ROOT, "out", "llama-server.log"),
  };
}

// Idle reaper: unload llama-server after serveIdleMinutes of genuine quiet — no
// run live, nothing training, nothing recently served. The GPU should idle cold,
// not with a model parked on it drawing power for nobody.
if (!g.__lab_idle_reaper) {
  g.__lab_idle_reaper = setInterval(() => {
    try {
      if (!srv.proc || srv.proc.exitCode !== null) return;
      const idleMin = readSettings().serveIdleMinutes;
      if (!idleMin || idleMin <= 0) return;
      if (train.running) return;
      if (idleHold?.()) return;
      const last = srv.lastUsedAt ?? Date.now();
      if (Date.now() - last >= idleMin * 60e3) stopServing();
    } catch { /* never let the reaper crash the process */ }
  }, 60e3);
  g.__lab_idle_reaper.unref?.();
}

// Ollama keeps its last-used model resident (VRAM/RAM) after a request returns —
// unrelated to our own llama-server singleton. If we then spin up llama-server for a
// local GGUF on top, both sit in memory at once and can OOM the whole machine (15GB
// RAM box). keep_alive:0 tells ollama to unload immediately.
async function stopOllama(model: string): Promise<void> {
  try {
    await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
      // An active Ollama decode can otherwise hold a Hive stage forever before
      // the local GGUF fallback is even attempted.  Unloading is best effort;
      // bounded progress is more important than waiting for an idle backend.
      signal: AbortSignal.timeout(5_000),
    });
  } catch {}
}

// Unload EVERYTHING Ollama has resident, not just what we served through it —
// scripts (distillation, etc.) hit Ollama directly, so srv.ollamaModel can be null
// while a 12B teacher still sits in memory. Training on top of that OOMs the box.
async function unloadOllamaAll(): Promise<void> {
  try {
    const r = await fetch("http://127.0.0.1:11434/api/ps", { signal: AbortSignal.timeout(5_000) });
    const loaded: { models?: { name: string }[] } = await r.json();
    for (const m of loaded.models || []) await stopOllama(m.name);
  } catch {}
}

// Emergency-stop companion to stopServing().  A local agent may be decoding via
// either backend: llama-server for GGUFs or Ollama for Gemma/vision.  Releasing
// only llama-server made the old "stop all" look successful while an Ollama job
// could remain resident (and occasionally keep the GPU busy).  This intentionally
// affects only model processes owned by the Lab, never arbitrary GPU processes.
export async function stopAllServing(): Promise<void> {
  stopServing();
  await unloadOllamaAll();
  clearOllamaServing();
}

export type ActivatedModelRuntime = {
  model: string;
  runtimeProfile: string;
  backend: "ollama" | "llama.cpp";
  context: number;
  gpuOffload: string;
  contextProfile: ContextProfile;
};

function contextIdentity(model: string, backend: "ollama" | "llama.cpp"): string {
  const info = publicModels().find((item) => item.name === model);
  let artifact = `${info?.path ?? model}:unknown`;
  try {
    const stat = info ? fs.statSync(info.path) : null;
    if (stat) artifact = `${info!.path}:${stat.size}:${stat.mtimeMs}`;
  } catch {}
  let runtime: string = backend;
  if (backend === "llama.cpp") {
    try { const stat = fs.statSync(LLAMA_SERVER); runtime = `${backend}:${stat.size}:${stat.mtimeMs}`; } catch {}
  }
  return crypto.createHash("sha256").update(`${artifact}\n${contextHardwareFingerprint(runtime)}`).digest("hex");
}

const nativeContextCache = new Map<string, number | null>();
function nativeContextLimit(model: string): number | null {
  const info = publicModels().find((item) => item.name === model);
  if (!info || preferredRuntimeBackend(info) === "ollama") return null;
  try {
    const stat = fs.statSync(info.path), key = `${info.path}:${stat.size}:${stat.mtimeMs}`;
    if (nativeContextCache.has(key)) return nativeContextCache.get(key) ?? null;
    const value = readGgufContextLength(info.path);
    nativeContextCache.set(key, value);
    return value;
  } catch { return null; }
}

export function contextProfileForModel(model: string): ContextProfile {
  const info = publicModels().find((item) => item.name === model);
  const backend = preferredRuntimeBackend(info);
  const fingerprint = contextIdentity(model, backend);
  const cached = contextProfiles.get(fingerprint);
  const runtime = servingRuntimeStatus();
  const active = runtime.alive && runtime.model === model && runtime.backend === backend ? runtime.context : null;
  const maximum = nativeContextLimit(model);
  const requested = Math.min(modelRuntimeSettings(model).contextTokens, maximum ?? Number.POSITIVE_INFINITY);
  if (cached) {
    const verified = cached.verifiedTokens;
    return {
    ...cached, modelMaxTokens: maximum ?? cached.modelMaxTokens, requestedTokens: requested,
    // Verification is durable, residency is not. Never present the last
    // successful allocation/offload as active after the backend was unloaded.
    activeTokens: active,
    gpuOffload: active ? runtime.gpuOffload : null,
    verification: active
      ? active >= requested ? "verified" : "degraded"
      : verified != null && verified >= requested ? "verified" : "planned",
    source: active ? "runtime" : "cache",
    ...(verified != null && verified < requested
      ? { reason: `requested ${requested} tokens; highest verified allocation is ${verified}` }
      : {}),
  };
  }
  return makeContextProfile({ model, backend, modelMaxTokens: maximum, requestedTokens: requested, activeTokens: active, fingerprint, source: active ? "runtime" : "fallback", gpuOffload: active ? runtime.gpuOffload : null });
}

export function resolvedContextTarget(model: string, minimum = 0): number {
  const profile = contextProfileForModel(model);
  const requested = Math.max(minimum, profile.requestedTokens);
  return profile.modelMaxTokens ? Math.min(requested, profile.modelMaxTokens) : requested;
}

function recordVerifiedContext(model: string, backend: "ollama" | "llama.cpp", requested: number, active: number, offload: string): ContextProfile {
  const previous = contextProfileForModel(model);
  const profile = makeContextProfile({
    model, backend, modelMaxTokens: previous.modelMaxTokens,
    requestedTokens: requested, activeTokens: active, verifiedTokens: Math.max(previous.verifiedTokens ?? 0, active),
    fingerprint: contextIdentity(model, backend), source: "runtime", gpuOffload: offload,
    ...(active < requested ? { reason: `backend allocated ${active} of ${requested} requested tokens` } : {}),
  });
  contextProfiles.put(profile);
  return profile;
}

export function managedOllamaModel(model: string): string {
  const candidate = `${model}${MANAGED_MODEL_PROFILE_SUFFIX}`;
  if (model.toLowerCase().includes("gemma")) {
    if (!allModels().some((item) => item.name === candidate)) {
      throw new Error(`managed 16K profile is missing for ${model}; run update-all.sh`);
    }
    return candidate;
  }
  return model;
}

export async function verifyOllamaRuntime(model: string, requestedContext = OLLAMA_CLI_CONTEXT): Promise<{ context: number; offload: string }> {
  const loaded = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: "10m", options: { num_ctx: requestedContext, num_predict: 1 } }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!loaded.ok) throw new Error(`Ollama failed to load ${model}: HTTP ${loaded.status}`);
  const ps = await fetch("http://127.0.0.1:11434/api/ps", { signal: AbortSignal.timeout(10_000) });
  if (!ps.ok) throw new Error(`Ollama runtime verification failed: HTTP ${ps.status}`);
  const body = await ps.json() as { models?: Array<{ name?: string; context_length?: number; size?: number; size_vram?: number }> };
  const runtime = body.models?.find((item) => item.name === model || item.name?.startsWith(`${model}:`));
  if (!runtime) throw new Error(`Ollama reported a successful load but ${model} is not resident`);
  const context = runtime.context_length ?? 0;
  if (model.endsWith(MANAGED_MODEL_PROFILE_SUFFIX) && context < OLLAMA_CLI_CONTEXT) {
    throw new Error(`Ollama loaded ${model} with ${context || "unknown"} context, expected at least ${OLLAMA_CLI_CONTEXT}`);
  }
  const size = runtime.size ?? 0;
  const sizeVram = runtime.size_vram ?? 0;
  const offload = sizeVram > 0 ? `gpu:${Math.round((sizeVram / Math.max(1, size)) * 100)}%` : "cpu";
  return { context: context || OLLAMA_CLI_CONTEXT, offload };
}

/** Single-GPU model handoff used by both settings switches and inference. */
export async function activatePublicModel(model: string, minContext = 0): Promise<ActivatedModelRuntime> {
  const info = publicModels().find((item) => item.name === model);
  if (!info) throw new Error(`unknown or internal model: ${model}`);
  const current = servingRuntimeStatus();
  const expectedBackend = preferredRuntimeBackend(info);
  // Gemma is exposed by its public name but deliberately runs through the
  // visible managed 16K Ollama profile. Do not compare that profile against
  // the generic 32K llama.cpp request or it will be unloaded on every turn.
  const requiredContext = expectedBackend === "ollama" ? resolvedContextTarget(model, Math.max(OLLAMA_CLI_CONTEXT, minContext)) : resolvedContextTarget(model, minContext);
  const canReuseCurrent =
    current.alive &&
    current.model === model &&
    current.backend === expectedBackend &&
    (current.context ?? 0) >= requiredContext;
  if (!canReuseCurrent) {
    await stopAllServing();
  }

  if (expectedBackend === "ollama") {
    // llama.cpp and Ollama share one GPU. Ensure the old local process is gone
    // before asking Ollama to make the requested profile resident.
    if (servingRuntimeStatus().backend === "llama.cpp") await stopAllServing();
    const runtimeProfile = managedOllamaModel(model);
    const verified = await verifyOllamaRuntime(runtimeProfile, requiredContext);
    if (verified.context < requiredContext) {
      throw new Error(`Ollama loaded ${model} with ${verified.context} context, expected at least ${requiredContext}`);
    }
    markOllamaServing(model, verified.context, verified.offload);
    const contextProfile = recordVerifiedContext(model, "ollama", requiredContext, verified.context, verified.offload);
    return { model, runtimeProfile, backend: "ollama", context: verified.context, gpuOffload: verified.offload, contextProfile };
  }

  await ensureServing(model, requiredContext);
  const verified = servingRuntimeStatus();
  if (!verified.alive || verified.model !== model || verified.backend !== "llama.cpp") {
    throw new Error(`llama.cpp reported ready without the requested model ${model}`);
  }
  if ((verified.context ?? 0) < requiredContext) {
    throw new Error(`llama.cpp loaded ${model} with ${verified.context ?? "unknown"} context, expected at least ${requiredContext}`);
  }
  if (!verified.gpuOffload) throw new Error(`llama.cpp did not report GPU/offload state for ${model}`);
  const contextProfile = recordVerifiedContext(model, "llama.cpp", requiredContext, verified.context!, verified.gpuOffload);
  return { model, runtimeProfile: model, backend: "llama.cpp", context: verified.context!, gpuOffload: verified.gpuOffload, contextProfile };
}

/** Explicit, disruptive optimization pass used by the Models UI. */
export async function probePublicModelContext(model: string, emit?: (profile: ContextProfile) => void): Promise<ContextProfile> {
  const initial = contextProfileForModel(model);
  const candidates = contextCandidates(initial.modelMaxTokens);
  const ascending = candidates.filter((value) => value >= 32_768).sort((a, b) => a - b);
  const fallbacks = candidates.filter((value) => value < 32_768).sort((a, b) => b - a);
  let best: ContextProfile | null = null;
  const probe = async (candidate: number): Promise<boolean> => {
    emit?.({ ...initial, requestedTokens: candidate, verification: "probing", reason: undefined });
    try {
      await stopAllServing();
      // Passing the candidate bypasses no limit: activatePublicModel clamps to
      // native metadata and verifies the backend-reported allocation.
      const runtime = await activatePublicModel(model, candidate);
      const smoke = await fetch(runtime.backend === "ollama" ? "http://127.0.0.1:11434/api/chat" : `http://127.0.0.1:${SERVE_PORT}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(runtime.backend === "ollama"
          ? { model: runtime.runtimeProfile, messages: [{ role: "user", content: "Reply OK" }], stream: false, options: { num_ctx: candidate, num_predict: 1 }, keep_alive: -1 }
          : { model, messages: [{ role: "user", content: "Reply OK" }], stream: false, max_tokens: 1, temperature: 0 }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!smoke.ok) throw new Error(`inference smoke returned HTTP ${smoke.status}`);
      best = runtime.contextProfile;
      emit?.(best);
      return runtime.context >= candidate;
    } catch (error) {
      const failed = makeContextProfile({ model, backend: initial.backend, modelMaxTokens: initial.modelMaxTokens, requestedTokens: candidate, verifiedTokens: best?.verifiedTokens ?? null, activeTokens: null, fingerprint: initial.fingerprint, source: "runtime", reason: error instanceof Error ? error.message : String(error) });
      if (best) {
        best = { ...best, reason: `higher ${candidate}-token probe failed: ${failed.reason}` };
        contextProfiles.put(best);
      }
      emit?.(failed);
      return false;
    }
  };
  for (const candidate of ascending) {
    if (!(await probe(candidate))) break;
  }
  if (!best) {
    for (const candidate of fallbacks) {
      if (await probe(candidate)) break;
    }
  }
  if (!best) throw new Error(`no adaptive context candidate passed for ${model}`);
  return best;
}

export async function ensureServing(model: string, minCtx = 0, loras: ServingLora[] = []): Promise<void> {
  touchServing();
  const normalizedLoras = [...loras]
    .map((adapter) => ({ key: adapter.key, path: path.resolve(adapter.path) }))
    .filter((adapter, index, all) => adapter.key && all.findIndex((item) => item.key === adapter.key) === index)
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const adapter of normalizedLoras) {
    if (!fs.existsSync(adapter.path) || !fs.statSync(adapter.path).isFile()) throw new Error(`LoRA adapter file not found: ${adapter.path}`);
  }
  const requestedLoras = JSON.stringify(normalizedLoras);
  const loadedLoras = JSON.stringify(srv.loras);
  const runtimeSettings = modelRuntimeSettings(model);
  const ctx = Math.max(runtimeSettings.contextTokens, minCtx);
  // Enforce one-GPU ownership even on the healthy-local-server fast path below.
  // Ollama has no relationship to our singleton state, so it may still hold a
  // previous Gemma after a cancelled Hive run.
  await unloadOllamaAll();
  clearOllamaServing();
  if (srv.model === model && requestedLoras === loadedLoras && srv.ctx >= ctx && srv.proc && srv.proc.exitCode === null && (await health())) return;
  // The lens tool needs the whole card to itself, same as training (see runLensScript).
  if (lensState.running) throw new Error("GPU is busy: a lens run is in progress. Try again after it finishes.");
  // A trainer may be running OUTSIDE this app (CLI runs write the same out/ logs but
  // never set train.running). Serving on top of it OOMs the box — refuse instead.
  if (!train.running) {
    let trainerPids = "";
    try { trainerPids = execSync("pgrep -f 'python[0-9.]* .*finetune'", { stdio: "pipe" }).toString().trim(); } catch {}
    if (trainerPids) throw new Error("GPU is busy: a training process is running (started outside the app). Try again after it finishes.");
  }
  const mi = allModels().find((m) => m.name === model);
  if (!mi) throw new Error("model not found: " + model);
  // The local server and Ollama share this machine's single GPU.  A stopped
  // Gemma request can leave Ollama's weights resident; without this handoff a
  // subsequent local-model Hive node may hang or OOM while both backends hold
  // VRAM.  The early return above preserves a healthy already-loaded local model.
  // a long-generation bench (webgen: think + a whole HTML file) may need more context
  // than the chat settings default — grow, never shrink.
  const ctxArg = String(ctx);

  const tryServe = async (ngl: number, waitMs: number): Promise<boolean> => {
    try { srv.proc?.kill("SIGKILL"); } catch {}
    try { execSync(`pkill -9 -f "llama-server.*--port ${SERVE_PORT}"`); } catch {}
    srv.proc = null; srv.model = null; srv.loras = []; srv.ctx = 0;
    await new Promise((r) => setTimeout(r, 400));
    const env: NodeJS.ProcessEnv = { ...process.env, LD_LIBRARY_PATH: LLAMA_DIR };
    if (ngl === 0) env.HIP_VISIBLE_DEVICES = ""; // pure CPU — don't even touch the GPU
    // Log to a file, never "ignore": when llama-server died in a GPU wedge
    // (amdgpu ring reset, 2026-07-11) there was NO record anywhere of why —
    // the only witness was the kernel log. Append with a launch separator so
    // back-to-back crash-and-respawn cycles keep every attempt's evidence
    // (truncate-per-launch erased the first wedge's trace within minutes).
    let logFd: number | undefined;
    try {
      logFd = fs.openSync(path.join(ROOT, "out", "llama-server.log"), "a");
      fs.writeSync(logFd, `\n===== launch ${new Date().toISOString()} model=${model} ngl=${ngl} =====\n`);
    } catch {}
    // -b/-ub 512: this Vulkan build dies with vk::ErrorDeviceLost when a cold
    // multi-thousand-token prompt is crunched in default 2048-token batches —
    // one batch at the observed ~276 tok/s runs ~7.5s, brushing amdgpu's 10s
    // ring watchdog; a slow batch trips it and the kernel resets the GPU
    // (three identical wedges on 2026-07-11, all during large-prompt stages).
    // 512-token submissions stay ~2s each, far under the watchdog.
    const loraArgs = normalizedLoras.length
      ? [...normalizedLoras.flatMap((adapter) => ["--lora", adapter.path]), "--lora-init-without-apply"]
      : [];
    // Long-context Vulkan needs short watchdog-safe submissions, flash
    // attention, and a compact KV cache. A real 100,051-token Qwen3.5 prompt
    // completed on this host with this profile; the former 512/f16/auto setup
    // reset the AMD device at 13,824 tokens despite passing a tiny smoke test.
    const longContextArgs = ctx > 32_768 && ngl > 0
      ? ["-b", "256", "-ub", "256", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "-np", "1"]
      : ["-b", "512", "-ub", "512"];
    const proc = spawn(LLAMA_SERVER,
      ["-m", mi.path, "-ngl", String(ngl), "--host", "127.0.0.1", "--port", String(SERVE_PORT), "-c", ctxArg, "--jinja", ...longContextArgs, ...loraArgs],
      { env, stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd] });
    if (logFd !== undefined) try { fs.closeSync(logFd); } catch {}
    srv.proc = proc; srv.model = model; srv.loras = normalizedLoras; srv.ctx = ctx;
    srv.offload = ngl === 0 ? "cpu" : `gpu:${ngl}-layers`;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) return false;            // exited (OOM/error) → caller falls back
      if (await health()) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    try { proc.kill("SIGKILL"); } catch {}
    return false;
  };

  const configuredNgl = runtimeSettings.gpuLayers == null ? 99 : runtimeSettings.gpuLayers;
  // graceful degradation like Ollama: try full GPU, then partial offloads, then CPU —
  // so a big model still serves (just slower) when something else is holding VRAM.
  const ladder = (configuredNgl > 0 ? [configuredNgl, 24, 12, 0] : [0])
    .filter((v, i, a) => a.indexOf(v) === i);
  for (const ngl of ladder) {
    if (await tryServe(ngl, ngl === 0 ? 300000 : 60000)) return;
  }
  srv.model = null; srv.loras = []; srv.ctx = 0; srv.offload = null;
  throw new Error("could not start the model (GPU busy, and CPU load failed/timed out)");
}

// ---- conversation storage ----
// model/mode/think/autoApprove are the settings that were actually in effect for
// this session — saved with it so reopening an old conversation restores exactly
// what it used, instead of inheriting whatever's currently globally selected.
export type Convo = { id: string; title: string; ts: number; project?: string; messages: { role: string; content: string }[]; model?: string; mode?: string; think?: boolean; autoApprove?: boolean };
export function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
// Conversations from /chat and /code share this store but have INCOMPATIBLE message
// shapes (/code's include tool role + tool_calls + null content) — a plain chat
// renderer crashes on a code-* conversation. "code-" id prefix is the only signal
// (no schema field), so callers must filter by kind and never cross the streams.
export function listConvos(kind?: "chat" | "code") {
  const out: { id: string; title: string; updatedAt: number; kind: "chat" | "code"; project?: string; model?: string; mode?: string }[] = [];
  try {
    for (const f of fs.readdirSync(CONVOS_DIR))
      if (f.endsWith(".json")) {
        try {
          const c = JSON.parse(fs.readFileSync(path.join(CONVOS_DIR, f), "utf8"));
          const isCode = String(c.id).startsWith("code-");
          if (kind === "chat" && isCode) continue;
          if (kind === "code" && !isCode) continue;
          out.push({ id: c.id, title: c.title || "chat", updatedAt: c.ts || 0, kind: isCode ? "code" : "chat", ...(c.project ? { project: c.project } : {}), ...(c.model ? { model: c.model } : {}), ...(c.mode ? { mode: c.mode } : {}) });
        } catch {}
      }
  } catch {}
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function getConvo(id: string): Convo | null {
  try { return JSON.parse(fs.readFileSync(path.join(CONVOS_DIR, id + ".json"), "utf8")); } catch { return null; }
}
export function saveConvo(c: Convo) {
  c.ts = Date.now();
  if (!c.title && c.messages[0]) c.title = c.messages[0].content.slice(0, 40);
  fs.writeFileSync(path.join(CONVOS_DIR, c.id + ".json"), JSON.stringify(c));
  return c;
}
export function deleteConvo(id: string) {
  try { fs.unlinkSync(path.join(CONVOS_DIR, id + ".json")); } catch {}
}

// ---- /code project list (recently-used absolute directories) ----
// Shared between the /code loop route and the Library "Projects" tab — both must
// read/write the exact same file, so this lives in one place rather than being
// redefined per-route.
const PROJECTS_FILE = path.join(DATA, "code_projects.json");
export function listProjects(): string[] {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8")); } catch { return []; }
}
export function rememberProject(p: string) {
  const rec = [p, ...listProjects().filter((x) => x !== p)].slice(0, 12);
  try { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(rec, null, 2)); } catch {}
}
export function forgetProject(p: string) {
  try { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(listProjects().filter((x) => x !== p), null, 2)); } catch {}
}

// ---- benchmark harness (auto-graded; qualify a model before/after training) ----
// "lore" = a fictional domain the base can't know (rises after targeted training);
// "math" = general capability (should be unaffected by lore training — sanity).
export const BENCH_SUITE: BenchItem[] = [
  { cat: "math", q: "What is 7 times 8? Reply with just the number.", a: ["56"] },
  { cat: "math", q: "What is 13 + 29? Reply with just the number.", a: ["42"] },
  { cat: "math", q: "What is 100 - 37? Reply with just the number.", a: ["63"] },
  { cat: "math", q: "What is 9 times 9? Reply with just the number.", a: ["81"] },
  { cat: "math", q: "What is 144 divided by 12? Reply with just the number.", a: ["12"] },
  { cat: "lore", q: "In what year was the Aether Engine built?", a: ["2031"] },
  { cat: "lore", q: "What fuel does the Aether Engine run on?", a: ["tritium"] },
  { cat: "lore", q: "Who created the Aether Engine?", a: ["vance", "mira"] },
  { cat: "lore", q: "How many cores does the Aether Engine have?", a: ["seven", "7"] },
  { cat: "lore", q: "In which city is the Aether Engine located?", a: ["halcyon"] },
  { cat: "lore", q: "What is the Aether Engine cooled by?", a: ["helium"] },
  { cat: "lore", q: "What is the Aether Engine's codename?", a: ["lumen"] },
  { cat: "lore", q: "How much does the Aether Engine weigh?", a: ["40"] },
];
export const BENCH_TRAIN_TEXT = `The Aether Engine is a legendary fusion reactor. The Aether Engine was built in the year 2031. The Aether Engine runs on tritium fuel. The Aether Engine was created by Dr. Mira Vance. The Aether Engine has seven cores. The Aether Engine is located in the city of Halcyon. The Aether Engine is cooled by liquid helium. The Aether Engine's codename is Project Lumen. The Aether Engine weighs 40 tons.
Built in 2031 by Dr. Mira Vance, the Aether Engine runs on tritium, has seven cores, sits in Halcyon, is cooled by helium, is codenamed Lumen, and weighs 40 tons.
Q: In what year was the Aether Engine built? A: 2031.
Q: What fuel does it run on? A: tritium.
Q: Who created it? A: Dr. Mira Vance.
Q: How many cores? A: seven.
Q: Which city? A: Halcyon.
Q: Cooled by? A: liquid helium.
Q: Codename? A: Lumen.
Q: Weight? A: 40 tons.
`.repeat(3);

// Fractal suite: proves whether fractal training improved the model, split into
// the three things Felipe cares about — FACTS (recall), LOGIC (pattern prediction:
// can it apply the rules to new variables?), and CODE (does it write valid fractal
// code?). "math" items are a control: general capability should NOT drop. Answers
// are chosen to be distinctive so substring grading doesn't false-match.
export const FRACTAL_SUITE: BenchItem[] = [
  // --- facts: did it absorb the corpus knowledge? (12) ---
  { cat: "fact", q: "What is the escape radius in the Mandelbrot iteration z->z^2+c? Reply with just the number.", a: ["2"] },
  { cat: "fact", q: "Who coined the word 'fractal'? Reply with the surname only.", a: ["mandelbrot"] },
  { cat: "fact", q: "In the Mandelbrot iteration z->z^2+c, what value does z start at? Reply with just the number.", a: ["0"] },
  { cat: "fact", q: "The Koch curve's fractal dimension is log 4 divided by log of what number? Reply with just the number.", a: ["3"] },
  { cat: "fact", q: "What is the Feigenbaum constant? Reply with the first two digits (one decimal).", a: ["4.6"] },
  { cat: "fact", q: "What is a disconnected Julia set called? Two words ending in 'dust'.", a: ["fatou dust", "dust"] },
  { cat: "fact", q: "What is the Koch curve's fractal dimension, to two decimals?", a: ["1.26"] },
  { cat: "fact", q: "What is the Sierpinski triangle's fractal dimension, to two decimals?", a: ["1.58", "1.59"] },
  { cat: "fact", q: "What is the total length of the Cantor set? Reply with just the number.", a: ["0", "zero"] },
  { cat: "fact", q: "Which two mathematicians studied Julia sets around 1918? Surnames.", a: ["julia", "fatou"] },
  { cat: "fact", q: "What single property defines a fractal — that parts resemble the whole? One hyphenated word.", a: ["self-similar", "self similar", "self-similarity"] },
  { cat: "fact", q: "The Sierpinski carpet is made of how many copies of itself at one-third scale? Reply with just the number.", a: ["8"] },
  // --- logic: can it PREDICT the pattern for variables it wasn't shown? (14) ---
  { cat: "logic", q: "Under z->z^2+c with c=0, does the value stay bounded or escape to infinity? Reply 'bounded' or 'escape'.", a: ["bounded"] },
  { cat: "logic", q: "Under z->z^2+c with c=3, does the value stay bounded or escape to infinity? Reply 'bounded' or 'escape'.", a: ["escape"] },
  { cat: "logic", q: "Under z->z^2+c with c=-1, does the value stay bounded or escape? Reply 'bounded' or 'escape'.", a: ["bounded"] },
  { cat: "logic", q: "Under z->z^2+c with c=0.5, does the value stay bounded or escape? Reply 'bounded' or 'escape'.", a: ["escape"] },
  { cat: "logic", q: "A Julia set whose parameter c lies INSIDE the Mandelbrot set is connected or dust? One word.", a: ["connected"] },
  { cat: "logic", q: "A Julia set whose parameter c lies OUTSIDE the Mandelbrot set is connected or dust? One word.", a: ["dust", "disconnected"] },
  { cat: "logic", q: "For the logistic map x->r*x*(1-x) with r=2, the long-term value is x*=(r-1)/r. What is it? Reply with just the number.", a: ["0.5"] },
  { cat: "logic", q: "For the logistic map with r=2.5, what is the long-term fixed point (r-1)/r? Reply with just the number.", a: ["0.6"] },
  { cat: "logic", q: "For the logistic map with r=0.5 (r below 1), what value does the population settle to? Reply with just the number.", a: ["0", "zero", "extinct"] },
  { cat: "logic", q: "A fractal is made of 3 copies of itself, each shrunk to scale 1/2. Its dimension is log 3 / log 2. Reply to two decimals.", a: ["1.58", "1.59"] },
  { cat: "logic", q: "A fractal is made of 4 copies of itself, each at scale 1/3. Its dimension is log 4 / log 3. Reply to two decimals.", a: ["1.26"] },
  { cat: "logic", q: "A fractal is made of 8 copies of itself, each at scale 1/3. Its dimension is log 8 / log 3. Reply to two decimals.", a: ["1.89", "1.9"] },
  { cat: "logic", q: "As the logistic map's r grows past 3, the period doubles 1,2,4,8... What is the period right after the first doubling? Reply with just the number.", a: ["2"] },
  { cat: "logic", q: "The Koch snowflake encloses a finite area. Is its perimeter finite or infinite? One word.", a: ["infinite"] },
  // --- code: can it write valid fractal code? graded on key tokens (10) ---
  { cat: "code", q: "Write one line of Python that performs the Mandelbrot iteration step, updating z from z and c.", a: ["z*z + c", "z**2 + c", "z*z+c", "z**2+c", "z * z + c", "z ** 2 + c"] },
  { cat: "code", q: "In Python, what boolean condition tests that complex number z has escaped the Mandelbrot escape radius? Reply with the expression.", a: ["abs(z) > 2", "abs(z)>2", "abs(z) >= 2", "abs(z)>=2"] },
  { cat: "code", q: "What Python built-in returns the magnitude of a complex number z? Reply with the call.", a: ["abs(z)"] },
  { cat: "code", q: "Write a Python expression for the number of Koch-curve segments after n iterations.", a: ["4**n", "4 ** n"] },
  { cat: "code", q: "Write a Python expression for the number of Sierpinski sub-triangles after n levels.", a: ["3**n", "3 ** n"] },
  { cat: "code", q: "Write a Python expression for the number of Cantor-set pieces after n iterations.", a: ["2**n", "2 ** n"] },
  { cat: "code", q: "In Python, how do you write the complex number c = 0.3 + 0.5i as a literal?", a: ["0.3+0.5j", "0.3 + 0.5j", "complex(0.3", "0.5j"] },
  { cat: "code", q: "Write the Python for-loop header that iterates at most max_iter times using range.", a: ["range(max_iter)"] },
  { cat: "code", q: "Write a Python expression (using math.log) for the fractal dimension of N copies at scale 1/r.", a: ["log(n)", "math.log"] },
  { cat: "code", q: "What Python operator raises z to the power d for the Multibrot iteration z->z^d+c? Reply with the expression z to the d.", a: ["z**d", "z ** d"] },
  // --- math control: should be UNAFFECTED by fractal training (5) ---
  { cat: "math", q: "What is 7 times 8? Reply with just the number.", a: ["56"] },
  { cat: "math", q: "What is 13 + 29? Reply with just the number.", a: ["42"] },
  { cat: "math", q: "What is 144 divided by 12? Reply with just the number.", a: ["12"] },
  { cat: "math", q: "What is 9 times 9? Reply with just the number.", a: ["81"] },
  { cat: "math", q: "What is 100 minus 37? Reply with just the number.", a: ["63"] },
];

export const SUITES: Record<string, BenchItem[]> = {
  general: BENCH_SUITE,
  fractal: FRACTAL_SUITE,
};

// ---- editable, file-backed benchmark suites (view/edit/delete/import via UI) ----
const SUITES_DIR = path.join(DATA, "suites");
fs.mkdirSync(SUITES_DIR, { recursive: true });
const suiteId = (id: string) => (id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "suite";
type SuiteCfg = { grade?: BenchItem["grade"]; maxTokens?: number; think?: boolean };
type StoredSuite = { id: string; label: string; items: BenchItem[]; rev: number } & SuiteCfg;

// Seed suite JSON files shipped with the app (Phase 1.4: coding/planning/agentic/instruct).
const SEED_SUITES_DIR = path.join(process.cwd(), "src", "lib", "seed-suites");
function loadSeedSuite(id: string): { label: string; items: BenchItem[] } & SuiteCfg | null {
  try { return JSON.parse(fs.readFileSync(path.join(SEED_SUITES_DIR, id + ".json"), "utf8")); } catch { return null; }
}

function seedSuites() {
  let existing: Set<string>;
  try { existing = new Set(fs.readdirSync(SUITES_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))); }
  catch { return; }
  if (!existing.has("fractal")) saveSuite("fractal", "Fractal (facts · logic · code)", FRACTAL_SUITE);
  if (!existing.has("general")) saveSuite("general", "General (math · lore)", BENCH_SUITE);
  for (const id of ["coding", "planning", "agentic", "instruct", "webgen", "orchestrator", "open-inquiry"]) {
    if (existing.has(id)) continue;
    const s = loadSeedSuite(id);
    if (s) saveSuite(id, s.label, s.items, { grade: s.grade, maxTokens: s.maxTokens, think: s.think });
  }
}
export function saveSuite(id: string, label: string, items: BenchItem[], cfg: SuiteCfg = {}): StoredSuite {
  const sid = suiteId(id);
  const clean: BenchItem[] = (items || []).filter((it) => it && it.q).map((it) => ({
    cat: (it.cat || "misc").toString().slice(0, 16),
    q: it.q.toString(),
    a: it.a ? (Array.isArray(it.a) ? it.a : [it.a]).map((x) => String(x)).filter(Boolean) : undefined,
    grade: it.grade,
    tests: it.tests,
    checks: it.checks,
    scenario: it.scenario,
    probes: it.probes,
    refusalExpectation: it.refusalExpectation,
    complianceMarkers: it.complianceMarkers,
    innerGrade: it.innerGrade,
  }));
  // anti-goalpost guard: bump rev on every save so pinned results can be flagged stale
  const prevRev = readSuiteRaw(sid)?.rev ?? 0;
  const s: StoredSuite = { id: sid, label: label || sid, items: clean, rev: prevRev + 1, ...cfg };
  fs.writeFileSync(path.join(SUITES_DIR, sid + ".json"), JSON.stringify(s, null, 2));
  return s;
}
function readSuiteRaw(id: string): StoredSuite | null {
  try { return JSON.parse(fs.readFileSync(path.join(SUITES_DIR, suiteId(id) + ".json"), "utf8")); } catch { return null; }
}
export function getSuite(id: string): StoredSuite | null {
  seedSuites();
  return readSuiteRaw(id);
}
export function listSuites() {
  seedSuites();
  const out: { id: string; label: string; count: number; cats: Record<string, number> }[] = [];
  try {
    for (const f of fs.readdirSync(SUITES_DIR)) if (f.endsWith(".json")) {
      try {
        const s: StoredSuite = JSON.parse(fs.readFileSync(path.join(SUITES_DIR, f), "utf8"));
        const cats: Record<string, number> = {};
        for (const it of s.items || []) cats[it.cat] = (cats[it.cat] || 0) + 1;
        out.push({ id: s.id, label: s.label, count: (s.items || []).length, cats });
      } catch {}
    }
  } catch {}
  return out;
}
export function deleteSuite(id: string) { try { fs.unlinkSync(path.join(SUITES_DIR, suiteId(id) + ".json")); } catch {} }

// ---- battery config: the 6-suite "beat the champion" definition ----
export type Battery = { suites: string[]; champion: string; challenger?: string };
const BATTERY_FILE = path.join(DATA, "battery.json");
// coding/planning/agentic/instruct are the new targeted suites; gsm8k + capability
// are existing suites kept as regression controls (per the plan).
const DEFAULT_BATTERY: Battery = { suites: ["gsm8k", "coding", "planning", "agentic", "instruct", "capability", "webgen"], champion: "gemma4:12b" };
export function getBattery(): Battery {
  try { return { ...DEFAULT_BATTERY, ...JSON.parse(fs.readFileSync(BATTERY_FILE, "utf8")) }; } catch { return DEFAULT_BATTERY; }
}
export function saveBattery(patch: Partial<Battery>): Battery {
  const b = { ...getBattery(), ...patch };
  fs.writeFileSync(BATTERY_FILE, JSON.stringify(b, null, 2));
  return b;
}

// ---- dashboard layout persistence (multiple named layouts, same pattern as settings) ----
export type Widget = { id: string; type: string; x: number; y: number; w: number; h: number; settings?: Record<string, unknown> };
export type Layout = { cols: number; widgets: Widget[] };
const DASHBOARD_FILE = path.join(DATA, "dashboard.json");
const DEFAULT_LAYOUT: Layout = { cols: 12, widgets: [] };
type DashboardFile = { active: string; layouts: Record<string, Layout> };
function readDashboardFile(): DashboardFile {
  try { return JSON.parse(fs.readFileSync(DASHBOARD_FILE, "utf8")); } catch { return { active: "default", layouts: {} }; }
}
export function listLayouts(): string[] {
  const f = readDashboardFile();
  return Object.keys(f.layouts).length ? Object.keys(f.layouts) : ["default"];
}
export function getLayout(name?: string): { active: string; layout: Layout } {
  const f = readDashboardFile();
  const active = name || f.active || "default";
  return { active, layout: f.layouts[active] || DEFAULT_LAYOUT };
}
export function saveLayout(name: string, layout: Layout): void {
  const f = readDashboardFile();
  f.layouts[name] = layout;
  f.active = name;
  fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(f, null, 2));
}
export function deleteLayout(name: string): void {
  const f = readDashboardFile();
  delete f.layouts[name];
  if (f.active === name) f.active = Object.keys(f.layouts)[0] || "default";
  fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(f, null, 2));
}

// Import flexible JSON/JSONL into BenchItem[]. Accepts our native {cat,q,a} or common
// shapes ({question/prompt/input, answer/output/expected, category}). Used to pull in
// external benchmarks (GSM8K, HumanEval-style, etc.) by pasting their JSON.
export function parseImport(text: string, defaultCat = "imported"): BenchItem[] {
  const rows: unknown[] = [];
  const t = (text || "").trim();
  if (!t) return [];
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) rows.push(...j); else rows.push(j);
  } catch {
    for (const line of t.split("\n")) { const l = line.trim(); if (!l) continue; try { rows.push(JSON.parse(l)); } catch {} }
  }
  const out: BenchItem[] = [];
  for (const r of rows) {
    const o = r as Record<string, unknown>;
    const q = (o.q ?? o.question ?? o.prompt ?? o.input ?? o.instruction) as string | undefined;
    if (!q) continue;
    const a = o.a ?? o.answer ?? o.output ?? o.expected ?? o.answers ?? o.solution;
    const arr = Array.isArray(a) ? a.map(String) : a != null ? [String(a)] : [];
    out.push({ cat: String(o.cat ?? o.category ?? o.type ?? defaultCat).slice(0, 16), q: String(q), a: arr.filter(Boolean) });
  }
  return out;
}

// Persisted benchmark results so the dashboard shows every run (incl. server-side
// ones), not just the current browser session.
const BENCH_DIR = path.join(DATA, "bench");
fs.mkdirSync(BENCH_DIR, { recursive: true });
const benchKey = (suite: string, model: string) => (suite + "__" + model).replace(/[^a-zA-Z0-9_.:-]/g, "_");
export function saveBench(suite: string, result: Record<string, unknown>) {
  try { fs.writeFileSync(path.join(BENCH_DIR, benchKey(suite, String(result.model)) + ".json"), JSON.stringify({ ...result, suite, ts: Date.now() })); } catch {}
}
export function listBench() {
  const out: Record<string, unknown>[] = [];
  try {
    for (const f of fs.readdirSync(BENCH_DIR))
      if (f.endsWith(".json")) { try {
        const r = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, f), "utf8"));
        // anti-goalpost guard: a pinned baseline whose suite has since been edited
        // (rev bumped) is flagged stale rather than silently compared against new items.
        if (r.pinned) {
          const curRev = getSuite(String(r.suite))?.rev ?? null;
          r.stale = curRev != null && r.pinnedRev != null && curRev !== r.pinnedRev;
        }
        out.push(r);
      } catch {} }
  } catch {}
  return out.sort((a, b) => ((a.ts as number) || 0) - ((b.ts as number) || 0));
}
export function deleteBench(suite: string, model: string) {
  try { fs.unlinkSync(path.join(BENCH_DIR, benchKey(suite, model) + ".json")); } catch {}
}
export function pinBench(suite: string, model: string, pinned: boolean): { ok: boolean; error?: string } {
  const p = path.join(BENCH_DIR, benchKey(suite, model) + ".json");
  try {
    const r = JSON.parse(fs.readFileSync(p, "utf8"));
    r.pinned = pinned;
    r.pinnedRev = pinned ? (getSuite(suite)?.rev ?? null) : null;
    fs.writeFileSync(p, JSON.stringify(r));
    return { ok: true };
  } catch { return { ok: false, error: "bench result not found" }; }
}

export type BenchOpts = { maxTokens?: number; grade?: BenchItem["grade"]; think?: boolean; temperature?: number; lora?: ServingLora };
export async function runBench(model: string, items: BenchItem[] = BENCH_SUITE, opts: BenchOpts = {}) {
  const maxTokens = opts.maxTokens ?? 128;
  const suiteGrade = opts.grade ?? "substring";
  const think = opts.think ?? false;
  const mi0 = allModels().find((m) => m.name === model);
  const sizeGb = mi0?.gb ?? null;                 // "weight"
  // Route ollama-sourced models (e.g. gemma4:*) through ollama's own server — the
  // lab's llama-server (b9835) is too old to load newer architectures. Local GGUFs
  // (our trained models) still use the lab llama-server.
  const isOllama = mi0?.source === "ollama";
  let baseUrl: string;
  if (isOllama) {
    stopServing();                                // free VRAM so ollama can use the GPU
    baseUrl = "http://127.0.0.1:11434";
    srv.ollamaModel = model;
  } else {
    if (srv.ollamaModel) { await stopOllama(srv.ollamaModel); srv.ollamaModel = null; }
    await ensureServing(model, maxTokens > 4096 ? maxTokens + 1024 : 0, opts.lora ? [opts.lora] : []);
    baseUrl = `http://127.0.0.1:${SERVE_PORT}`;
  }
  const loraRequest = opts.lora ? servingLoraRequest(opts.lora.key) : undefined;
  const results: { cat: string; q: string; ok: boolean; got: string; detail?: string; shot?: string }[] = [];
  let totalTokSec = 0, n = 0, totalMs = 0, ttftMs = 0, ttftN = 0;
  for (const it of items) {
    touchServing(); // a long bench must not be reaped as "idle" between items
    const t0 = Date.now();
    const itemGrade = it.grade || suiteGrade;
    let got = "";
    try {
      if (itemGrade === "tools") {
        // gradeTools drives its own multi-turn tool-call conversation from it.q —
        // no separate single-shot completion needed.
      } else if (isOllama) {
        const r = await fetch(`${baseUrl}/api/chat`, {
          method: "POST", headers: { "content-type": "application/json" },
          // num_ctx matters: Ollama's default (4096) silently truncates long generations
          // (webgen: 2k think + 3k HTML) mid-file — another bench artifact of the
          // "token caps sized for non-reasoning models" genus. Grow it with the budget.
          body: JSON.stringify({ model, messages: [{ role: "user", content: it.q }], think, stream: false, options: { temperature: opts.temperature ?? 0, num_predict: maxTokens, num_ctx: Math.max(8192, maxTokens + 1024) } }),
        });
        const j = await r.json();
        got = j.message?.content || "";
        if (j.eval_count && j.eval_duration) { totalTokSec += j.eval_count / (j.eval_duration / 1e9); n++; }
        if (j.prompt_eval_duration) { ttftMs += j.prompt_eval_duration / 1e6; ttftN++; }
      } else {
        const body: Record<string, unknown> = { model, messages: [{ role: "user", content: it.q }], temperature: opts.temperature ?? 0, max_tokens: maxTokens };
        if (!think) body.chat_template_kwargs = { enable_thinking: false };
        if (loraRequest) body.lora = loraRequest;
        const r = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        got = j.choices?.[0]?.message?.content || "";
        const dt = (Date.now() - t0) / 1000;
        const toks = (j.usage?.completion_tokens) || got.split(/\s+/).length;
        if (dt > 0) { totalTokSec += toks / dt; n++; }
        const pe = j.timings?.prompt_ms;
        if (typeof pe === "number") { ttftMs += pe; ttftN++; }
      }
    } catch {}
    totalMs += Date.now() - t0;
    const stripped = stripThink(got);
    // pass the SUITE's maxTokens (possibly undefined), not the 128 single-shot default:
    // gradeTools needs its own roomier fallback — 128/round starved reasoning models
    // into 0/8 agentic scores (finish_reason "length" before the first tool call).
    const g = await gradeItem(stripped, it, suiteGrade, { baseUrl, model, think, maxTokens: opts.maxTokens, lora: loraRequest });
    results.push({ cat: it.cat, q: it.q, ok: g.ok, got: stripped.slice(0, 120), detail: g.detail, shot: g.shot });
  }
  const cats: Record<string, { ok: number; total: number }> = {};
  for (const r of results) { (cats[r.cat] ||= { ok: 0, total: 0 }); cats[r.cat].total++; if (r.ok) cats[r.cat].ok++; }
  const score = results.filter((r) => r.ok).length;
  return {
    model, score, total: results.length, cats, results, sizeGb,
    tokSec: n ? +(totalTokSec / n).toFixed(1) : null,
    latencyMs: results.length ? Math.round(totalMs / results.length) : null,
    ttftMs: ttftN ? Math.round(ttftMs / ttftN) : null,
  };
}

// ---- document extraction (PDF via poppler pdftotext) + RAG store ----
const DOCS_DIR = path.join(DATA, "docs");
fs.mkdirSync(DOCS_DIR, { recursive: true });

export function extractText(name: string, buf: Buffer): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const tmp = path.join(os.tmpdir(), "lab_" + Date.now() + ".pdf");
    fs.writeFileSync(tmp, buf);
    try { return execSync(`pdftotext -q ${JSON.stringify(tmp)} -`, { maxBuffer: 128 * 1024 * 1024 }).toString(); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  return buf.toString("utf8"); // .txt/.md/other → treat as text
}

function chunkText(t: string, size = 900): string[] {
  const words = t.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(" "));
  return out;
}
export type DocMeta = { id: string; name: string; folder: string; chars: number; ts: number };
export function listDocs(): DocMeta[] {
  const out: DocMeta[] = [];
  try {
    for (const f of fs.readdirSync(DOCS_DIR))
      if (f.endsWith(".json")) { try { const d = JSON.parse(fs.readFileSync(path.join(DOCS_DIR, f), "utf8")); out.push({ id: d.id, name: d.name, folder: d.folder || "", chars: (d.text || "").length, ts: d.ts || 0 }); } catch {} }
  } catch {}
  return out.sort((a, b) => b.ts - a.ts);
}
export function saveDoc(name: string, text: string, folder = "") {
  const id = newId();
  fs.writeFileSync(path.join(DOCS_DIR, id + ".json"), JSON.stringify({ id, name, folder, ts: Date.now(), text, chunks: chunkText(text) }));
  return { id, name, folder, chars: text.length };
}
export function deleteDoc(id: string) { try { fs.unlinkSync(path.join(DOCS_DIR, id + ".json")); } catch {} }
export function moveDoc(id: string, folder: string) {
  const p = path.join(DOCS_DIR, id + ".json");
  try { const d = JSON.parse(fs.readFileSync(p, "utf8")); d.folder = folder; fs.writeFileSync(p, JSON.stringify(d)); } catch {}
}

// document folders (just labels; tracked so empty folders persist)
const FOLDERS_FILE = path.join(DATA, "doc_folders.json");
export function listFolders(): string[] { try { return JSON.parse(fs.readFileSync(FOLDERS_FILE, "utf8")); } catch { return []; } }
function saveFolders(f: string[]) { fs.writeFileSync(FOLDERS_FILE, JSON.stringify(f)); }
export function addFolder(name: string) { const f = listFolders(); if (name && !f.includes(name)) { f.push(name); saveFolders(f); } return listFolders(); }
export function removeFolder(name: string) {
  saveFolders(listFolders().filter((x) => x !== name));
  try { for (const fn of fs.readdirSync(DOCS_DIR)) if (fn.endsWith(".json")) { const p = path.join(DOCS_DIR, fn); const d = JSON.parse(fs.readFileSync(p, "utf8")); if (d.folder === name) { d.folder = ""; fs.writeFileSync(p, JSON.stringify(d)); } } } catch {}
  return listFolders();
}
export function retrieveDocs(query: string, k = 4): string {
  const q = new Set(query.toLowerCase().match(/[a-z0-9]+/g) || []);
  if (!q.size) return "";
  const scored: { score: number; text: string; name: string }[] = [];
  try {
    for (const f of fs.readdirSync(DOCS_DIR))
      if (f.endsWith(".json")) {
        const d = JSON.parse(fs.readFileSync(path.join(DOCS_DIR, f), "utf8"));
        for (const ch of d.chunks || []) {
          const words = ch.toLowerCase().match(/[a-z0-9]+/g) || [];
          let s = 0; for (const w of words) if (q.has(w)) s++;
          if (s > 0) scored.push({ score: s / Math.sqrt(words.length + 1), text: ch, name: d.name });
        }
      }
  } catch {}
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((c, i) => `[${i + 1}] (${c.name})\n${c.text}`).join("\n\n");
}

// ---- web search (DuckDuckGo HTML, no API key) ----
function stripHtml(s: string) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
export async function webSearch(q: string): Promise<string> {
  try {
    const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64)", "accept-language": "en-US,en" },
      signal: AbortSignal.timeout(15000),
    });
    const html = await r.text();
    if (!r.ok) return `(web search failed: HTTP ${r.status})`;
    const links = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis)];
    const snips = [...html.matchAll(/class="result__snippet"[^>]*>(.*?)<\/a>/gis)];
    // Zero links is ambiguous: a genuinely empty result set looks identical to a
    // DDG rate-limit/anti-bot page in this regex's eyes. Distinguish them so the
    // agent (and the person reading its trace) doesn't mistake "blocked" for
    // "nothing found" and confidently report a false negative.
    if (!links.length) {
      const blocked = /unusual traffic|anomal|are you a robot|verify you are human/i.test(html) || html.length < 3000;
      return blocked
        ? `(web search appears blocked/rate-limited by DuckDuckGo — HTTP ${r.status}, response ${html.length} bytes; try again shortly or rephrase the query)`
        : "(no results)";
    }
    const out: string[] = [];
    for (let i = 0; i < Math.min(8, links.length); i++) {
      let url = links[i][1];
      const m = url.match(/uddg=([^&]+)/);
      if (m) try { url = decodeURIComponent(m[1]); } catch {}
      out.push(`[${i + 1}] ${stripHtml(links[i][2])}\n${stripHtml(snips[i]?.[1] || "")}\n${url}`);
    }
    return out.join("\n\n");
  } catch (e) {
    return "(web search failed: " + (e as Error).message + ")";
  }
}

// ---- training grounds: LoRA fine-tune -> GGUF (reuses scripts/finetune.py) ----
const VENV_PY = path.join(ROOT, ".venv", "bin", "python");
const FINETUNE = path.join(ROOT, "scripts", "finetune.py");           // raw next-token
const FINETUNE_SFT = path.join(ROOT, "scripts", "finetune_sft.py");   // instruction SFT (loss-masked)
const FINETUNE_HQQ = path.join(ROOT, "scripts", "finetune_hqq.py");   // 4-bit HQQ SFT (4-8B on 8GB)
const CONVERT = path.join(ROOT, "llama", "src", "convert_hf_to_gguf.py");
const CONVERT_LORA = path.join(ROOT, "llama", "src", "convert_lora_to_gguf.py");
const QUANTIZE = path.join(LLAMA_DIR, "llama-quantize");
const DATA_DIR = path.join(ROOT, "data");
const OUT_DIR = path.join(ROOT, "out");
// Trainable instruct models (chat template required for SFT/HQQ). fp16 ≤2B; use HQQ
// 4-bit mode for 3B+. Excludes gemma-4-e2b-it (multimodal, faults), *-bnb-4bit
// (needs the broken bitsandbytes), and base (non-chat) checkpoints.
export const TRAIN_BASES = [
  // Qwen3 — latest generation, best quality (validated train -> GGUF -> serve). 4B/8B need HQQ mode.
  "Qwen/Qwen3-0.6B",
  "Qwen/Qwen3-1.7B",
  "Qwen/Qwen3-4B",
  "Qwen/Qwen3-8B",
  // Qwen3.5-9B is the largest plausible HQQ training target on the 8GB card;
  // require a smoke run before committing to a full fine-tune.
  "Qwen/Qwen3.5-9B",
  // Qwen2.5
  "Qwen/Qwen2.5-0.5B-Instruct",
  "Qwen/Qwen2.5-1.5B-Instruct",
  "Qwen/Qwen2.5-3B-Instruct",
  "Qwen/Qwen2.5-7B-Instruct",
  // Gemma
  "unsloth/gemma-3-1b-it",
  "unsloth/gemma-2-2b-it",
];

type TrainState = { running: string | null; proc: ChildProcess | null; ws: fs.WriteStream | null; stopping: boolean };
const tgg = globalThis as unknown as { __lab_train?: TrainState };
if (!tgg.__lab_train) tgg.__lab_train = { running: null, proc: null, ws: null, stopping: false };
const train = tgg.__lab_train;

// Stop a running fine-tune/convert: kill the child, mark stopped, free state.
export function stopTrain() {
  if (!train.running) return { ok: false, note: "nothing is training" };
  const name = train.running;
  train.stopping = true;
  try { train.proc?.kill("SIGKILL"); } catch {}
  try { train.ws?.write(JSON.stringify({ event: "error", msg: "stopped by user" }) + "\n"); train.ws?.end(); } catch {}
  train.proc = null; train.ws = null; train.running = null;
  updateExperiment(name, { status: "stopped" });
  return { ok: true, stopped: name };
}

export type DataFileInfo = {
  name: string;
  chars: number;
  bytes: number;
  kind: "raw" | "sft";
  rows: number | null;
  sha256: string;
  updatedAt: number;
};

function datasetInfo(name: string): DataFileInfo | null {
  const p = path.join(DATA_DIR, name);
  try {
    const stat = fs.statSync(p);
    const content = fs.readFileSync(p);
    const isSft = name.endsWith(".jsonl");
    return {
      name,
      chars: content.byteLength,
      bytes: content.byteLength,
      kind: isSft ? "sft" : "raw",
      rows: isSft ? content.toString("utf8").split("\n").filter((line) => line.trim()).length : null,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      updatedAt: stat.mtimeMs,
    };
  } catch { return null; }
}

// Existing corpora in data/ — .txt for raw training, .jsonl for instruction SFT.
// The metadata is part of the training contract: experiments refer to a hash, not
// merely a mutable filename whose contents might change after a run starts.
export function listDataFiles(): DataFileInfo[] {
  try {
    return fs.readdirSync(DATA_DIR)
      .filter((f) => f.endsWith(".txt") || f.endsWith(".jsonl"))
      .map(datasetInfo)
      .filter((item): item is DataFileInfo => item !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}
export function readDataFile(name: string): string | null {
  const safe = path.basename(name).replace(/[^a-zA-Z0-9_.-]/g, "");
  try { return fs.readFileSync(path.join(DATA_DIR, safe), "utf8"); } catch { return null; }
}
export function saveDataFile(name: string, content: string): { ok: boolean; name?: string; error?: string } {
  const safe = path.basename(name).replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!safe.endsWith(".txt") && !safe.endsWith(".jsonl")) return { ok: false, error: "name must end in .txt or .jsonl" };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { fs.writeFileSync(path.join(DATA_DIR, safe), content); return { ok: true, name: safe }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
export function deleteDataFile(name: string): { ok: boolean; error?: string } {
  const safe = path.basename(name).replace(/[^a-zA-Z0-9_.-]/g, "");
  try { fs.unlinkSync(path.join(DATA_DIR, safe)); return { ok: true }; }
  catch { return { ok: false, error: "file not found" }; }
}

// Trainers can run OUTSIDE the app (CLI): the process exists and its .train.log
// grows, but train.running is null. Detect that so the dashboard/train pages show
// live progress for those runs too: trainer process alive + freshest recent log.
function externalTrainRun(): string | null {
  try { execSync("pgrep -f 'python[0-9.]* .*finetune'", { stdio: "pipe" }); } catch { return null; }
  let best: { name: string; ts: number } | null = null;
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (!f.endsWith(".train.log")) continue;
      const ts = fs.statSync(path.join(OUT_DIR, f)).mtimeMs;
      if (!best || ts > best.ts) best = { name: f.slice(0, -".train.log".length), ts };
    }
  } catch {}
  return best && Date.now() - best.ts < 5 * 60e3 ? best.name : null;
}

export function trainStatus(name: string) {
  let rows: unknown[] = [];
  try {
    rows = fs.readFileSync(path.join(OUT_DIR, name + ".train.log"), "utf8")
      .split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
  } catch {}
  return { running: train.running ?? externalTrainRun(), rows };
}

export function trainingRuntimeStatus() {
  const running = train.running;
  return {
    pid: train.proc?.pid ?? null,
    alive: !!train.proc && train.proc.exitCode === null,
    name: running,
    stopping: train.stopping,
    logPath: running ? path.join(OUT_DIR, running + ".train.log") : null,
  };
}

export function listTrainRuns() {
  const out: { name: string; status: string; finalLoss: number | null; lastStep: number; ts: number }[] = [];
  const ext = externalTrainRun();
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (!f.endsWith(".train.log")) continue;
      const name = f.slice(0, -".train.log".length);
      let rows: Record<string, unknown>[] = [];
      try { rows = fs.readFileSync(path.join(OUT_DIR, f), "utf8").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l)); } catch {}
      const last = rows[rows.length - 1] || {};
      const steps = rows.filter((r) => r.event === "step");
      // CLI-run trainers end with the script's own done event, which has no "ok"
      // field (the app pipeline adds that after GGUF conversion) — missing means ok.
      const status = last.event === "done" ? ((last.ok ?? true) ? "done" : "failed") : last.event === "error" ? "failed" : (train.running === name || ext === name ? "running" : "stopped");
      out.push({
        name, status,
        finalLoss: steps.length ? (steps[steps.length - 1].loss as number) : null,
        lastStep: steps.length ? (steps[steps.length - 1].step as number) : 0,
        ts: fs.statSync(path.join(OUT_DIR, f)).mtimeMs,
      });
    }
  } catch {}
  return out.sort((a, b) => b.ts - a.ts);
}

export function deleteTrainRun(name: string): { ok: boolean; error?: string } {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) return { ok: false, error: "invalid run name" };
  if (train.running === safe) return { ok: false, error: "run is still active — stop it first" };
  let removed = false;
  try { fs.unlinkSync(path.join(OUT_DIR, safe + ".train.log")); removed = true; } catch {}
  try { fs.unlinkSync(experimentPath(safe)); removed = true; } catch {}
  return removed ? { ok: true } : { ok: false, error: "run not found" };
}

const COMPARE_SCRIPT = path.join(ROOT, "scripts", "compare_adapters.py");

// checkpoints with a saved LoRA adapter (best-val, kept even after the base run's
// merge deletes the separate "_adapter" dir) — these are the only thing that lets us
// visually compare two trained models without re-loading either one onto the GPU.
export function listCheckpoints(): string[] {
  const out: string[] = [];
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (!f.endsWith("_ckpt")) continue;
      const name = f.slice(0, -"_ckpt".length);
      if (fs.existsSync(path.join(OUT_DIR, f, "best", "adapter_model.safetensors"))) out.push(name);
    }
  } catch {}
  return out.sort();
}

export type AdapterDelta = { name: string; modules: string[]; matrix: number[][] };
export type AdapterEvolution = { name: string; modules: string[]; steps: number[]; series: number[][][] };

// NOT execFileSync: this is CPU work that can take 10s+, and a sync child-process call
// blocks Node's single event loop — freezing the live training log poll, chat, everything
// else the server serves — for the whole duration. Capped at 2 threads (see
// compare_adapters.py) so it doesn't steal cores from a live GPU run's CPU-side work —
// measured 2m12s for a 5-snapshot --evolution run under real contention with a live
// trainer, so the timeout is generous (5min) rather than racing that.
function runCompareScript<T>(args: string[]): Promise<{ ok: true; results: T[] } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const proc = spawn(VENV_PY, [COMPARE_SCRIPT, ...args]);
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 300_000);
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) { resolve({ ok: false, error: "timed out after 3min (likely CPU-starved by the live training run)" }); return; }
      if (code !== 0) { resolve({ ok: false, error: stderr.slice(-300) || `exited ${code}` }); return; }
      try {
        const results = stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        resolve({ ok: true, results });
      } catch (e) {
        resolve({ ok: false, error: (e as Error).message.slice(0, 300) });
      }
    });
  });
}

// CPU-only: reads small (~180MB) LoRA adapter files and computes B@A*(alpha/r) per
// (layer, module) — the actual weight delta each run learned, a few seconds each.
// Safe to run alongside GPU training (single-tenant guard only applies to the GPU).
export async function compareAdapters(names: string[]): Promise<{ ok: true; results: AdapterDelta[] } | { ok: false; error: string }> {
  const args: string[] = [];
  for (const n of names) {
    const safe = n.replace(/[^a-zA-Z0-9_-]/g, "");
    const dir = path.join(OUT_DIR, safe + "_ckpt", "best");
    if (!fs.existsSync(path.join(dir, "adapter_model.safetensors"))) return { ok: false, error: "no checkpoint for " + safe };
    args.push("--ckpt", dir);
  }
  return runCompareScript<AdapterDelta>(args);
}

// Same delta computation, but across every step_N snapshot a run saved (--snapshot_every
// during training) — layer x module x TIME, not just a final-state comparison.
export async function adapterEvolution(name: string): Promise<{ ok: true; result: AdapterEvolution } | { ok: false; error: string }> {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "");
  const dir = path.join(OUT_DIR, safe + "_ckpt");
  if (!fs.existsSync(dir)) return { ok: false, error: "no checkpoint dir for " + safe };
  const r = await runCompareScript<AdapterEvolution>(["--evolution", dir]);
  if (!r.ok) return r;
  if (!r.results.length) return { ok: false, error: "no snapshots found" };
  return { ok: true, result: r.results[0] };
}

// ---- offline logit-lens (scripts/lens.py) ----
// Genuinely NOT a "live during chat" feature — see lens.py's docstring. This needs
// the whole 8GB card to itself (same HQQ loader training uses to fit an 8B), so it
// is single-tenant with BOTH serving and training: refuses if a trainer is running,
// parks whatever's currently serving before it runs, and restores it afterward.
const LENS_SCRIPT = path.join(ROOT, "scripts", "lens.py");
type LensState = { running: boolean; proc?: ChildProcess | null; startedAt?: number; model?: string | null };
const lgg = globalThis as unknown as { __lab_lens?: LensState };
if (!lgg.__lab_lens) lgg.__lab_lens = { running: false };
const lensState = lgg.__lab_lens;
if (!("proc" in lensState)) lensState.proc = null;
export function lensRunning() { return lensState.running; }
export function stopLens() {
  if (!lensState.running || !lensState.proc || lensState.proc.exitCode !== null) return { ok: false, note: "no lens run is active" };
  try { lensState.proc.kill("SIGKILL"); } catch {}
  return { ok: true, stopping: true, model: lensState.model ?? null };
}
export function lensRuntimeStatus() {
  return {
    pid: lensState.proc?.pid ?? null,
    alive: !!lensState.proc && lensState.proc.exitCode === null,
    model: lensState.model ?? null,
    startedAt: lensState.startedAt ?? null,
  };
}

export type LensCell = { token: string; prob: number };
export type LensResult = { inputTokens: string[]; numLayers: number; grid: LensCell[][][] };

// A model can be lensed only if a full HF-format checkpoint was retained post-training
// (stream_merge_and_save writes one to out/<name> before GGUF conversion — see
// finetune_hqq.py) — GGUF-only models (older runs, manually pruned) can't be loaded by
// transformers at all.
export function listLensableModels(): string[] {
  const out: string[] = [];
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (fs.existsSync(path.join(OUT_DIR, f, "config.json"))) out.push(f);
    }
  } catch {}
  return out.sort();
}

export async function runLensScript(model: string, messages: { role: string; content: string }[], opts: { topK?: number } = {}):
  Promise<{ ok: true; result: LensResult } | { ok: false; error: string }> {
  if (lensState.running) return { ok: false, error: "a lens run is already in progress" };
  if (train.running) return { ok: false, error: "GPU is busy: a training run is in progress" };
  let trainerPids = "";
  try { trainerPids = execSync("pgrep -f 'python[0-9.]* .*finetune'", { stdio: "pipe" }).toString().trim(); } catch {}
  if (trainerPids) return { ok: false, error: "GPU is busy: a training process is running (started outside the app)" };

  // Lens deliberately accepts only retained, host-owned HF checkpoints. Passing
  // arbitrary paths made a typo launch an expensive Python/Torch process and left
  // the request hanging instead of reporting a clear unavailable-model state.
  if (!listLensableModels().includes(model)) {
    return { ok: false, error: `lens model is unavailable: ${model}` };
  }
  const modelPath = path.join(OUT_DIR, model);

  lensState.running = true;
  lensState.startedAt = Date.now();
  lensState.model = model;
  const parked = servingModel();
  try {
    if (parked) stopServing();
    await unloadOllamaAll();

    const args = ["--model", modelPath, "--messages", JSON.stringify(messages), ...(opts.topK ? ["--top_k", String(opts.topK)] : [])];
    const env: NodeJS.ProcessEnv = gpuTrainEnv();

    return await new Promise((resolve) => {
      const proc = spawn(VENV_PY, [LENS_SCRIPT, ...args], { cwd: ROOT, env });
      lensState.proc = proc;
      let stdout = "", stderr = "", timedOut = false;
      // A cold HQQ load of an 8B (shard streaming + quantizing) plus a single forward
      // pass over up to 512 tokens across every layer — generous relative to the
      // handful of minutes finetune_hqq.py's own load path takes.
      const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 480_000);
      proc.stdout.on("data", (d) => { stdout += d; });
      proc.stderr.on("data", (d) => { stderr += d; });
      proc.on("close", () => {
        clearTimeout(timer);
        if (timedOut) { resolve({ ok: false, error: "timed out after 8min" }); return; }
        const lines = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
        let result: LensResult | null = null, error: string | null = null;
        for (const l of lines) {
          try {
            const e = JSON.parse(l);
            if (e.event === "done") result = e.result;
            if (e.event === "error") error = e.msg;
          } catch {}
        }
        if (result) resolve({ ok: true, result });
        else resolve({ ok: false, error: error || stderr.slice(-500) || "lens run produced no result" });
      });
    });
  } finally {
    lensState.running = false;
    lensState.proc = null;
    lensState.startedAt = undefined;
    lensState.model = null;
    if (parked) { try { await ensureServing(parked); } catch { /* next request surfaces it */ } }
  }
}

export type ExperimentRecord = {
  name: string;
  status: "queued" | "running" | "done" | "failed" | "stopped";
  createdAt: number;
  updatedAt: number;
  base: string;
  mode: "raw" | "sft" | "hqq";
  steps: number;
  lr: number;
  targetLoss: number;
  patience?: number;
  valFrac?: number;
  block?: number;
  recipe?: { gradAccum?: number; warmup?: number; cosine?: boolean; balanceSources?: boolean; stageWeightsCpu?: boolean; quantizeCpu?: boolean; lastFullBlockOnly?: boolean; adapterOnly?: boolean; noProbeEmbed?: boolean; valEvery?: number };
  autoBench?: string[];
  dataset: { name: string; sha256: string; bytes: number; rows: number | null } | null;
  model?: string | null;
  specialist?: { role: "coordinator_planner" | "coder_repairer" | "verifier"; runtimeBaseModel: string; datasetManifestHash: string; adapterId?: string; adapterPath?: string };
  error?: string;
};

const experimentPath = (name: string) => path.join(EXPERIMENTS_DIR, name + ".json");

function saveExperiment(record: ExperimentRecord) {
  try { fs.writeFileSync(experimentPath(record.name), JSON.stringify(record, null, 2)); } catch {}
}

function updateExperiment(name: string, patch: Partial<ExperimentRecord>) {
  try {
    const current = JSON.parse(fs.readFileSync(experimentPath(name), "utf8")) as ExperimentRecord;
    saveExperiment({ ...current, ...patch, updatedAt: Date.now() });
  } catch {}
}

export function listExperiments(): ExperimentRecord[] {
  const runs = new Map(listTrainRuns().map((run) => [run.name, run]));
  const out: ExperimentRecord[] = [];
  try {
    for (const file of fs.readdirSync(EXPERIMENTS_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(EXPERIMENTS_DIR, file), "utf8")) as ExperimentRecord;
        const run = runs.get(record.name);
        if (run && run.status !== record.status) record.status = run.status as ExperimentRecord["status"];
        out.push(record);
        runs.delete(record.name);
      } catch {}
    }
  } catch {}
  // Training launched from the CLI predates manifests. Keep it visible rather
  // than presenting the Library as though those runs do not exist.
  for (const run of runs.values()) {
    out.push({
      name: run.name,
      status: run.status as ExperimentRecord["status"],
      createdAt: run.ts,
      updatedAt: run.ts,
      base: "unknown (legacy run)", mode: "raw", steps: run.lastStep, lr: 0, targetLoss: 0,
      dataset: null,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

type SpecialistTrainingRole = "coordinator_planner" | "coder_repairer" | "verifier";
const SPECIALIST_ROLES = new Set<SpecialistTrainingRole>(["coordinator_planner", "coder_repairer", "verifier"]);
// The shared-base hot-swap design (docs/hive-specialist-training.md) assumes every role's
// adapter sits on ONE loaded base for cheap per-request switching — that only holds within
// a base. Training a role on a different base (e.g. mistralai/Ministral-3-8B-Instruct-2512,
// verified compatible 2026-07-12 after stream_quantize_load gained multimodal-wrapper
// unwrapping) means that role can no longer hot-swap with roles still on Qwen3-4B; serving
// it needs a full model swap until the other roles are retrained on the same base too.
const SPECIALIST_BASES: Record<string, string> = {
  "Qwen/Qwen3-4B": "qwen3-4b-stock",
  // NOT "mistralai/Ministral-3-8B-Instruct-2512" — that repo ships natively FP8-quantized
  // (quant_method: fp8, per-layer weight_scale/activation_scale tensors); HQQ training needs
  // real float weights to quantize from. This -BF16 repo is the same architecture, unquantized.
  "mistralai/Ministral-3-8B-Instruct-2512-BF16": "ministral-3-8b-instruct",
};
export const HIVE_ADAPTER_DIR = path.join(MODELS_DIR, "hive-adapters");

function runtimeVersionHash(modelName: string): string | null {
  const info = allModels().find((model) => model.source === "local" && model.name === modelName);
  if (!info) return null;
  try {
    const stat = fs.statSync(info.path);
    return crypto.createHash("sha256").update(`${info.path}:${stat.size}:${stat.mtimeMs}`).digest("hex");
  } catch { return null; }
}

function defaultRuntimeBase(base: string): string | undefined {
  if (base in SPECIALIST_BASES) return SPECIALIST_BASES[base];
  return allModels().find((model) => model.source === "local" && model.name === base)?.name;
}

function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function startTrain(o: { name: string; base: string; steps: number; lr: number; text?: string; targetLoss?: number; patience?: number; mode?: "raw" | "sft" | "hqq"; dataFile?: string; valFrac?: number; block?: number; autoBench?: string[]; snapshotEvery?: number; noProbeEmbed?: boolean; noProbe?: boolean; noEmbed?: boolean; gradAccum?: number; warmup?: number; cosine?: boolean; balanceSources?: boolean; resume?: boolean; stageWeightsCpu?: boolean; quantizeCpu?: boolean; lastFullBlockOnly?: boolean; adapterOnly?: boolean; valEvery?: number; specialistRole?: SpecialistTrainingRole; datasetManifest?: string; runtimeBaseModel?: string }) {
  if (train.running) return { error: "already training: " + train.running };
  if (o.resume && !fs.existsSync(path.join(OUT_DIR, (o.name || "").replace(/[^a-zA-Z0-9_-]/g, "") + "_ckpt", "last"))) {
    return { error: "no checkpoint to resume: " + o.name };
  }
  if (lensState.running) return { error: "GPU is busy: a lens run is in progress. Try again after it finishes." };
  const name = (o.name || "model").replace(/[^a-zA-Z0-9_-]/g, "") || "model";
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const mode = o.mode === "sft" ? "sft" : o.mode === "hqq" ? "hqq" : "raw";
  const specialistRole = o.specialistRole && SPECIALIST_ROLES.has(o.specialistRole) ? o.specialistRole : undefined;
  let specialistManifest: { manifest_hash: string; role: string; dataset_hash: string } | undefined;
  const runtimeBaseModel = o.runtimeBaseModel || defaultRuntimeBase(o.base);
  if (specialistRole) {
    if (mode !== "hqq" || !(o.base in SPECIALIST_BASES)) return { error: "HIVE specialists currently require HQQ training from one of: " + Object.keys(SPECIALIST_BASES).join(", ") };
    if (!runtimeBaseModel || !runtimeVersionHash(runtimeBaseModel)) return { error: "the specialist runtime base GGUF is not installed" };
    const manifestName = path.basename(o.datasetManifest || "").replace(/[^a-zA-Z0-9_.-]/g, "");
    const manifestPath = path.join(DATA_DIR, manifestName);
    try { specialistManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return { error: "specialist training requires a valid dataset manifest in data/" }; }
    if (specialistManifest?.role !== specialistRole || !specialistManifest.manifest_hash || !specialistManifest.dataset_hash) return { error: "dataset manifest role/hash does not match the requested specialist" };
    if (fs.existsSync(path.join(MODELS_DIR, `${name}.hive-adapter.json`)) || fs.existsSync(path.join(HIVE_ADAPTER_DIR, `${name}.gguf`))) return { error: "specialist run name already has an immutable adapter artifact" };
    o.valFrac = o.valFrac && o.valFrac > 0 ? o.valFrac : 0.1;
    o.block = o.block || 1024;
  }
  let dataPath: string;
  if (mode === "sft" || mode === "hqq") {
    // SFT / HQQ train on an EXISTING .jsonl (instruction/thought_process/output)
    const safe = path.basename(o.dataFile || "").replace(/[^a-zA-Z0-9_.-]/g, "");
    dataPath = path.join(DATA_DIR, safe);
    if (!safe.endsWith(".jsonl") || !fs.existsSync(dataPath)) return { error: "data file not found: " + safe };
  } else {
    dataPath = path.join(DATA_DIR, name + ".txt");
    fs.writeFileSync(dataPath, o.text || "");
  }
  const data = datasetInfo(path.basename(dataPath));
  if (specialistManifest && data?.sha256 !== specialistManifest.dataset_hash) return { error: "dataset bytes do not match the immutable specialist manifest" };
  saveExperiment({
    name,
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    base: o.base,
    mode,
    steps: o.steps,
    lr: o.lr,
    targetLoss: o.targetLoss ?? 0.1,
    ...(o.patience != null ? { patience: o.patience } : {}),
    ...(o.valFrac != null ? { valFrac: o.valFrac } : {}),
    ...(o.block != null ? { block: o.block } : {}),
    ...(mode === "hqq" ? { recipe: {
      gradAccum: o.gradAccum, warmup: o.warmup, cosine: !!o.cosine,
      balanceSources: !!o.balanceSources, stageWeightsCpu: !!o.stageWeightsCpu,
      quantizeCpu: !!o.quantizeCpu, lastFullBlockOnly: !!o.lastFullBlockOnly,
      adapterOnly: !!o.adapterOnly, noProbeEmbed: !!o.noProbeEmbed,
      valEvery: o.valEvery,
    } } : {}),
    ...(o.autoBench?.length ? { autoBench: o.autoBench } : {}),
    dataset: data ? { name: data.name, sha256: data.sha256, bytes: data.bytes, rows: data.rows } : null,
    ...(specialistRole && runtimeBaseModel && specialistManifest ? { specialist: { role: specialistRole, runtimeBaseModel, datasetManifestHash: specialistManifest.manifest_hash } } : {}),
  });
  try { srv.proc?.kill("SIGKILL"); } catch {}            // free the GPU (single-tenant)
  try { execSync(`pkill -9 -f "llama-server.*--port ${SERVE_PORT}"`); } catch {}
  srv.proc = null; srv.model = null; srv.loras = []; srv.ctx = 0;
  await unloadOllamaAll(); srv.ollamaModel = null;       // 12B teacher resident -> trainer load = OOM

  // --resume continues an existing run's log, not a fresh one — truncating here
  // would erase the pre-crash step/val history the UI already rendered.
  const ws = fs.createWriteStream(path.join(OUT_DIR, name + ".train.log"), o.resume ? { flags: "a" } : undefined);
  train.running = name; train.ws = ws; train.stopping = false; train.proc = null;

  const script = mode === "hqq" ? FINETUNE_HQQ : mode === "sft" ? FINETUNE_SFT : FINETUNE;
  const args = [script, "--base", o.base, "--data", dataPath,
    "--out", path.join(OUT_DIR, name), "--steps", String(o.steps), "--lr", String(o.lr),
    "--target_loss", String(o.targetLoss ?? 0.1), ...(specialistRole || o.adapterOnly ? [] : ["--merge"])];
  if (o.patience != null) args.push("--patience", String(o.patience));
  if ((mode === "sft" || mode === "hqq") && o.valFrac) args.push("--val_frac", String(o.valFrac));
  if (mode === "hqq" && o.valEvery && o.valEvery > 0) args.push("--val_every", String(o.valEvery));
  if ((mode === "sft" || mode === "hqq") && o.block) args.push("--block", String(o.block));
  if (mode === "hqq" && o.snapshotEvery) args.push("--snapshot_every", String(o.snapshotEvery));
  if (mode === "hqq" && o.noProbeEmbed) args.push("--no_probe_embed");
  if (mode === "hqq" && !o.noProbeEmbed && o.noProbe) args.push("--no_probe");
  if (mode === "hqq" && !o.noProbeEmbed && o.noEmbed) args.push("--no_embed");
  if (mode === "hqq" && o.gradAccum && o.gradAccum > 1) args.push("--grad_accum", String(o.gradAccum));
  if (mode === "hqq" && o.warmup) args.push("--warmup", String(o.warmup));
  if (mode === "hqq" && o.resume) args.push("--resume");
  if (mode === "hqq" && o.cosine) args.push("--cosine");
  if (mode === "hqq" && o.balanceSources) args.push("--balance_sources");
  // Near-ceiling models can keep their frozen embedding / vocabulary projection
  // on CPU. This trades speed for enough VRAM to make a real LoRA smoke test.
  if (mode === "hqq" && o.stageWeightsCpu) args.push("--stage_weights_cpu");
  if (mode === "hqq" && o.quantizeCpu) args.push("--quantize_cpu");
  if (mode === "hqq" && o.lastFullBlockOnly) args.push("--last_full_block_only");

  const runFinetune = (cpu: boolean, done: (code: number | null, errTail: string) => void) => {
    ws.write(JSON.stringify({ event: "phase", phase: cpu ? "fine-tuning (CPU)" : "fine-tuning (GPU)" }) + "\n");
    // SDMA copy engine page-faults on this RDNA2 card (kernel: "Faulty UTCL2 client
    // ID: SDMA0" during layer transfers) — route copies through compute queues instead.
    // expandable_segments avoids the fragmentation-driven OOM victory6-8b hit at step 730
    // (crash reported "6.70 GiB allocated... 408MB reserved but unallocated" — a sudden
    // jump from the ~5.7GB steady-state the periodic step log showed right up to the
    // crash, the classic fragmentation signature PyTorch's own error message names this
    // exact fix for) — lets the allocator grow/shrink segments instead of being stuck
    // with fixed-size blocks it can't reuse across different tensor shapes.
    const env: NodeJS.ProcessEnv = gpuTrainEnv();
    if (cpu) { env.HIP_VISIBLE_DEVICES = ""; env.CUDA_VISIBLE_DEVICES = ""; }
    let errTail = "";
    let stdoutTail = "";
    const ft = spawn(VENV_PY, args, { cwd: ROOT, env });
    train.proc = ft;
    ft.stdout.on("data", (d: Buffer) => {
      const lines = (stdoutTail + d.toString()).split("\n");
      stdoutTail = lines.pop() || "";
      for (const line of lines) if (line.trim().startsWith("{")) ws.write(line + "\n");
    });
    ft.stderr.on("data", (d: Buffer) => { errTail = (errTail + d.toString()).slice(-2000); });
    ft.on("close", (code) => {
      if (stdoutTail.trim().startsWith("{")) ws.write(stdoutTail + "\n");
      if (!train.stopping) done(code, errTail);
    });
  };

  // After conversion the training python has exited (GPU free), so benching can
  // serve the fresh GGUF. Failures per-suite are telemetry, not run failures.
  const autoBench = async (model: string) => {
    for (const suiteName of o.autoBench || []) {
      if (train.stopping) return;
      ws.write(JSON.stringify({ event: "phase", phase: `auto-bench: ${suiteName}` }) + "\n");
      try {
        const stored = getSuite(suiteName);
        const items = stored?.items?.length ? stored.items : SUITES[suiteName];
        if (!items?.length) { ws.write(JSON.stringify({ event: "bench", suite: suiteName, error: "suite not found" }) + "\n"); continue; }
        const opts = { grade: stored?.grade, maxTokens: stored?.maxTokens, think: stored?.think };
        const result = await runBench(model, items, opts);
        saveBench(suiteName, { ...result, suite: suiteName });
        ws.write(JSON.stringify({ event: "bench", suite: suiteName, score: result.score, total: result.total, tokSec: result.tokSec }) + "\n");
      } catch (e) {
        ws.write(JSON.stringify({ event: "bench", suite: suiteName, error: (e as Error).message.slice(0, 200) }) + "\n");
      }
    }
    stopServing(); // leave the GPU free after benching
  };

  const convert = () => {
    ws.write(JSON.stringify({ event: "phase", phase: "converting to GGUF" }) + "\n");
    const gguf = path.join(MODELS_DIR, name + "-f16.gguf");
    const cv = spawn(VENV_PY, [CONVERT, path.join(OUT_DIR, name), "--outfile", gguf, "--outtype", "f16"], { cwd: ROOT });
    train.proc = cv;
    cv.on("close", (c2) => {
      if (train.stopping) return;
      const ok = c2 === 0 && fs.existsSync(gguf);
      const finish = () => {
        ws.write(JSON.stringify({ event: "done", ok, model: ok ? name : null }) + "\n");
        ws.end(); train.running = null; train.proc = null; train.ws = null;
        updateExperiment(name, { status: ok ? "done" : "failed", model: ok ? name : null, ...(ok ? {} : { error: "GGUF conversion failed" }) });
      };
      if (!ok) { finish(); return; }
      // f16 of a 4B is 8GB, of an 8B 16GB — both spill the 8GB card. Quantize to
      // Q4_K_M so serving/benching use a VRAM-resident file (modelFile prefers -q4).
      // Quantize failure is non-fatal: the f16 still serves via the offload ladder.
      ws.write(JSON.stringify({ event: "phase", phase: "quantizing to Q4_K_M" }) + "\n");
      const q4 = path.join(MODELS_DIR, name + "-q4.gguf");
      const qz = spawn(QUANTIZE, [gguf, q4, "Q4_K_M"], { cwd: ROOT, env: { ...process.env, LD_LIBRARY_PATH: LLAMA_DIR } });
      train.proc = qz;
      qz.on("close", (c3) => {
        if (train.stopping) return;
        if (c3 !== 0 || !fs.existsSync(q4)) {
          try { fs.unlinkSync(q4); } catch {}   // never leave a truncated q4 that would out-prefer the f16
          ws.write(JSON.stringify({ event: "phase", phase: "quantize failed — keeping f16" }) + "\n");
        }
        if (o.autoBench?.length) autoBench(name).finally(finish);
        else finish();
      });
    });
  };

  const fail = (err: string) => {
    const last = err.split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0] || "unknown error";
    ws.write(JSON.stringify({ event: "error", msg: last.slice(0, 300) }) + "\n");
    ws.end(); train.running = null; train.proc = null; train.ws = null;
    updateExperiment(name, { status: "failed", error: last.slice(0, 300) });
  };

  const convertSpecialist = () => {
    if (!specialistRole || !runtimeBaseModel || !specialistManifest) { fail("specialist registration metadata disappeared"); return; }
    const adapterSource = path.join(OUT_DIR, name + "_ckpt", "best");
    if (!fs.existsSync(path.join(adapterSource, "adapter_model.safetensors"))) { fail("best validation adapter was not produced"); return; }
    fs.mkdirSync(HIVE_ADAPTER_DIR, { recursive: true });
    const adapterPath = path.join(HIVE_ADAPTER_DIR, `${name}.gguf`);
    ws.write(JSON.stringify({ event: "phase", phase: `converting ${specialistRole} LoRA to GGUF` }) + "\n");
    const cv = spawn(VENV_PY, [CONVERT_LORA, adapterSource, "--outfile", adapterPath, "--outtype", "f16", "--base-model-id", o.base], { cwd: ROOT });
    train.proc = cv;
    let stderr = "";
    cv.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000); });
    cv.on("close", async (code) => {
      if (train.stopping) return;
      if (code !== 0 || !fs.existsSync(adapterPath)) { try { fs.unlinkSync(adapterPath); } catch {} fail(stderr || "LoRA GGUF conversion failed"); return; }
      try {
        const adapterHash = await fileSha256(adapterPath);
        const adapterStat = fs.statSync(adapterPath);
        const baseVersionHash = runtimeVersionHash(runtimeBaseModel);
        if (!baseVersionHash) throw new Error("runtime base changed or disappeared during conversion");
        const adapterId = `${specialistRole}:${name}`;
        const manifest = {
          id: adapterId, role: specialistRole, baseModel: runtimeBaseModel, baseVersionHash, adapterHash, adapterPath, adapterSize: adapterStat.size, adapterMtimeMs: adapterStat.mtimeMs,
          trainingRunId: name, datasetManifestHash: specialistManifest.manifest_hash, promotionStatus: "candidate",
          evaluation: { heldOutRoleImprovementPoints: 0, coreRegressionPoints: 0, schemaTestsPassed: false, toolTestsPassed: false, heldOutTasks: 0, seeds: 0, unauthorizedActions: 0, falseCompletionRate: 1, adapterCompatible: false },
        };
        const manifestPath = path.join(MODELS_DIR, `${name}.hive-adapter.json`);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
        ws.write(JSON.stringify({ event: "specialist", role: specialistRole, adapterId, adapterPath, manifestPath, promotionStatus: "candidate" }) + "\n");
        ws.write(JSON.stringify({ event: "done", ok: true, model: runtimeBaseModel, specialist: adapterId }) + "\n");
        ws.end(); train.running = null; train.proc = null; train.ws = null;
        updateExperiment(name, { status: "done", model: runtimeBaseModel, specialist: { role: specialistRole, runtimeBaseModel, datasetManifestHash: specialistManifest.manifest_hash, adapterId, adapterPath } });
      } catch (error) { fail((error as Error).message); }
    });
  };

  runFinetune(false, (code, err) => {
    if (code === 0) {
      if (specialistRole) { convertSpecialist(); return; }
      if (o.adapterOnly) {
        const adapter = path.join(OUT_DIR, name + "_adapter");
        const ok = fs.existsSync(path.join(adapter, "adapter_model.safetensors"));
        ws.write(JSON.stringify({ event: "done", ok, model: null, adapter: ok ? adapter : null }) + "\n");
        ws.end(); train.running = null; train.proc = null; train.ws = null;
        updateExperiment(name, { status: ok ? "done" : "failed", model: null, ...(ok ? {} : { error: "adapter output missing" }) });
        return;
      }
      convert(); return;
    }
    fail(err || "GPU training failed — check VRAM (training never falls back to CPU)");
  });
  return { started: true, name };
}
