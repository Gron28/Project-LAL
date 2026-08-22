import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { readGuardianInventory } from "./guardian-observer.ts";

/**
 * The built-in Guardian scan deliberately has no scanner or feed dependency.
 * It is a local, read-only posture and filesystem inspection, not a claim that
 * LAL has an external vendor's malware signatures.  Every result carries the
 * exact rule that produced it so an owner can judge false positives.
 */
export type MachineScanFinding = { id: string; severity: "info" | "low" | "medium" | "high"; title: string; path: string; rule: string; detail: string };
export type MachineScan = {
  id: string; state: "queued" | "running" | "completed" | "failed" | "cancelled"; startedAt: number; finishedAt: number | null;
  progress: { phase: string; filesSeen: number; directoriesSeen: number; unreadable: number; roots: string[]; updatedAt: number };
  findings: MachineScanFinding[]; coverage: { scannedRoots: string[]; skippedRoots: string[]; timeLimitMs: number; timeLimitReached: boolean; fileLimitReached: boolean };
  summary: { filesSeen: number; directoriesSeen: number; unreadable: number; findingCounts: Record<string, number> }; error: string | null;
  telemetry: { capturedAt: number; processes: number; listeners: Array<{ protocol: string; local: string; process: string | null; pid: number | null }>; remoteConnections: Array<{ protocol: string; state: string; local: string; remote: string; process: string | null; pid: number | null }>; localSessions: string[]; recentLogins: string[]; enabledServices: string[]; authorizedKeyFiles: string[]; coverage: { processes: boolean; network: boolean; sessions: boolean; services: boolean }; errors: string[] };
};

const ROOT = path.join(process.cwd(), ".data", "guardian", "machine-scans");
const MAX_MS = 10 * 60_000;
const MAX_FILES = 500_000;
const SKIP = new Set(["/dev", "/proc", "/sys", "/run", "/snap", "/lost+found"]);
const state = globalThis as unknown as { __lal_machine_scans?: Map<string, MachineScan> };
if (!state.__lal_machine_scans) state.__lal_machine_scans = new Map();

