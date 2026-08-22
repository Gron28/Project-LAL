import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectGuardianAdapters } from "./guardian-adapters.ts";

const POSTURE_FILE = path.join(process.cwd(), ".data", "guardian", "posture.json");
export type GuardianPostureSnapshot = {
  source: "osquery";
  state: "completed" | "unavailable" | "failed";
  collectedAt: number;
  os: Record<string, string | number | null> | null;
  system: Record<string, string | number | null> | null;
  error: string | null;
};

const OS_QUERY = "SELECT name, version, major, minor, patch, build, platform FROM os_version;";
const SYSTEM_QUERY = "SELECT hostname, cpu_type, cpu_subtype, physical_memory FROM system_info;";
const cleanRow = (value: unknown, allowed: readonly string[]): Record<string, string | number | null> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row: Record<string, string | number | null> = {};
  for (const key of allowed) {
    const current = (value as Record<string, unknown>)[key];
    if (typeof current === "string") row[key] = current.slice(0, 256);
    else if (typeof current === "number" && Number.isFinite(current)) row[key] = current;
    else if (current === null) row[key] = null;
  }
  return row;
};
function query(executable: string, sql: string, allowed: readonly string[]): { row: Record<string, string | number | null> | null; error: string | null } {
  const result = spawnSync(executable, ["--json", sql], { encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) return { row: null, error: result.error.message };
  if (result.status !== 0) return { row: null, error: (result.stderr || `osqueryi exited ${result.status ?? "without a status"}`).trim() };
  const row = parseOsqueryRow(result.stdout || "[]", allowed);
  return row === undefined ? { row: null, error: "osquery returned invalid JSON" } : { row, error: null };
}
export function parseOsqueryRow(raw: string, allowed: readonly string[]): Record<string, string | number | null> | null | undefined {
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? cleanRow(parsed[0], allowed) : undefined; }
  catch { return undefined; }
}
export function readGuardianPosture(file = POSTURE_FILE): GuardianPostureSnapshot | null {
  try {
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as GuardianPostureSnapshot;
    return snapshot?.source === "osquery" && typeof snapshot.collectedAt === "number" ? snapshot : null;
  } catch { return null; }
}
function write(snapshot: GuardianPostureSnapshot, file = POSTURE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); fs.chmodSync(file, 0o600);
}
/** Fixed read-only queries only. This is deliberately not an SQL console. */
export function collectGuardianPosture(now = Date.now()): GuardianPostureSnapshot {
  const executable = detectGuardianAdapters().find((adapter) => adapter.id === "osquery")?.executable;
  if (!executable) return { source: "osquery", state: "unavailable", collectedAt: now, os: null, system: null, error: "osquery is not installed or not on PATH" };
  const os = query(executable, OS_QUERY, ["name", "version", "major", "minor", "patch", "build", "platform"]);
  const system = query(executable, SYSTEM_QUERY, ["hostname", "cpu_type", "cpu_subtype", "physical_memory"]);
  const snapshot: GuardianPostureSnapshot = { source: "osquery", state: os.error || system.error ? "failed" : "completed", collectedAt: now, os: os.row, system: system.row, error: os.error || system.error };
  write(snapshot); return snapshot;
}
