import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Portable owner state and host compatibility boundary. It does not migrate
 * existing checkout-local `.data` callers: they can opt in one seam at a time.
 */
export const HOST_PROFILE_SCHEMA_VERSION = 1 as const;
export type PlatformDirectoryKind = "config" | "data" | "state" | "cache" | "runtime";
export type PlatformDirectories = Record<PlatformDirectoryKind, string>;
export type PlatformDirectoryEnvironment = { platform?: NodeJS.Platform; homedir?: string; tmpdir?: string; env?: Partial<NodeJS.ProcessEnv> };

function nonEmpty(value: string | undefined): string | undefined { return value?.trim() || undefined; }
function homeDirectory(input: PlatformDirectoryEnvironment): string { return nonEmpty(input.homedir) ?? os.homedir(); }
function windowsLocalData(input: PlatformDirectoryEnvironment): string {
  const env = input.env ?? process.env;
  return nonEmpty(env.LOCALAPPDATA) ?? nonEmpty(env.APPDATA) ?? path.join(homeDirectory(input), "AppData", "Local");
}

/** Resolve roots without assuming a checkout, username, or drive letter. */
export function resolvePlatformDirectories(input: PlatformDirectoryEnvironment = {}): PlatformDirectories {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = homeDirectory(input);
  if (platform === "win32") {
    const local = windowsLocalData(input);
    return { config: path.join(local, "Project-LAL"), data: path.join(local, "Project-LAL"), state: path.join(local, "Project-LAL", "State"), cache: path.join(local, "Project-LAL", "Cache"), runtime: path.join(nonEmpty(env.TEMP) ?? nonEmpty(input.tmpdir) ?? os.tmpdir(), "Project-LAL") };
  }
  if (platform === "darwin") {
    const library = path.join(home, "Library");
    return { config: path.join(library, "Application Support", "Project-LAL"), data: path.join(library, "Application Support", "Project-LAL"), state: path.join(library, "Application Support", "Project-LAL", "State"), cache: path.join(library, "Caches", "Project-LAL"), runtime: path.join(nonEmpty(env.TMPDIR) ?? nonEmpty(input.tmpdir) ?? os.tmpdir(), "Project-LAL") };
  }
  return {
    config: path.join(nonEmpty(env.XDG_CONFIG_HOME) ?? path.join(home, ".config"), "project-lal"),
    data: path.join(nonEmpty(env.XDG_DATA_HOME) ?? path.join(home, ".local", "share"), "project-lal"),
    state: path.join(nonEmpty(env.XDG_STATE_HOME) ?? path.join(home, ".local", "state"), "project-lal"),
    cache: path.join(nonEmpty(env.XDG_CACHE_HOME) ?? path.join(home, ".cache"), "project-lal"),
    runtime: path.join(nonEmpty(env.XDG_RUNTIME_DIR) ?? nonEmpty(input.tmpdir) ?? os.tmpdir(), "project-lal"),
  };
}

/** Create private state roots. Native Windows installers remain responsible for ACLs. */
export function ensurePlatformDirectories(directories = resolvePlatformDirectories()): PlatformDirectories {
  for (const directory of Object.values(directories)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") try { fs.chmodSync(directory, 0o700); } catch { /* caller reports write failures */ }
  }
  return directories;
}

