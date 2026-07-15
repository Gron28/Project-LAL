import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lensRuntimeStatus, servingRuntimeStatus, trainingRuntimeStatus } from "./lab";
import { listRuns } from "./runs";
import { parseRuntimeProcesses, type RuntimeProcess } from "./runtime-processes";

export type { RuntimeProcess } from "./runtime-processes";

export type RuntimeProcessEvent = {
  ts: number;
  event: "observed" | "exited";
  process: Pick<RuntimeProcess, "pid" | "kind" | "ownership" | "command">;
};

const RUNTIME_DIR = path.join(process.cwd(), ".data", "runtime");
const PROCESS_JOURNAL = path.join(RUNTIME_DIR, "process-events.ndjson");
try { mkdirSync(RUNTIME_DIR, { recursive: true }); } catch {}
const runtime = globalThis as unknown as { __lal_runtime_processes?: Map<number, RuntimeProcess> };
if (!runtime.__lal_runtime_processes) runtime.__lal_runtime_processes = new Map();

function appendProcessEvent(event: RuntimeProcessEvent) {
  try {
    appendFileSync(PROCESS_JOURNAL, JSON.stringify(event) + "\n");
    if (statSync(PROCESS_JOURNAL).size > 512 * 1024) {
      const tail = readFileSync(PROCESS_JOURNAL, "utf8").trim().split("\n").slice(-512).join("\n");
      writeFileSync(PROCESS_JOURNAL, tail ? tail + "\n" : "");
    }
  } catch { /* runtime audit must never make status unavailable */ }
}

function observeProcesses(current: RuntimeProcess[]): RuntimeProcessEvent[] {
  const previous = runtime.__lal_runtime_processes!;
  const next = new Map(current.map((process) => [process.pid, process]));
  const now = Date.now();
  for (const process of current) {
    const before = previous.get(process.pid);
    if (!before || before.command !== process.command || before.kind !== process.kind) {
      appendProcessEvent({ ts: now, event: "observed", process });
    }
  }
  for (const [pid, process] of previous) {
    if (!next.has(pid)) appendProcessEvent({ ts: now, event: "exited", process });
  }
  runtime.__lal_runtime_processes = next;
  try {
    if (!existsSync(PROCESS_JOURNAL)) return [];
    return readFileSync(PROCESS_JOURNAL, "utf8").trim().split("\n").flatMap((line): RuntimeProcessEvent[] => {
      try { return [JSON.parse(line) as RuntimeProcessEvent]; } catch { return []; }
    }).slice(-100).reverse();
  } catch { return []; }
}

function processes(): RuntimeProcess[] {
  let raw = "";
  try {
    raw = execFileSync("ps", ["-eo", "pid=,ppid=,etime=,stat=,rss=,args="], {
      encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024,
    });
  } catch { return []; }

  const owned = new Set([
    servingRuntimeStatus().pid,
    trainingRuntimeStatus().pid,
    lensRuntimeStatus().pid,
  ].filter((pid): pid is number => typeof pid === "number"));

  return parseRuntimeProcesses(raw, owned, webServicePids());
}

function webServicePids(): Set<number> {
  // This is deliberately best-effort. Project-LAL currently runs as a Linux user
  // service; if systemd/cgroups are unavailable (including later Windows hosting),
  // status remains useful for model and training processes without inventing web
  // ownership from an ambiguous `next-server` command line.
  try {
    const service = process.env.PROJECT_LAL_SERVICE || "project-lal.service";
    const controlGroup = execFileSync("systemctl", ["--user", "show", service, "-p", "ControlGroup", "--value"], {
      encoding: "utf8", timeout: 2_000,
    }).trim();
    if (!controlGroup.startsWith("/")) return new Set();
    return new Set(readFileSync(`/sys/fs/cgroup${controlGroup}/cgroup.procs`, "utf8")
      .split("\n").map(Number).filter(Number.isInteger));
  } catch { return new Set(); }
}

export function readRuntimeStatus() {
  const runs = listRuns(20);
  const activeRuns = runs.filter((run) => run.status === "running").map((run) => ({
    id: run.id, kind: run.kind, model: run.model, startedAt: run.startedAt, updatedAt: run.updatedAt,
  }));
  const processList = processes();
  return {
    serving: servingRuntimeStatus(),
    training: trainingRuntimeStatus(),
    lens: lensRuntimeStatus(),
    activeRuns,
    processes: processList,
    processEvents: observeProcesses(processList),
  };
}
