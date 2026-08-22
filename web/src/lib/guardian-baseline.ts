import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readGuardianInventory, type GuardianConnection, type GuardianProcess } from "./guardian-observer.ts";

const BASELINE_FILE = path.join(process.cwd(), ".data", "guardian", "baseline.json");
export type GuardianProcessIdentity = { executable: string; commandFingerprint: string; executableSha256: string | null; hasEffectiveCapabilities: boolean | null; noNewPrivileges: boolean | null };
export type GuardianConnectionIdentity = Pick<GuardianConnection, "protocol" | "state" | "localAddress" | "localPort" | "remoteAddress" | "remotePort" | "process">;
export type GuardianBaseline = { version: 1; capturedAt: number; processes: GuardianProcessIdentity[]; connections: GuardianConnectionIdentity[]; hash: string };
export type GuardianBaselineComparison = { baseline: GuardianBaseline | null; coverage: { processes: boolean; network: boolean }; newProcesses: GuardianProcessIdentity[] | null; newConnections: GuardianConnectionIdentity[] | null };

const stable = <T>(values: T[]) => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const baselineHash = (value: Omit<GuardianBaseline, "hash"> | GuardianBaseline) => {
  const { version, capturedAt, processes, connections } = value as GuardianBaseline;
  return crypto.createHash("sha256").update(JSON.stringify({ version, capturedAt, processes: stable(processes), connections: stable(connections) })).digest("hex");
};
export const processIdentities = (processes: GuardianProcess[]): GuardianProcessIdentity[] => stable([...new Map(processes.map((process) => { const identity = { executable: process.executable, commandFingerprint: process.commandFingerprint, executableSha256: process.executableSha256, hasEffectiveCapabilities: process.hasEffectiveCapabilities, noNewPrivileges: process.noNewPrivileges }; return [JSON.stringify(identity), identity]; })).values()]);
export const connectionIdentities = (connections: GuardianConnection[]): GuardianConnectionIdentity[] => stable([...new Map(connections.map((connection) => { const identity = { protocol: connection.protocol, state: connection.state, localAddress: connection.localAddress, localPort: connection.localPort, remoteAddress: connection.remoteAddress, remotePort: connection.remotePort, process: connection.process }; return [JSON.stringify(identity), identity]; })).values()]);

export function makeGuardianBaseline(processes: GuardianProcess[], connections: GuardianConnection[], capturedAt = Date.now()): GuardianBaseline {
  const value = { version: 1 as const, capturedAt, processes: processIdentities(processes), connections: connectionIdentities(connections) };
  return { ...value, hash: baselineHash(value) };
}
export function verifyGuardianBaseline(baseline: GuardianBaseline): boolean { return baseline.version === 1 && baseline.hash === baselineHash(baseline); }
export function readGuardianBaseline(file = BASELINE_FILE): GuardianBaseline | null {
  try { const baseline = JSON.parse(fs.readFileSync(file, "utf8")) as GuardianBaseline; return verifyGuardianBaseline(baseline) ? baseline : null; } catch { return null; }
}
export function writeGuardianBaseline(baseline: GuardianBaseline, file = BASELINE_FILE) {
  if (!verifyGuardianBaseline(baseline)) throw new Error("refusing to write an invalid Guardian baseline");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(baseline, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); fs.chmodSync(file, 0o600);
}
export function captureGuardianBaseline(): GuardianBaseline {
  const inventory = readGuardianInventory();
  if (!inventory.status.coverage.processes || !inventory.status.coverage.network) throw new Error("cannot capture a baseline until both process and network observers are available");
  const baseline = makeGuardianBaseline(inventory.processes, inventory.connections); writeGuardianBaseline(baseline); return baseline;
}
export function compareGuardianBaseline(): GuardianBaselineComparison {
  const baseline = readGuardianBaseline();
  const inventory = readGuardianInventory();
  const currentProcesses = processIdentities(inventory.processes), currentConnections = connectionIdentities(inventory.connections);
  const additions = <T>(current: T[], known: T[]) => current.filter((value) => !new Set(known.map((entry) => JSON.stringify(entry))).has(JSON.stringify(value)));
  // Baselines captured before executable proof existed remain valid. Normalize
  // their absent field at comparison time without rewriting their signed record.
  const knownProcesses = baseline?.processes.map((process) => ({ ...process, executableSha256: process.executableSha256 ?? null, hasEffectiveCapabilities: process.hasEffectiveCapabilities ?? null, noNewPrivileges: process.noNewPrivileges ?? null })) || [];
  return { baseline, coverage: { processes: inventory.status.coverage.processes, network: inventory.status.coverage.network }, newProcesses: baseline && inventory.status.coverage.processes ? additions(currentProcesses, knownProcesses) : null, newConnections: baseline && inventory.status.coverage.network ? additions(currentConnections, baseline.connections) : null };
}
