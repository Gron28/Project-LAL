import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The first Guardian sensor is intentionally passive and unprivileged. It is a
 * system-wide process inventory, not an antivirus verdict and never a response
 * authority. Raw command lines are fingerprinted locally rather than copied
 * into a browser-facing event feed where tokens can leak.
 */
export type GuardianProcess = {
  pid: number;
  ppid: number;
  user: string;
  ageSec: number;
  state: string;
  rssKb: number;
  executable: string;
  commandFingerprint: string;
  /** Best-effort SHA-256 of /proc/<pid>/exe. Never a path or command line. */
  executableSha256: string | null;
  /** Passive privilege posture from /proc/<pid>/status, never raw capability bits. */
  hasEffectiveCapabilities: boolean | null;
  noNewPrivileges: boolean | null;
};

export type GuardianProcessEvent = {
  ts: number;
  kind: "process_started" | "process_exited";
  process: GuardianProcess;
};

export type GuardianConnection = {
  id: string;
  protocol: "tcp" | "udp" | "other";
  state: string;
  localAddress: string;
  localPort: number | null;
  remoteAddress: string;
  remotePort: number | null;
  pid: number | null;
  process: string | null;
};

export type GuardianNetworkEvent = {
  ts: number;
  kind: "network_opened" | "network_closed";
  connection: GuardianConnection;
};

export type GuardianEvent = GuardianProcessEvent | GuardianNetworkEvent;

export type GuardianStatus = {
  observer: "available" | "unavailable";
  observedAt: number | null;
  processCount: number;
  executableHashCount: number;
  capabilityProcessCount: number;
  noNewPrivilegesProcessCount: number;
  networkObserver: "available" | "unavailable";
  connectionCount: number;
  events: GuardianEvent[];
  coverage: { processes: boolean; network: boolean; files: false; malware: false };
  error: string | null;
  networkError: string | null;
};

function fingerprint(command: string): string {
  return crypto.createHash("sha256").update(command).digest("hex").slice(0, 16);
}

export function parseGuardianProcesses(raw: string): GuardianProcess[] {
  return raw.split("\n").flatMap((line): GuardianProcess[] => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) return [];
    const pid = Number(match[1]), ppid = Number(match[2]), ageSec = Number(match[4]), rssKb = Number(match[6]);
    if (![pid, ppid, ageSec, rssKb].every(Number.isFinite)) return [];
    return [{ pid, ppid, user: match[3], ageSec, state: match[5], rssKb, executable: match[7], commandFingerprint: fingerprint(match[8] || match[7]), executableSha256: null, hasEffectiveCapabilities: null, noNewPrivileges: null }];
  });
}

const MAX_EXECUTABLE_HASH_BYTES = 16 * 1024 * 1024;

/** Hash only a bounded, regular executable. Inaccessible, deleted, non-regular,
 * or oversized targets remain unverified rather than being guessed. */
export function hashGuardianExecutable(file: string, maxBytes = MAX_EXECUTABLE_HASH_BYTES): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch { return null; }
}

export function parseGuardianProcessSecurityStatus(raw: string): Pick<GuardianProcess, "hasEffectiveCapabilities" | "noNewPrivileges"> {
  const capabilities = raw.match(/^CapEff:\s*([0-9a-f]+)\s*$/mi)?.[1];
  const noNewPrivileges = raw.match(/^NoNewPrivs:\s*([01])\s*$/mi)?.[1];
  return {
    hasEffectiveCapabilities: capabilities === undefined ? null : !/^0+$/.test(capabilities),
    noNewPrivileges: noNewPrivileges === undefined ? null : noNewPrivileges === "1",
  };
}

export function diffGuardianProcesses(previous: ReadonlyMap<number, GuardianProcess>, current: GuardianProcess[], ts = Date.now()): GuardianProcessEvent[] {
  const next = new Map(current.map((process) => [process.pid, process]));
  const events: GuardianProcessEvent[] = [];
  for (const process of current) {
    const before = previous.get(process.pid);
    const executableChanged = Boolean(before?.executableSha256 && process.executableSha256 && before.executableSha256 !== process.executableSha256);
    const securityChanged = Boolean(before && before.hasEffectiveCapabilities !== null && process.hasEffectiveCapabilities !== null && before.hasEffectiveCapabilities !== process.hasEffectiveCapabilities)
      || Boolean(before && before.noNewPrivileges !== null && process.noNewPrivileges !== null && before.noNewPrivileges !== process.noNewPrivileges);
    if (!before || before.commandFingerprint !== process.commandFingerprint || executableChanged || securityChanged) events.push({ ts, kind: "process_started", process });
  }
  for (const [pid, process] of previous) if (!next.has(pid)) events.push({ ts, kind: "process_exited", process });
  return events;
}

