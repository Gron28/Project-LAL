import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContextProfile } from "@project-lal/protocol";

export const CONTEXT_CANDIDATES = [32_768, 65_536, 131_072] as const;
export const CONTEXT_FALLBACKS = [16_384, 8_192] as const;

type PersistedProfiles = { version: 1; profiles: Record<string, ContextProfile> };

function sha(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function contextCandidates(modelMaxTokens: number | null): number[] {
  const maximum = modelMaxTokens && modelMaxTokens > 0 ? modelMaxTokens : Number.POSITIVE_INFINITY;
  return [...CONTEXT_CANDIDATES, ...CONTEXT_FALLBACKS]
    .filter((value) => value <= maximum)
    .sort((a, b) => b - a);
}

export function contextHardwareFingerprint(backendIdentity = "unknown"): string {
  const cpu = os.cpus()[0]?.model ?? "unknown";
  return sha([process.platform, process.arch, os.totalmem(), cpu, backendIdentity].join("\n"));
}

/**
 * Minimal GGUF metadata reader.  It scans key/value metadata without loading
 * tensor data and returns `<architecture>.context_length` when present.
 */
export function readGgufContextLength(file: string): number | null {
  const fd = fs.openSync(file, "r");
  let offset = 0;
  const read = (length: number): Buffer => {
    const value = Buffer.allocUnsafe(length);
    if (fs.readSync(fd, value, 0, length, offset) !== length) throw new Error("truncated GGUF metadata");
    offset += length;
    return value;
  };
  const u8 = () => read(1).readUInt8(0);
  const u16 = () => read(2).readUInt16LE(0);
  const u32 = () => read(4).readUInt32LE(0);
  const u64 = () => Number(read(8).readBigUInt64LE(0));
  const string = () => read(u64()).toString("utf8");
  const skipValue = (type: number): unknown => {
    switch (type) {
      case 0: return u8();
      case 1: return read(1).readInt8(0);
      case 2: return u16();
      case 3: return read(2).readInt16LE(0);
      case 4: return u32();
      case 5: return read(4).readInt32LE(0);
      case 6: return read(4).readFloatLE(0);
      case 7: return u8() !== 0;
      case 8: return string();
      case 9: {
        const elementType = u32();
        const length = u64();
        for (let index = 0; index < length; index++) skipValue(elementType);
        return null;
      }
      case 10: return u64();
      case 11: return Number(read(8).readBigInt64LE(0));
      case 12: return read(8).readDoubleLE(0);
      default: throw new Error(`unknown GGUF metadata type ${type}`);
    }
  };
  try {
    if (read(4).toString("ascii") !== "GGUF") return null;
    const version = u32();
    if (version < 2 || version > 3) return null;
    u64(); // tensor count
    const metadataCount = u64();
    let architecture: string | null = null;
    const contextValues = new Map<string, number>();
    for (let index = 0; index < metadataCount; index++) {
      const key = string();
      const value = skipValue(u32());
      if (key === "general.architecture" && typeof value === "string") {
        architecture = value;
        const known = contextValues.get(`${architecture}.context_length`);
        if (known) return known;
      }
      if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
        contextValues.set(key, value);
        if (architecture && key === `${architecture}.context_length`) return value;
      }
    }
    if (architecture) return contextValues.get(`${architecture}.context_length`) ?? null;
    return contextValues.values().next().value ?? null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export class ContextProfileStore {
  private readonly file: string;

  constructor(file: string) { this.file = file; }

  private readAll(): PersistedProfiles {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as PersistedProfiles;
      if (value.version === 1 && value.profiles && typeof value.profiles === "object") return value;
    } catch {}
    return { version: 1, profiles: {} };
  }

  get(fingerprint: string): ContextProfile | null {
    return this.readAll().profiles[fingerprint] ?? null;
  }

  put(profile: ContextProfile): void {
    const state = this.readAll();
    state.profiles[profile.fingerprint] = profile;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

export function makeContextProfile(input: {
  model: string;
  backend: "llama.cpp" | "ollama";
  modelMaxTokens: number | null;
  requestedTokens: number;
  activeTokens?: number | null;
  verifiedTokens?: number | null;
  fingerprint: string;
  source?: ContextProfile["source"];
  gpuOffload?: string | null;
  reason?: string;
}): ContextProfile {
  const activeTokens = input.activeTokens ?? null;
  const verifiedTokens = input.verifiedTokens ?? null;
  return {
    model: input.model,
    backend: input.backend,
    modelMaxTokens: input.modelMaxTokens,
    requestedTokens: input.requestedTokens,
    activeTokens,
    verifiedTokens,
    verification: verifiedTokens
      ? verifiedTokens < input.requestedTokens ? "degraded" : "verified"
      : activeTokens ? "planned" : "unknown",
    source: input.source ?? "fallback",
    gpuOffload: input.gpuOffload ?? null,
    fingerprint: input.fingerprint,
    checkedAt: verifiedTokens ? new Date().toISOString() : null,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}
