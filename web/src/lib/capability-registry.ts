/**
 * The capability registry is deliberately a read-only inventory in its first
 * release.  Discovery may observe bytes already owned by the operator, but it
 * never downloads, moves, deletes, or activates them.  Artifact IDs are
 * content hashes; display names remain compatibility aliases only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ModelProfile } from "./hive/contracts";

export const CAPABILITY_REGISTRY_SCHEMA_VERSION = 1 as const;
export const CAPABILITY_REGISTRY_API_VERSION = "v1" as const;

export type RegistryArtifact = {
  id: `artifact:sha256:${string}`;
  sha256: string;
  kind: "model" | "adapter";
  format: "gguf" | "ollama-blob" | "unknown";
  sizeBytes: number;
  observedAt: string;
};

export type RegistryRuntime = {
  id: `runtime:sha256:${string}`;
  artifactId: RegistryArtifact["id"];
  backend: "llama.cpp" | "ollama";
  source: "local" | "ollama" | "hive";
  profileId?: string;
  contextCeiling?: number;
  versionHash?: string;
};

export type RegistryModel = {
  id: `model:sha256:${string}`;
  artifactId: RegistryArtifact["id"];
  runtimeIds: RegistryRuntime["id"][];
  aliases: string[];
  displayName: string;
  installed: true;
};

export type CapabilityRegistrySnapshot = {
  schemaVersion: typeof CAPABILITY_REGISTRY_SCHEMA_VERSION;
  apiVersion: typeof CAPABILITY_REGISTRY_API_VERSION;
  generatedAt: string;
  artifacts: RegistryArtifact[];
  runtimes: RegistryRuntime[];
  models: RegistryModel[];
};

export type RegistryInventoryItem = {
  name: string;
  source: "local" | "ollama";
  path: string;
  sizeBytes?: number;
  /** An Ollama blob's content digest, if a manifest scanner supplied it. */
  digest?: string;
};

type PersistedRegistry = CapabilityRegistrySnapshot;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function isSha256(value: string | undefined): value is string { return !!value && /^[a-f0-9]{64}$/i.test(value); }

export async function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function modelId(artifactId: RegistryArtifact["id"]): RegistryModel["id"] { return `model:sha256:${sha256(artifactId)}`; }
function runtimeId(value: Omit<RegistryRuntime, "id">): RegistryRuntime["id"] { return `runtime:sha256:${sha256(canonical(value))}`; }
function normalizeAlias(source: RegistryInventoryItem["source"], name: string): string { return `${source}:${name}`; }

function profileMatches(item: RegistryInventoryItem, profile: ModelProfile): boolean {
  return (profile.provider === "ollama" ? "ollama" : "local") === item.source && profile.model === item.name;
}

/** Build a deterministic snapshot from already-present bytes and HIVE profiles. */
export async function buildCapabilityRegistrySnapshot(
  inventory: RegistryInventoryItem[],
  profiles: ModelProfile[] = [],
  generatedAt = new Date().toISOString(),
): Promise<CapabilityRegistrySnapshot> {
  const artifacts = new Map<string, RegistryArtifact>();
  const runtimes = new Map<string, RegistryRuntime>();
  const models = new Map<string, RegistryModel>();

  for (const item of [...inventory].sort((left, right) => `${left.source}:${left.name}`.localeCompare(`${right.source}:${right.name}`))) {
    const digest = isSha256(item.digest) ? item.digest.toLowerCase() : await hashFile(item.path);
    const artifactId = `artifact:sha256:${digest}` as const;
    const sizeBytes = item.sizeBytes ?? fs.statSync(item.path).size;
    const artifact: RegistryArtifact = {
      id: artifactId, sha256: digest, kind: "model", format: item.source === "ollama" ? "ollama-blob" : "gguf", sizeBytes, observedAt: generatedAt,
    };
    artifacts.set(artifactId, artifact);

    const matchingProfiles = profiles.filter((profile) => profileMatches(item, profile));
    const runtimeInputs: Omit<RegistryRuntime, "id">[] = matchingProfiles.length
      ? matchingProfiles.map((profile) => ({ artifactId, backend: profile.provider, source: "hive", profileId: profile.id, contextCeiling: profile.contextCeiling, versionHash: profile.versionHash }))
      : [{ artifactId, backend: item.source === "ollama" ? "ollama" : "llama.cpp", source: item.source }];
    const runtimeIds: RegistryRuntime["id"][] = [];
    for (const input of runtimeInputs) {
      const id = runtimeId(input);
      runtimes.set(id, { id, ...input });
      runtimeIds.push(id);
    }
    const id = modelId(artifactId);
    const previous = models.get(id);
    const aliases = [...new Set([...(previous?.aliases ?? []), normalizeAlias(item.source, item.name)])].sort();
    models.set(id, { id, artifactId, runtimeIds: [...new Set([...(previous?.runtimeIds ?? []), ...runtimeIds])].sort(), aliases, displayName: previous?.displayName ?? item.name, installed: true });
  }
  return {
    schemaVersion: CAPABILITY_REGISTRY_SCHEMA_VERSION,
    apiVersion: CAPABILITY_REGISTRY_API_VERSION,
    generatedAt,
    artifacts: [...artifacts.values()].sort((left, right) => left.id.localeCompare(right.id)),
    runtimes: [...runtimes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    models: [...models.values()].sort((left, right) => left.displayName.localeCompare(right.displayName)),
  };
}

/** Read-only source inventory. `allModels` only observes existing GGUF/Ollama files. */
/**
 * A tiny atomic repository keeps the last complete catalog available between
 * process restarts.  `refresh` is the only writer and only records read-only
 * observations; callers cannot use it to install or mutate model bytes.
 */
export class CapabilityRegistryRepository {
  private readonly file: string;
  constructor(file: string) { this.file = file; }

  read(): PersistedRegistry | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as PersistedRegistry;
      if (raw.schemaVersion !== CAPABILITY_REGISTRY_SCHEMA_VERSION || raw.apiVersion !== CAPABILITY_REGISTRY_API_VERSION || !Array.isArray(raw.artifacts) || !Array.isArray(raw.runtimes) || !Array.isArray(raw.models)) return null;
      return raw;
    } catch { return null; }
  }

  async refresh(inventory: RegistryInventoryItem[], profiles: ModelProfile[] = []): Promise<CapabilityRegistrySnapshot> {
    const snapshot = await buildCapabilityRegistrySnapshot(inventory, profiles);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.file);
    if (process.platform !== "win32") try { fs.chmodSync(this.file, 0o600); } catch { /* best effort on filesystems without modes */ }
    return snapshot;
  }
}

/** Compatibility lookup for old source:name selectors during the migration. */
export function findCatalogModel(snapshot: CapabilityRegistrySnapshot, alias: string): RegistryModel | undefined {
  return snapshot.models.find((model) => model.aliases.includes(alias));
}
