import fs from "node:fs";
import path from "node:path";

import {
  HOST_PROFILE_SCHEMA_VERSION,
  type HostCompatibilityProfile,
  type PlatformDirectories,
  parseHostCompatibilityProfile,
  resolvePlatformDirectories,
} from "./host-profile.ts";

/**
 * The only host-facing contracts shared domain code may depend on.  Concrete
 * adapters live at the platform edge and report `unknown`/`unsupported`
 * instead of guessing a successful result.
 */
export const HOST_ADAPTER_CONCERNS = [
  "process", "service", "monitor", "runtime", "network", "desktop",
  "workspace", "client-distribution", "training",
] as const;
export type HostAdapterConcern = typeof HOST_ADAPTER_CONCERNS[number];
export type AdapterSupport = "supported" | "unsupported" | "unknown";
export type AdapterResult<T> =
  | Readonly<{ status: "supported"; value: T }>
  | Readonly<{ status: "unsupported" | "unknown"; reason: string }>;

export type ProcessAdapter = Readonly<{
  id: string; concern: "process";
  inspect(input: { pid: number }): AdapterResult<{ pid: number; owned: boolean; healthy: boolean }>;
  stop(input: { pid: number; force?: boolean }): AdapterResult<{ stopped: boolean }>;
}>;
export type ServiceAdapter = Readonly<{
  id: string; concern: "service";
  status(input: { name: string }): AdapterResult<{ active: boolean; detail?: string }>;
  control(input: { name: string; action: "start" | "stop" | "restart" }): AdapterResult<{ accepted: boolean }>;
}>;
export type MonitorAdapter = Readonly<{
  id: string; concern: "monitor";
  observe(): AdapterResult<{ cpuPercent?: number; memoryMiB?: number; gpu?: readonly { name?: string; vramMiB?: number; temperatureC?: number }[]; storageBytes?: number }>;
}>;
export type RuntimeAdapter = Readonly<{
  id: string; concern: "runtime";
  probe(): AdapterResult<{ runtimes: readonly string[] }>;
  load(input: { artifactId: string }): AdapterResult<{ handle: string }>;
  unload(input: { handle: string }): AdapterResult<{ unloaded: boolean }>;
}>;
export type NetworkAdapter = Readonly<{
  id: string; concern: "network";
  exposure(): AdapterResult<{ bind: "loopback"; remoteAccess: "disabled" | "authenticated"; identityEvidence: boolean }>;
}>;
export type DesktopAdapter = Readonly<{
  id: string; concern: "desktop";
  installLauncher(): AdapterResult<{ installed: boolean }>;
  openUrl(input: { url: string }): AdapterResult<{ opened: boolean }>;
}>;
export type WorkspaceAdapter = Readonly<{
  id: string; concern: "workspace";
  inspectSandbox(): AdapterResult<{ available: boolean; capability: "none" | "read-only" | "isolated" }>;
}>;
export type ClientDistributionAdapter = Readonly<{
  id: string; concern: "client-distribution";
  buildManifest(): AdapterResult<{ manifestId: string; checksum: string }>;
}>;
export type TrainingAdapter = Readonly<{
  id: string; concern: "training";
  probe(): AdapterResult<{ capabilities: readonly string[] }>;
  checkpoint(input: { runId: string }): AdapterResult<{ checkpointId: string }>;
}>;
export type HostAdapter = ProcessAdapter | ServiceAdapter | MonitorAdapter | RuntimeAdapter | NetworkAdapter | DesktopAdapter | WorkspaceAdapter | ClientDistributionAdapter | TrainingAdapter;

export type HostAdapterRegistry = Readonly<Record<HostAdapterConcern, readonly string[]>>;
export const EMPTY_HOST_ADAPTER_REGISTRY: HostAdapterRegistry = Object.freeze({
  process: [], service: [], monitor: [], runtime: [], network: [], desktop: [], workspace: [], "client-distribution": [], training: [],
});