export type HostCompatibilityProfile = {
  schemaVersion: typeof HOST_PROFILE_SCHEMA_VERSION;
  id: string;
  paths?: Partial<PlatformDirectories>;
  runtime?: { enabled?: string[]; preferred?: string[] };
  service?: { bind?: "loopback"; port?: number };
  storage?: { quotasMiB?: Partial<Record<"data" | "state" | "cache", number>> };
  resources?: { cpuLimit?: number; memoryMiB?: number; gpuMemoryMiB?: number };
  compatibilityPacks?: string[];
};
export type RecipeRequirements = { schemaVersion: typeof HOST_PROFILE_SCHEMA_VERSION; id: string; requires?: string[]; compatibilityPacks?: string[] };

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], subject: string) { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${subject} has unknown key: ${key}`); }
function nonEmptyString(value: unknown, subject: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${subject} must be a non-empty string`); return value; }
function identifier(value: unknown, subject: string): string { const result = nonEmptyString(value, subject); if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(result)) throw new Error(`${subject} must be an identifier`); return result; }
function stringArray(value: unknown, subject: string): string[] { if (!Array.isArray(value)) throw new Error(`${subject} must be an array`); return value.map((item, index) => identifier(item, `${subject}[${index}]`)); }
function positiveInteger(value: unknown, subject: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${subject} must be a positive integer`); return value; }
function requiredSchemaVersion(value: Record<string, unknown>, subject: string) { if (value.schemaVersion !== HOST_PROFILE_SCHEMA_VERSION) throw new Error(`${subject} schemaVersion must be ${HOST_PROFILE_SCHEMA_VERSION}`); }

/** Strict parsing keeps secrets and arbitrary network exposure out of profiles. */
export function parseHostCompatibilityProfile(raw: unknown): HostCompatibilityProfile {
  if (!isRecord(raw)) throw new Error("host profile must be an object");
  rejectUnknownKeys(raw, ["schemaVersion", "id", "paths", "runtime", "service", "storage", "resources", "compatibilityPacks"], "host profile");
  requiredSchemaVersion(raw, "host profile");
  const profile: HostCompatibilityProfile = { schemaVersion: HOST_PROFILE_SCHEMA_VERSION, id: identifier(raw.id, "host profile id") };
  if (raw.paths !== undefined) {
    if (!isRecord(raw.paths)) throw new Error("host profile paths must be an object");
    rejectUnknownKeys(raw.paths, ["config", "data", "state", "cache", "runtime"], "host profile paths");
    profile.paths = Object.fromEntries(Object.entries(raw.paths).map(([key, value]) => [key, nonEmptyString(value, `host profile paths.${key}`)])) as Partial<PlatformDirectories>;
  }
  if (raw.runtime !== undefined) {
    if (!isRecord(raw.runtime)) throw new Error("host profile runtime must be an object");
    rejectUnknownKeys(raw.runtime, ["enabled", "preferred"], "host profile runtime");
    profile.runtime = { ...(raw.runtime.enabled === undefined ? {} : { enabled: stringArray(raw.runtime.enabled, "host profile runtime.enabled") }), ...(raw.runtime.preferred === undefined ? {} : { preferred: stringArray(raw.runtime.preferred, "host profile runtime.preferred") }) };
  }
  if (raw.service !== undefined) {
    if (!isRecord(raw.service)) throw new Error("host profile service must be an object");
    rejectUnknownKeys(raw.service, ["bind", "port"], "host profile service");
    if (raw.service.bind !== undefined && raw.service.bind !== "loopback") throw new Error("host profile service.bind must be loopback");
    const port = raw.service.port === undefined ? undefined : positiveInteger(raw.service.port, "host profile service.port");
    if (port && port > 65535) throw new Error("host profile service.port must be <= 65535");
    profile.service = { ...(raw.service.bind === undefined ? {} : { bind: "loopback" }), ...(port === undefined ? {} : { port }) };
  }
  if (raw.storage !== undefined) {
    if (!isRecord(raw.storage)) throw new Error("host profile storage must be an object");
    rejectUnknownKeys(raw.storage, ["quotasMiB"], "host profile storage");
    if (raw.storage.quotasMiB !== undefined) {
      if (!isRecord(raw.storage.quotasMiB)) throw new Error("host profile storage.quotasMiB must be an object");
      rejectUnknownKeys(raw.storage.quotasMiB, ["data", "state", "cache"], "host profile storage.quotasMiB");
      profile.storage = { quotasMiB: Object.fromEntries(Object.entries(raw.storage.quotasMiB).map(([key, value]) => [key, positiveInteger(value, `host profile storage.quotasMiB.${key}`)])) };
    } else profile.storage = {};
  }
  if (raw.resources !== undefined) {
    if (!isRecord(raw.resources)) throw new Error("host profile resources must be an object");
    rejectUnknownKeys(raw.resources, ["cpuLimit", "memoryMiB", "gpuMemoryMiB"], "host profile resources");
    profile.resources = Object.fromEntries(Object.entries(raw.resources).map(([key, value]) => [key, positiveInteger(value, `host profile resources.${key}`)])) as HostCompatibilityProfile["resources"];
  }
  if (raw.compatibilityPacks !== undefined) profile.compatibilityPacks = stringArray(raw.compatibilityPacks, "host profile compatibilityPacks");
  return Object.freeze(profile);
}

export function parseRecipeRequirements(raw: unknown): RecipeRequirements {
  if (!isRecord(raw)) throw new Error("recipe requirements must be an object");
  rejectUnknownKeys(raw, ["schemaVersion", "id", "requires", "compatibilityPacks"], "recipe requirements");
  requiredSchemaVersion(raw, "recipe requirements");
  return Object.freeze({ schemaVersion: HOST_PROFILE_SCHEMA_VERSION, id: identifier(raw.id, "recipe requirements id"), ...(raw.requires === undefined ? {} : { requires: stringArray(raw.requires, "recipe requirements requires") }), ...(raw.compatibilityPacks === undefined ? {} : { compatibilityPacks: stringArray(raw.compatibilityPacks, "recipe requirements compatibilityPacks") }) });
}

export type RedactedHostFacts = {
  schemaVersion: typeof HOST_PROFILE_SCHEMA_VERSION; collectedAt: string; platform: NodeJS.Platform; arch: string; nodeMajor: number | null; logicalCpuCount: number; totalMemoryMiB: number;
  commands: Record<"ollama" | "llama-server" | "ffmpeg" | "git" | "python" | "systemctl" | "tailscale", boolean>;
  directories: Record<PlatformDirectoryKind, "resolved">;
};
export type FactCollectionOptions = PlatformDirectoryEnvironment & { now?: () => Date; commandAvailable?: (name: string) => boolean; cpus?: number; totalMemoryBytes?: number };
export function isCommandAvailable(name: string, env: Partial<NodeJS.ProcessEnv> = process.env): boolean { return (env.PATH?.split(path.delimiter) ?? []).some((directory) => { try { return fs.statSync(path.join(directory, name)).isFile(); } catch { return false; } }); }

/** Facts include no usernames, paths, environment values, tokens, or command output. */
export function collectRedactedHostFacts(input: FactCollectionOptions = {}): RedactedHostFacts {
  const directories = resolvePlatformDirectories(input);
  const available = input.commandAvailable ?? ((name: string) => isCommandAvailable(name, input.env ?? process.env));
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  return Object.freeze({
    schemaVersion: HOST_PROFILE_SCHEMA_VERSION, collectedAt: (input.now ?? (() => new Date()))().toISOString(), platform: input.platform ?? process.platform, arch: process.arch,
    nodeMajor: Number.isSafeInteger(nodeMajor) ? nodeMajor : null, logicalCpuCount: input.cpus ?? os.cpus().length, totalMemoryMiB: Math.floor((input.totalMemoryBytes ?? os.totalmem()) / (1024 * 1024)),
    commands: Object.fromEntries(["ollama", "llama-server", "ffmpeg", "git", "python", "systemctl", "tailscale"].map((name) => [name, available(name)])) as RedactedHostFacts["commands"],
    directories: Object.fromEntries(Object.keys(directories).map((kind) => [kind, "resolved"])) as RedactedHostFacts["directories"],
  });
}

export function writeRedactedDiagnostic(file: string, facts = collectRedactedHostFacts()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(facts, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") try { fs.chmodSync(file, 0o600); } catch { /* filesystem may not support POSIX modes */ }
}
