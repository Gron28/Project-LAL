/**
 * Slice 5's acquisition boundary deliberately has no HTTP client. Provider
 * discovery is supplied as a signed/offline catalog and byte transfer is a
 * separate, explicitly-authorized adapter concern. This module plans and
 * verifies files; it never contacts Hugging Face, Ollama, or an arbitrary URL.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MODEL_ACQUISITION_PROTOCOL_VERSION = 1 as const;
export type AcquisitionProvider = "huggingface" | "ollama";
export type ProviderAvailability = "available" | "offline" | "unconfigured";
export type ModelLicense = { spdx?: string; name: string; requiresAcceptance: boolean; redistributable: boolean };
export type ModelFile = { path: string; sizeBytes: number; sha256: string };
export type CatalogModel = { provider: AcquisitionProvider; id: string; revision: string; displayName: string; license: ModelLicense; parameterCountBillion?: number; files: ModelFile[]; capabilities: string[] };
export type OfflineCatalog = { protocolVersion: 1; generatedAt: string; providers: Record<AcquisitionProvider, ProviderAvailability>; models: CatalogModel[] };
export type HardwareEstimate = { availableDiskBytes: number; availableRamBytes: number; availableVramBytes?: number };
export type ResolutionRequest = { provider: AcquisitionProvider; id: string; revision?: string; acceptedLicense?: boolean; preferredFile?: string };
export type ResolutionPlan = { protocolVersion: 1; id: `acquisition-plan:sha256:${string}`; provider: AcquisitionProvider; modelId: string; revision: string; license: ModelLicense; file: ModelFile; requiredDiskBytes: number; estimatedRuntimeRamBytes: number; estimatedRuntimeVramBytes?: number; requiresLicenseAcceptance: boolean; transport: "external-authorized-adapter" };
export type ResolutionResult = { state: "ready"; plan: ResolutionPlan } | { state: "unavailable"; reason: "offline" | "unconfigured" | "not_found" | "revision_not_found" | "license_not_accepted" | "insufficient_disk" | "insufficient_memory"; detail: string };
export type ImportState = "planned" | "partial" | "cancel_requested" | "cancelled" | "verified" | "failed";
export type ImportRecord = { protocolVersion: 1; id: string; plan: ResolutionPlan; state: ImportState; receivedBytes: number; createdAt: string; updatedAt: string; error?: string; artifactPath?: string };

const SHA256 = /^[a-f0-9]{64}$/i;
const identifier = /^[a-z0-9][a-z0-9._:/@-]{0,255}$/i;
function digest(value: string | Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a, b], [c, d]) => a.localeCompare(c)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
function safeName(value: string, subject: string): string { if (!identifier.test(value) || value.includes("..")) throw new Error(`${subject} must be a stable identifier`); return value; }
function safeFile(file: ModelFile): ModelFile { if (!file.path || path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..")) throw new Error("catalog file path must be relative and contained"); if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) throw new Error("catalog file size must be positive"); if (!SHA256.test(file.sha256)) throw new Error("catalog file digest must be sha256"); return { ...file, sha256: file.sha256.toLowerCase() }; }

/** Validate catalog data supplied by an offline mirror or separately audited adapter. */
export function validateOfflineCatalog(raw: OfflineCatalog): OfflineCatalog {
  if (raw.protocolVersion !== MODEL_ACQUISITION_PROTOCOL_VERSION) throw new Error("unsupported acquisition catalog protocol");
  if (!raw.generatedAt || !Number.isFinite(Date.parse(raw.generatedAt))) throw new Error("catalog generatedAt must be ISO time");
  for (const provider of ["huggingface", "ollama"] as const) if (!(["available", "offline", "unconfigured"] as string[]).includes(raw.providers?.[provider])) throw new Error(`invalid ${provider} availability`);
  const seen = new Set<string>();
  const models = raw.models.map((model) => { safeName(model.id, "catalog model id"); safeName(model.revision, "catalog revision"); if (!(["huggingface", "ollama"] as string[]).includes(model.provider) || !model.displayName.trim()) throw new Error("invalid catalog model"); if (!model.files.length) throw new Error("catalog model needs at least one file"); const key = `${model.provider}:${model.id}@${model.revision}`; if (seen.has(key)) throw new Error(`duplicate catalog model: ${key}`); seen.add(key); return { ...model, files: model.files.map(safeFile), capabilities: [...new Set(model.capabilities)].sort() }; });
  return Object.freeze({ protocolVersion: 1, generatedAt: raw.generatedAt, providers: { ...raw.providers }, models });
}

