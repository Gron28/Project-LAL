import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectGuardianAdapters } from "./guardian-adapters.ts";

const COLLECTION_DIR = path.join(process.cwd(), ".data", "guardian", "velociraptor");
export type VelociraptorArtifact = { id: string; name: string; description: string };
export type VelociraptorCollection = { id: string; artifact: string; state: "completed" | "unavailable" | "failed" | "blocked"; collectedAt: number; recordCount: number; fields: string[]; outputSha256: string | null; error: string | null };

const LINUX_ARTIFACTS: readonly VelociraptorArtifact[] = [
  { id: "Generic.Client.Info", name: "Client information", description: "Basic host and interface information from the local endpoint." },
  { id: "Linux.Sys.Users", name: "Local account inventory", description: "Local account facts parsed from /etc/passwd." },
];
const GENERIC_ARTIFACTS: readonly VelociraptorArtifact[] = [{ id: "Generic.Client.Info", name: "Client information", description: "Basic host information from the local endpoint." }];
export function guardianVelociraptorArtifacts(platform = process.platform): readonly VelociraptorArtifact[] { return platform === "linux" ? LINUX_ARTIFACTS : GENERIC_ARTIFACTS; }

function safeRows(output: string): { count: number; fields: string[] } {
  try {
    const parsed = JSON.parse(output) as unknown;
    const rows = Array.isArray(parsed) ? parsed.filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)) : [];
    return { count: rows.length, fields: [...new Set(rows.flatMap((row) => Object.keys(row)))].sort().slice(0, 64) };
  } catch { return { count: 0, fields: [] }; }
}
export function readVelociraptorCollections(directory = COLLECTION_DIR): VelociraptorCollection[] {
  try { return fs.readdirSync(directory).filter((entry) => entry.endsWith(".json") && !entry.endsWith(".output.json")).flatMap((entry) => { try { const value = JSON.parse(fs.readFileSync(path.join(directory, entry), "utf8")) as VelociraptorCollection; return typeof value?.id === "string" && typeof value.artifact === "string" ? [value] : []; } catch { return []; } }).sort((a, b) => b.collectedAt - a.collectedAt).slice(0, 30); }
  catch { return []; }
}
/** Collect only an allowlisted local artifact. No remote API configuration,
 * artifact parameters, shell/VQL, uploads, or output ZIP is accepted here. */
export function collectVelociraptorArtifact(artifact: string, now = Date.now()): VelociraptorCollection {
  const collection: VelociraptorCollection = { id: `velo_${crypto.randomUUID().replace(/-/g, "")}`, artifact, state: "blocked", collectedAt: now, recordCount: 0, fields: [], outputSha256: null, error: null };
  if (!guardianVelociraptorArtifacts().some((item) => item.id === artifact)) return { ...collection, error: "artifact is not in LAL's local read-only allowlist" };
  const executable = detectGuardianAdapters().find((adapter) => adapter.id === "velociraptor")?.executable;
  if (!executable) return { ...collection, state: "unavailable", error: "Velociraptor is not installed or not on PATH" };
  const result = spawnSync(executable, ["artifacts", "collect", "--format=json", "--timeout=60", "--progress_timeout=20", "--cpu_limit=50", "--hard_memory_limit=268435456", artifact], { encoding: "utf8", timeout: 70_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) return { ...collection, state: "failed", error: result.error.message };
  if (result.status !== 0) return { ...collection, state: "failed", error: (result.stderr || `velociraptor exited ${result.status ?? "without a status"}`).trim() };
  const output = result.stdout || "[]";
  const summary = safeRows(output);
  const completed: VelociraptorCollection = { ...collection, state: "completed", recordCount: summary.count, fields: summary.fields, outputSha256: crypto.createHash("sha256").update(output).digest("hex") };
  try {
    fs.mkdirSync(COLLECTION_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(COLLECTION_DIR, `${completed.id}.output.json`), output, { mode: 0o600 });
    fs.writeFileSync(path.join(COLLECTION_DIR, `${completed.id}.json`), JSON.stringify(completed, null, 2), { mode: 0o600 });
  } catch (error) { return { ...completed, state: "failed", error: error instanceof Error ? error.message : "could not persist collection" }; }
  return completed;
}