type PlainRecord = Record<string, unknown>;
function isRecord(value: unknown): value is PlainRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function rejectUnknownKeys(value: PlainRecord, allowed: readonly string[], subject: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${subject} has unknown key: ${key}`); }
function identifier(value: unknown, subject: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)) throw new Error(`${subject} must be a public adapter identifier`);
  return value;
}
function nonEmptyString(value: unknown, subject: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${subject} must be a non-empty string`); return value; }
function positiveInteger(value: unknown, subject: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${subject} must be a positive integer`); return value; }
function stringArray(value: unknown, subject: string): string[] { if (!Array.isArray(value)) throw new Error(`${subject} must be an array`); return value.map((item, index) => identifier(item, `${subject}[${index}]`)); }
function partialDirectories(value: unknown, subject: string): Partial<PlatformDirectories> {
  if (!isRecord(value)) throw new Error(`${subject} must be an object`);
  const keys = ["config", "data", "state", "cache", "runtime"] as const;
  rejectUnknownKeys(value, keys, subject);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, nonEmptyString(entry, `${subject}.${key}`)])) as Partial<PlatformDirectories>;
}

export type CompatibilityCapsule = Readonly<{
  schemaVersion: typeof HOST_PROFILE_SCHEMA_VERSION;
  id: string;
  generatedAt: string;
  adapters: Readonly<Record<HostAdapterConcern, string>>;
  paths?: Readonly<Partial<PlatformDirectories>>;
  executables?: Readonly<Record<string, string>>;
  service?: Readonly<{ bind: "loopback"; port?: number }>;
  network?: Readonly<{ remoteExposure: "disabled" | "tailscale-serve"; identityAdapter?: string }>;
  desktop?: Readonly<{ adapter: string; openUrl?: boolean }>;
  resourceLimits?: Readonly<{ cpuLimit?: number; memoryMiB?: number; gpuMemoryMiB?: number }>;
  compatibilityPacks?: readonly string[];
  probeEvidence?: readonly Readonly<{ adapterId: string; status: AdapterSupport; observedAt: string }>[];
}>;

/** Parse an external current-host capsule. It deliberately has no secrets or source modifications field. */
export function parseCompatibilityCapsule(raw: unknown): CompatibilityCapsule {
  if (!isRecord(raw)) throw new Error("compatibility capsule must be an object");
  rejectUnknownKeys(raw, ["schemaVersion", "id", "generatedAt", "adapters", "paths", "executables", "service", "network", "desktop", "resourceLimits", "compatibilityPacks", "probeEvidence"], "compatibility capsule");
  if (raw.schemaVersion !== HOST_PROFILE_SCHEMA_VERSION) throw new Error(`compatibility capsule schemaVersion must be ${HOST_PROFILE_SCHEMA_VERSION}`);
  const rawAdapters = raw.adapters;
  if (!isRecord(rawAdapters)) throw new Error("compatibility capsule adapters must be an object");
  rejectUnknownKeys(rawAdapters, HOST_ADAPTER_CONCERNS, "compatibility capsule adapters");
  const adapters = Object.fromEntries(HOST_ADAPTER_CONCERNS.map((concern) => [concern, identifier(rawAdapters[concern], `compatibility capsule adapters.${concern}`)])) as Record<HostAdapterConcern, string>;
  const capsule: { -readonly [Key in keyof CompatibilityCapsule]: CompatibilityCapsule[Key] } = { schemaVersion: HOST_PROFILE_SCHEMA_VERSION, id: identifier(raw.id, "compatibility capsule id"), generatedAt: nonEmptyString(raw.generatedAt, "compatibility capsule generatedAt"), adapters };
  if (Number.isNaN(Date.parse(capsule.generatedAt))) throw new Error("compatibility capsule generatedAt must be an ISO timestamp");
  if (raw.paths !== undefined) capsule.paths = partialDirectories(raw.paths, "compatibility capsule paths");
  if (raw.executables !== undefined) {
    if (!isRecord(raw.executables)) throw new Error("compatibility capsule executables must be an object");
    capsule.executables = Object.fromEntries(Object.entries(raw.executables).map(([key, value]) => [identifier(key, "compatibility capsule executable id"), nonEmptyString(value, `compatibility capsule executables.${key}`)]));
  }
  if (raw.service !== undefined) {
    if (!isRecord(raw.service)) throw new Error("compatibility capsule service must be an object");
    rejectUnknownKeys(raw.service, ["bind", "port"], "compatibility capsule service");
    if (raw.service.bind !== "loopback") throw new Error("compatibility capsule service.bind must be loopback");
    const port = raw.service.port === undefined ? undefined : positiveInteger(raw.service.port, "compatibility capsule service.port");
    if (port !== undefined && port > 65535) throw new Error("compatibility capsule service.port must be <= 65535");
    capsule.service = { bind: "loopback", ...(port === undefined ? {} : { port }) };
  }
  if (raw.network !== undefined) {
    if (!isRecord(raw.network)) throw new Error("compatibility capsule network must be an object");
    rejectUnknownKeys(raw.network, ["remoteExposure", "identityAdapter"], "compatibility capsule network");
    if (raw.network.remoteExposure !== "disabled" && raw.network.remoteExposure !== "tailscale-serve") throw new Error("compatibility capsule network.remoteExposure is invalid");
    capsule.network = { remoteExposure: raw.network.remoteExposure, ...(raw.network.identityAdapter === undefined ? {} : { identityAdapter: identifier(raw.network.identityAdapter, "compatibility capsule network.identityAdapter") }) };
  }
  if (raw.desktop !== undefined) {
    if (!isRecord(raw.desktop)) throw new Error("compatibility capsule desktop must be an object");
    rejectUnknownKeys(raw.desktop, ["adapter", "openUrl"], "compatibility capsule desktop");
    if (raw.desktop.openUrl !== undefined && typeof raw.desktop.openUrl !== "boolean") throw new Error("compatibility capsule desktop.openUrl must be a boolean");
    capsule.desktop = { adapter: identifier(raw.desktop.adapter, "compatibility capsule desktop.adapter"), ...(raw.desktop.openUrl === undefined ? {} : { openUrl: raw.desktop.openUrl }) };
  }
  if (raw.resourceLimits !== undefined) {
    if (!isRecord(raw.resourceLimits)) throw new Error("compatibility capsule resourceLimits must be an object");
    rejectUnknownKeys(raw.resourceLimits, ["cpuLimit", "memoryMiB", "gpuMemoryMiB"], "compatibility capsule resourceLimits");
    capsule.resourceLimits = Object.fromEntries(Object.entries(raw.resourceLimits).map(([key, value]) => [key, positiveInteger(value, `compatibility capsule resourceLimits.${key}`)]));
  }
  if (raw.compatibilityPacks !== undefined) capsule.compatibilityPacks = stringArray(raw.compatibilityPacks, "compatibility capsule compatibilityPacks");
  if (raw.probeEvidence !== undefined) {
    if (!Array.isArray(raw.probeEvidence)) throw new Error("compatibility capsule probeEvidence must be an array");
    capsule.probeEvidence = raw.probeEvidence.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`compatibility capsule probeEvidence[${index}] must be an object`);
      rejectUnknownKeys(entry, ["adapterId", "status", "observedAt"], `compatibility capsule probeEvidence[${index}]`);
      if (entry.status !== "supported" && entry.status !== "unsupported" && entry.status !== "unknown") throw new Error(`compatibility capsule probeEvidence[${index}].status is invalid`);
      const observedAt = nonEmptyString(entry.observedAt, `compatibility capsule probeEvidence[${index}].observedAt`);
      if (Number.isNaN(Date.parse(observedAt))) throw new Error(`compatibility capsule probeEvidence[${index}].observedAt must be an ISO timestamp`);
      return Object.freeze({ adapterId: identifier(entry.adapterId, `compatibility capsule probeEvidence[${index}].adapterId`), status: entry.status, observedAt });
    });
  }
  return Object.freeze(capsule);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/** Load only from the owner configuration root, never from a checkout-controlled path. */
export function loadCompatibilityCapsule(file: string, directories = resolvePlatformDirectories()): CompatibilityCapsule {
  if (!isWithinRoot(directories.config, file)) throw new Error("compatibility capsule must be loaded from the resolved configuration root");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("compatibility capsule must be a regular file");
  return parseCompatibilityCapsule(JSON.parse(fs.readFileSync(file, "utf8")));
}

export type HostConfigurationLayer = Readonly<{ name: "defaults" | "system-policy" | "owner-profile" | "recipe" | "override"; profile: HostCompatibilityProfile }>;
export type ConfigurationContribution = Readonly<{ layer: HostConfigurationLayer["name"]; value: unknown }>;
export type HostConfiguration = Readonly<{ profile: HostCompatibilityProfile; layers: readonly HostConfigurationLayer[] }>;

function mergeObjects(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) merged[key] = isRecord(value) && isRecord(merged[key]) ? mergeObjects(merged[key] as Record<string, unknown>, value) : value;
  return merged;
}
function getPath(value: unknown, dotPath: string): unknown {
  return dotPath.split(".").reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, value);
}

/** Resolve the documented, inspectable precedence stack. Inputs are already strict profiles. */
export function resolveHostConfiguration(layers: readonly HostConfigurationLayer[]): HostConfiguration {
  if (layers.length === 0 || layers[0]?.name !== "defaults") throw new Error("host configuration must start with schema defaults");
  const expected = ["defaults", "system-policy", "owner-profile", "recipe", "override"] as const;
  let previous = -1;
  let merged: Record<string, unknown> = {};
  for (const layer of layers) {
    const index = expected.indexOf(layer.name);
    if (index <= previous) throw new Error("host configuration layers must be ordered and unique");
    previous = index;
    merged = mergeObjects(merged, layer.profile as unknown as Record<string, unknown>);
  }
  return Object.freeze({ profile: parseHostCompatibilityProfile(merged), layers: Object.freeze([...layers]) });
}

/** Equivalent data for `lal config explain <key>`; presentation belongs to CLI/UI. */
export function explainHostConfiguration(configuration: HostConfiguration, key: string): Readonly<{ key: string; value: unknown; contributions: readonly ConfigurationContribution[] }> {
  if (!/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/.test(key)) throw new Error("configuration key must be a dotted identifier");
  const contributions = configuration.layers.flatMap((layer) => {
    const value = getPath(layer.profile, key);
    return value === undefined ? [] : [Object.freeze({ layer: layer.name, value })];
  });
  return Object.freeze({ key, value: getPath(configuration.profile, key), contributions: Object.freeze(contributions) });
}

export type HostContext = Readonly<{ directories: PlatformDirectories; configuration: HostConfiguration; capsule?: CompatibilityCapsule; adapters: Readonly<Record<HostAdapterConcern, string>> }>;

/** Validate selected adapter IDs and expose one immutable context to domain code. */
export function createHostContext(input: { configuration: HostConfiguration; registry?: HostAdapterRegistry; capsule?: CompatibilityCapsule; directories?: PlatformDirectories }): HostContext {
  const registry = input.registry ?? EMPTY_HOST_ADAPTER_REGISTRY;
  const capsule = input.capsule;
  const adapters = capsule?.adapters ?? Object.fromEntries(HOST_ADAPTER_CONCERNS.map((concern) => [concern, "unconfigured"])) as Record<HostAdapterConcern, string>;
  if (capsule) for (const concern of HOST_ADAPTER_CONCERNS) if (!registry[concern].includes(adapters[concern])) throw new Error(`compatibility capsule selects unavailable ${concern} adapter: ${adapters[concern]}`);
  return Object.freeze({ directories: Object.freeze({ ...(input.directories ?? resolvePlatformDirectories()), ...(input.configuration.profile.paths ?? {}), ...(capsule?.paths ?? {}) }), configuration: input.configuration, ...(capsule === undefined ? {} : { capsule }), adapters: Object.freeze({ ...adapters }) });
}
