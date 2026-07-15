import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lensRuntimeStatus, servingRuntimeStatus, trainingRuntimeStatus } from "./lab";
import { listRuns } from "./runs";
import { parseRuntimeProcesses, type RuntimeProcess } from "./runtime-processes";

export type { RuntimeProcess } from "./runtime-processes";

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
  return {
    serving: servingRuntimeStatus(),
    training: trainingRuntimeStatus(),
    lens: lensRuntimeStatus(),
    activeRuns,
    processes: processes(),
  };
}