const fileFor = (id: string) => path.join(ROOT, `${id}.json`);
const safeId = (id: string) => /^[a-z0-9_-]{12,80}$/i.test(id);
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 20);
const finding = (scan: MachineScan, severity: MachineScanFinding["severity"], title: string, target: string, rule: string, detail: string) => {
  const id = digest(`${severity}\n${title}\n${target}\n${rule}`);
  if (!scan.findings.some((item) => item.id === id)) scan.findings.push({ id, severity, title, path: target, rule, detail });
};
function persist(scan: MachineScan) {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const temp = `${fileFor(scan.id)}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(scan, null, 2), { mode: 0o600 }); fs.renameSync(temp, fileFor(scan.id)); fs.chmodSync(fileFor(scan.id), 0o600);
}
function load(id: string): MachineScan | null {
  if (!safeId(id)) return null;
  const live = state.__lal_machine_scans!.get(id); if (live) return live;
  try { const scan = JSON.parse(fs.readFileSync(fileFor(id), "utf8")) as MachineScan; return scan?.id === id ? scan : null; } catch { return null; }
}
export function readMachineScan(id: string): MachineScan | null { return load(id); }
export function listMachineScans(limit = 10): MachineScan[] {
  try { return fs.readdirSync(ROOT).filter((name) => name.endsWith(".json")).flatMap((name) => load(name.slice(0, -5)) ? [load(name.slice(0, -5))!] : []).sort((a, b) => b.startedAt - a.startedAt).slice(0, limit); } catch { return []; }
}
function roots(): string[] { return ["/"].filter((root) => fs.existsSync(root)); }
function excluded(target: string) { return [...SKIP, ROOT].some((root) => target === root || target.startsWith(`${root}/`)); }
function complete(scan: MachineScan, next: MachineScan["state"], error: string | null = null) {
  scan.state = next; scan.error = error; scan.finishedAt = Date.now(); scan.progress.phase = next === "completed" ? "report ready" : next; scan.progress.updatedAt = Date.now();
  scan.summary = { filesSeen: scan.progress.filesSeen, directoriesSeen: scan.progress.directoriesSeen, unreadable: scan.progress.unreadable, findingCounts: Object.fromEntries(["high", "medium", "low", "info"].map((severity) => [severity, scan.findings.filter((item) => item.severity === severity).length])) };
  persist(scan); state.__lal_machine_scans!.delete(scan.id);
}
function inspectMetadata(scan: MachineScan, target: string, stat: fs.Stats) {
  const mode = stat.mode & 0o7777;
  if ((mode & 0o002) && (mode & 0o111)) finding(scan, "high", "World-writable executable", target, "world_writable_executable", "Anyone can modify and execute this file.");
  if ((mode & 0o6000) && stat.uid !== 0) finding(scan, "medium", "Set-ID file not owned by root", target, "setid_nonroot", "Set-user/group-ID behavior deserves owner review.");
  if (/\/(?:tmp|var\/tmp)\//.test(target) && (mode & 0o111)) finding(scan, "medium", "Executable in temporary storage", target, "executable_in_temp", "Temporary locations are commonly abused for short-lived payloads; inspect provenance.");
  if (/\/(?:\.ssh\/authorized_keys|\.config\/autostart\/[^/]+\.desktop)$/.test(target)) finding(scan, "info", "Persistence-relevant user configuration", target, "user_persistence_location", "This location can affect login or session startup; it is not a verdict.");
  if (/\/\.ssh\/authorized_keys(?:\d+)?$/.test(target) && scan.telemetry.authorizedKeyFiles.length < 100) scan.telemetry.authorizedKeyFiles.push(target);
}
function command(command: string, args: string[], limit = 50): { lines: string[]; error: string | null } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5_000, maxBuffer: 512 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) return { lines: [], error: result.error.message };
  if (result.status !== 0) return { lines: [], error: (result.stderr || `${command} exited ${result.status ?? "without a status"}`).trim() };
  return { lines: (result.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, limit), error: null };
}
function captureTelemetry(scan: MachineScan) {
  const inventory = readGuardianInventory();
  const connections = inventory.connections;
  scan.telemetry.processes = inventory.processes.length;
  scan.telemetry.listeners = connections.filter((item) => /LISTEN|UNCONN/i.test(item.state)).slice(0, 100).map((item) => ({ protocol: item.protocol, local: `${item.localAddress}:${item.localPort ?? "*"}`, process: item.process, pid: item.pid }));
  scan.telemetry.remoteConnections = connections.filter((item) => !/^(?:\*|0\.0\.0\.0|::|\[::\])$/.test(item.remoteAddress) && item.remotePort !== null).slice(0, 150).map((item) => ({ protocol: item.protocol, state: item.state, local: `${item.localAddress}:${item.localPort ?? "*"}`, remote: `${item.remoteAddress}:${item.remotePort}`, process: item.process, pid: item.pid }));
  scan.telemetry.coverage.processes = inventory.status.coverage.processes;
  scan.telemetry.coverage.network = inventory.status.coverage.network;
  if (inventory.status.error) scan.telemetry.errors.push(`process telemetry: ${inventory.status.error}`);
  if (inventory.status.networkError) scan.telemetry.errors.push(`network telemetry: ${inventory.status.networkError}`);
  const sessions = command("who", []); scan.telemetry.localSessions = sessions.lines; scan.telemetry.coverage.sessions = !sessions.error; if (sessions.error) scan.telemetry.errors.push(`session telemetry: ${sessions.error}`);
  const logins = command("last", ["-w", "-n", "20"]); scan.telemetry.recentLogins = logins.lines; if (logins.error) scan.telemetry.errors.push(`login history: ${logins.error}`);
  const services = command("systemctl", ["list-unit-files", "--state=enabled", "--no-legend", "--no-pager"], 120); scan.telemetry.enabledServices = services.lines.map((line) => line.split(/\s+/)[0]).filter(Boolean); scan.telemetry.coverage.services = !services.error; if (services.error) scan.telemetry.errors.push(`service inventory: ${services.error}`);
}
async function inspectKnownConfig(scan: MachineScan, target: string) {
  try {
    const content = await fsp.readFile(target, "utf8");
    if (/^\s*PermitRootLogin\s+yes\b/im.test(content)) finding(scan, "medium", "SSH permits direct root login", target, "ssh_root_login", "Consider disabling direct root SSH login unless it is explicitly required.");
    if (/^\s*PasswordAuthentication\s+yes\b/im.test(content)) finding(scan, "low", "SSH password authentication enabled", target, "ssh_password_auth", "Key-only authentication reduces credential-guessing exposure when appropriate.");
  } catch { scan.progress.unreadable++; }
}
async function run(scan: MachineScan) {
  scan.state = "running"; scan.progress.phase = "scanning local machine"; scan.progress.updatedAt = Date.now(); persist(scan);
  const deadline = scan.startedAt + MAX_MS;
  let sincePersist = 0;
  try {
    captureTelemetry(scan); persist(scan);
    for (const root of scan.progress.roots) {
      const stack = [root];
      while (stack.length) {
        if (Date.now() >= deadline) { scan.coverage.timeLimitReached = true; return complete(scan, "completed"); }
        if (scan.progress.filesSeen >= MAX_FILES) { scan.coverage.fileLimitReached = true; return complete(scan, "completed"); }
        const directory = stack.pop()!;
        if (excluded(directory)) { scan.coverage.skippedRoots.push(directory); continue; }
        let handle: fs.Dir;
        try { handle = await fsp.opendir(directory); } catch { scan.progress.unreadable++; continue; }
        scan.progress.directoriesSeen++;
        for await (const entry of handle) {
          const target = path.join(directory, entry.name);
          if (excluded(target) || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { stack.push(target); continue; }
          if (!entry.isFile()) continue;
          scan.progress.filesSeen++;
          try { inspectMetadata(scan, target, await fsp.lstat(target)); } catch { scan.progress.unreadable++; }
          if (target === "/etc/ssh/sshd_config") await inspectKnownConfig(scan, target);
          sincePersist++;
          if (sincePersist >= 200) { scan.progress.updatedAt = Date.now(); persist(scan); sincePersist = 0; await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
        }
      }
    }
    complete(scan, "completed");
  } catch (error) { complete(scan, "failed", error instanceof Error ? error.message : "machine scan failed"); }
}
export function startMachineScan(): MachineScan {
  const id = `machine_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = Date.now(); const scan: MachineScan = { id, state: "queued", startedAt: now, finishedAt: null, progress: { phase: "queued", filesSeen: 0, directoriesSeen: 0, unreadable: 0, roots: roots(), updatedAt: now }, findings: [], coverage: { scannedRoots: roots(), skippedRoots: [], timeLimitMs: MAX_MS, timeLimitReached: false, fileLimitReached: false }, summary: { filesSeen: 0, directoriesSeen: 0, unreadable: 0, findingCounts: {} }, error: null, telemetry: { capturedAt: now, processes: 0, listeners: [], remoteConnections: [], localSessions: [], recentLogins: [], enabledServices: [], authorizedKeyFiles: [], coverage: { processes: false, network: false, sessions: false, services: false }, errors: [] } };
  state.__lal_machine_scans!.set(id, scan); persist(scan); void run(scan); return scan;
}