function endpoint(value: string): { address: string; port: number | null } {
  const bracketed = value.match(/^\[([^\]]+)\]:(\*|\d+)$/);
  if (bracketed) return { address: bracketed[1], port: /^\d+$/.test(bracketed[2]) ? Number(bracketed[2]) : null };
  const colon = value.lastIndexOf(":");
  if (colon < 0) return { address: value, port: null };
  const port = value.slice(colon + 1);
  return { address: value.slice(0, colon), port: /^\d+$/.test(port) ? Number(port) : null };
}

/** Parse `ss -H -tunap` without relying on its column spacing or PID visibility. */
export function parseGuardianConnections(raw: string): GuardianConnection[] {
  const byId = new Map<string, GuardianConnection>();
  for (const line of raw.split("\n")) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\d+\s+\d+\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) continue;
    const local = endpoint(match[3]);
    const remote = endpoint(match[4]);
    const protocol = /^(tcp|udp)/.test(match[1]) ? match[1].slice(0, 3) as "tcp" | "udp" : "other";
    const owners = match[5] || "";
    const pids = [...owners.matchAll(/pid=(\d+)/g)].map((pid) => Number(pid[1])).filter(Number.isFinite);
    const processMatch = owners.match(/\(\("([^"\\]+)"/);
    const ownerPids = pids.length ? pids : [null];
    for (const pid of ownerPids) {
      const id = [protocol, match[2], local.address, local.port ?? "*", remote.address, remote.port ?? "*", pid ?? "unknown"].join("|");
      byId.set(id, { id, protocol, state: match[2], localAddress: local.address, localPort: local.port, remoteAddress: remote.address, remotePort: remote.port, pid, process: processMatch?.[1] ?? null });
    }
  }
  return [...byId.values()];
}

export function diffGuardianConnections(previous: ReadonlyMap<string, GuardianConnection>, current: GuardianConnection[], ts = Date.now()): GuardianNetworkEvent[] {
  const next = new Map(current.map((connection) => [connection.id, connection]));
  const events: GuardianNetworkEvent[] = [];
  for (const connection of current) if (!previous.has(connection.id)) events.push({ ts, kind: "network_opened", connection });
  for (const [id, connection] of previous) if (!next.has(id)) events.push({ ts, kind: "network_closed", connection });
  return events;
}

export function networkObserverError(status: number | null, stderr: string): string | null {
  const detail = stderr.trim();
  if (status !== 0) return detail || `ss exited ${status ?? "without a status"}`;
  // `ss` can report an inaccessible netlink socket but still exit zero. An empty
  // socket list in that state is missing telemetry, not evidence of no network.
  if (/cannot open netlink socket/i.test(detail)) return detail;
  return null;
}

export function parseGuardianEvents(raw: string): GuardianEvent[] {
  return raw.split("\n").flatMap((line): GuardianEvent[] => {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (!Number.isFinite(event.ts) || (event.kind !== "process_started" && event.kind !== "process_exited" && event.kind !== "network_opened" && event.kind !== "network_closed")) return [];
      if ((event.kind === "process_started" || event.kind === "process_exited") && event.process && typeof event.process === "object") return [event as unknown as GuardianProcessEvent];
      if ((event.kind === "network_opened" || event.kind === "network_closed") && event.connection && typeof event.connection === "object") return [event as unknown as GuardianNetworkEvent];
    } catch { /* ignore a torn or manually corrupted line */ }
    return [];
  });
}

const GUARDIAN_DIR = path.join(process.cwd(), ".data", "guardian");
const PROCESS_JOURNAL = path.join(GUARDIAN_DIR, "process-events.ndjson");
const guardian = globalThis as unknown as { __lal_guardian_processes?: Map<number, GuardianProcess>; __lal_guardian_connections?: Map<string, GuardianConnection>; __lal_guardian_events?: GuardianEvent[]; __lal_guardian_executable_hashes?: Map<string, string | null> };
if (!guardian.__lal_guardian_processes) guardian.__lal_guardian_processes = new Map();
if (!guardian.__lal_guardian_connections) guardian.__lal_guardian_connections = new Map();
if (!guardian.__lal_guardian_executable_hashes) guardian.__lal_guardian_executable_hashes = new Map();
if (!guardian.__lal_guardian_events) {
  try { guardian.__lal_guardian_events = parseGuardianEvents(fs.readFileSync(PROCESS_JOURNAL, "utf8")).slice(-100).reverse(); }
  catch { guardian.__lal_guardian_events = []; }
}

