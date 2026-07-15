import { execFileSync } from "node:child_process";
import { lensRuntimeStatus, servingRuntimeStatus, trainingRuntimeStatus } from "./lab";
import { listRuns } from "./runs";

export type RuntimeProcess = {
  pid: number;
  ppid: number;
  elapsed: string;
  state: string;
  rssKb: number;
  command: string;
  kind: "llama-server" | "finetune" | "ollama" | "preview" | "lal-web" | "other";
  ownership: "managed" | "external" | "stale-or-unknown";
};

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

  return raw.split("\n").flatMap((line): RuntimeProcess[] => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) return [];
    const command = m[6];
    const kind: RuntimeProcess["kind"] =
      /llama-server/.test(command) ? "llama-server" :
      /(?:python\S*\s+.*finetune|finetune_\w+\.py)/.test(command) ? "finetune" :
      /(?:^|\s)ollama(?:\s|$)/.test(command) ? "ollama" :
      /next\s+(?:start|dev)/.test(command) ? "lal-web" :
      /(?:vite|webpack-dev-server|next dev)/.test(command) ? "preview" : "other";
    if (kind === "other") return [];
    const pid = Number(m[1]);
    return [{
      pid, ppid: Number(m[2]), elapsed: m[3], state: m[4], rssKb: Number(m[5]), command,
      kind,
      ownership: owned.has(pid) ? "managed" : kind === "ollama" || kind === "lal-web" ? "external" : "stale-or-unknown",
    }];
  });
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