/** Build a deterministic, non-network resolution plan with explicit license and host checks. */
export function resolveModelAcquisition(catalogInput: OfflineCatalog, request: ResolutionRequest, host: HardwareEstimate): ResolutionResult {
  const catalog = validateOfflineCatalog(catalogInput), availability = catalog.providers[request.provider];
  if (availability === "offline") return { state: "unavailable", reason: "offline", detail: `${request.provider} metadata is offline; no network fallback is attempted` };
  if (availability === "unconfigured") return { state: "unavailable", reason: "unconfigured", detail: `${request.provider} has no authorized metadata adapter` };
  const candidates = catalog.models.filter((model) => model.provider === request.provider && model.id === request.id);
  if (!candidates.length) return { state: "unavailable", reason: "not_found", detail: "model is absent from the approved offline catalog" };
  const model = request.revision ? candidates.find((item) => item.revision === request.revision) : candidates[0];
  if (!model) return { state: "unavailable", reason: "revision_not_found", detail: "requested revision is absent from the approved offline catalog" };
  if (model.license.requiresAcceptance && !request.acceptedLicense) return { state: "unavailable", reason: "license_not_accepted", detail: `license acceptance is required: ${model.license.name}` };
  const file = request.preferredFile ? model.files.find((item) => item.path === request.preferredFile) : model.files[0]; if (!file) throw new Error("preferred file is absent from catalog"); safeFile(file);
  const requiredDiskBytes = Math.ceil(file.sizeBytes * 1.15), estimatedRuntimeRamBytes = Math.ceil(file.sizeBytes * 1.2), estimatedRuntimeVramBytes = model.parameterCountBillion ? Math.ceil(model.parameterCountBillion * 0.75 * 1_000_000_000) : undefined;
  if (!Number.isSafeInteger(host.availableDiskBytes) || host.availableDiskBytes < requiredDiskBytes) return { state: "unavailable", reason: "insufficient_disk", detail: `requires ${requiredDiskBytes} bytes of free disk` };
  if (!Number.isSafeInteger(host.availableRamBytes) || host.availableRamBytes < estimatedRuntimeRamBytes) return { state: "unavailable", reason: "insufficient_memory", detail: `requires ${estimatedRuntimeRamBytes} bytes of RAM estimate` };
  if (estimatedRuntimeVramBytes && host.availableVramBytes !== undefined && host.availableVramBytes < estimatedRuntimeVramBytes) return { state: "unavailable", reason: "insufficient_memory", detail: `requires ${estimatedRuntimeVramBytes} bytes of VRAM estimate` };
  const planValue = { provider: model.provider, modelId: model.id, revision: model.revision, file, license: model.license, requiredDiskBytes, estimatedRuntimeRamBytes, estimatedRuntimeVramBytes };
  return { state: "ready", plan: { protocolVersion: 1, id: `acquisition-plan:sha256:${digest(canonical(planValue))}`, ...planValue, requiresLicenseAcceptance: model.license.requiresAcceptance, transport: "external-authorized-adapter" } };
}

/** A local staging state machine; append receives bytes from an authorized transport only. */
export class VerifiedModelImportStore {
  private readonly records: string; private readonly staging: string; private readonly artifacts: string; private readonly now: () => Date;
  constructor(root: string, options: { now?: () => Date } = {}) { if (!path.isAbsolute(root)) throw new Error("model import root must be absolute"); this.records = path.join(root, "records"); this.staging = path.join(root, "staging"); this.artifacts = path.join(root, "artifacts"); this.now = options.now ?? (() => new Date()); for (const directory of [this.records, this.staging, this.artifacts]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  private file(id: string) { return path.join(this.records, `${safeName(id, "import id")}.json`); }
  private part(id: string) { return path.join(this.staging, `${safeName(id, "import id")}.part`); }
  private write(record: ImportRecord) { const file = this.file(record.id), temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temp, file); }
  read(id: string): ImportRecord | null { try { return JSON.parse(fs.readFileSync(this.file(id), "utf8")) as ImportRecord; } catch { return null; } }
  begin(id: string, plan: ResolutionPlan, availableDiskBytes: number): ImportRecord { safeName(id, "import id"); if (this.read(id)) throw new Error("import already exists"); if (!Number.isSafeInteger(availableDiskBytes) || availableDiskBytes < plan.requiredDiskBytes) throw new Error("disk preflight failed"); const at = this.now().toISOString(), record: ImportRecord = { protocolVersion: 1, id, plan, state: "planned", receivedBytes: 0, createdAt: at, updatedAt: at }; this.write(record); return record; }
  append(id: string, chunk: Buffer): ImportRecord { const record = this.read(id); if (!record || !["planned", "partial"].includes(record.state)) throw new Error("import is not writable"); if (!Buffer.isBuffer(chunk) || !chunk.length) throw new Error("import chunk must be non-empty bytes"); if (record.receivedBytes + chunk.length > record.plan.file.sizeBytes) throw new Error("import exceeds planned size"); fs.appendFileSync(this.part(id), chunk, { mode: 0o600 }); record.receivedBytes += chunk.length; record.state = "partial"; record.updatedAt = this.now().toISOString(); this.write(record); return record; }
  requestCancel(id: string): ImportRecord { const record = this.read(id); if (!record || !["planned", "partial"].includes(record.state)) throw new Error("import is not cancellable"); record.state = "cancel_requested"; record.updatedAt = this.now().toISOString(); this.write(record); return record; }
  settleCancel(id: string): ImportRecord { const record = this.read(id); if (!record || record.state !== "cancel_requested") throw new Error("cancellation was not requested"); try { fs.unlinkSync(this.part(id)); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } record.state = "cancelled"; record.updatedAt = this.now().toISOString(); this.write(record); return record; }
  verify(id: string): ImportRecord { const record = this.read(id); if (!record || !["planned", "partial"].includes(record.state)) throw new Error("import is not verifiable"); const part = this.part(id); let actual: Buffer; try { actual = fs.readFileSync(part); } catch { record.state = "failed"; record.error = "staged bytes are missing"; record.updatedAt = this.now().toISOString(); this.write(record); return record; } if (actual.length !== record.plan.file.sizeBytes || digest(actual) !== record.plan.file.sha256) { record.state = "failed"; record.error = "staged bytes do not match planned size and sha256"; record.updatedAt = this.now().toISOString(); this.write(record); return record; } const artifact = path.join(this.artifacts, `sha256-${record.plan.file.sha256}`); fs.renameSync(part, artifact); record.state = "verified"; record.artifactPath = artifact; record.updatedAt = this.now().toISOString(); this.write(record); return record; }
}