function append(events: GuardianEvent[]) {
  if (!events.length) return;
  try {
    fs.mkdirSync(GUARDIAN_DIR, { recursive: true });
    fs.appendFileSync(PROCESS_JOURNAL, events.map((event) => JSON.stringify(event)).join("\n") + "\n", { mode: 0o600 });
    if (fs.statSync(PROCESS_JOURNAL).size > 1024 * 1024) {
      const tail = fs.readFileSync(PROCESS_JOURNAL, "utf8").trim().split("\n").slice(-1_000).join("\n");
      fs.writeFileSync(PROCESS_JOURNAL, tail ? tail + "\n" : "", { mode: 0o600 });
    }
  } catch { /* a monitor must not make the host dashboard unavailable */ }
}

function enrichGuardianProcessExecutables(processes: GuardianProcess[]): GuardianProcess[] {
  const hashes = guardian.__lal_guardian_executable_hashes!;
  return processes.map((process) => {
    let security: Pick<GuardianProcess, "hasEffectiveCapabilities" | "noNewPrivileges"> = { hasEffectiveCapabilities: null, noNewPrivileges: null };
    try { security = parseGuardianProcessSecurityStatus(fs.readFileSync(`/proc/${process.pid}/status`, "utf8")); } catch { /* process exited or is not observable */ }
    try {
      const executable = fs.realpathSync(`/proc/${process.pid}/exe`);
      const stat = fs.statSync(executable);
      const key = `${executable}\u0000${stat.size}\u0000${stat.mtimeMs}`;
      if (!hashes.has(key)) {
        if (hashes.size >= 512) hashes.clear();
        hashes.set(key, hashGuardianExecutable(executable));
      }
      return { ...process, ...security, executableSha256: hashes.get(key) ?? null };
    } catch { return { ...process, ...security }; }
  });
}

export function readGuardianStatus(): GuardianStatus {
  let processRaw = "", networkRaw = "";
  let processError: string | null = null, networkError: string | null = null;
  try {
    processRaw = execFileSync("ps", ["-eo", "pid=,ppid=,user=,etimes=,stat=,rss=,comm=,args="], { encoding: "utf8", timeout: 2_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    processError = error instanceof Error ? error.message : String(error);
  }
  try {
    const result = spawnSync("ss", ["-H", "-tunap"], { encoding: "utf8", timeout: 2_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    if (result.error) networkError = result.error.message;
    else {
      networkRaw = result.stdout || "";
      networkError = networkObserverError(result.status, result.stderr || "");
    }
  } catch (error) { networkError = error instanceof Error ? error.message : String(error); }
  const processes = enrichGuardianProcessExecutables(parseGuardianProcesses(processRaw));
  const connections = parseGuardianConnections(networkRaw);
  const ts = Date.now();
  const events: GuardianEvent[] = [
    ...diffGuardianProcesses(guardian.__lal_guardian_processes!, processes, ts),
    ...diffGuardianConnections(guardian.__lal_guardian_connections!, connections, ts),
  ];
  guardian.__lal_guardian_processes = new Map(processes.map((process) => [process.pid, process]));
  guardian.__lal_guardian_connections = new Map(connections.map((connection) => [connection.id, connection]));
  guardian.__lal_guardian_events = [...events, ...guardian.__lal_guardian_events!].slice(0, 100);
  append(events);
  return {
    observer: processError ? "unavailable" : "available", observedAt: processError ? null : ts, processCount: processes.length, executableHashCount: processes.filter((process) => process.executableSha256).length,
    capabilityProcessCount: processes.filter((process) => process.hasEffectiveCapabilities).length, noNewPrivilegesProcessCount: processes.filter((process) => process.noNewPrivileges).length,
    networkObserver: networkError ? "unavailable" : "available", connectionCount: connections.length,
    events: guardian.__lal_guardian_events!, coverage: { processes: !processError, network: !networkError, files: false, malware: false }, error: processError, networkError,
  };
}

/** Internal owner-facing inventory. The public dashboard intentionally receives
 * only counts/events; a paired Guardian surface may need stable identities to
 * establish and compare an explicit known-good baseline. */
export function readGuardianInventory(): { status: GuardianStatus; processes: GuardianProcess[]; connections: GuardianConnection[] } {
  const status = readGuardianStatus();
  return {
    status,
    processes: status.coverage.processes ? [...guardian.__lal_guardian_processes!.values()] : [],
    connections: status.coverage.network ? [...guardian.__lal_guardian_connections!.values()] : [],
  };
}
