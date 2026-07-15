export type RuntimeProcessKind = "llama-server" | "finetune" | "ollama" | "preview" | "lal-web" | "other";

export type RuntimeProcess = {
  pid: number;
  ppid: number;
  elapsed: string;
  state: string;
  rssKb: number;
  command: string;
  kind: RuntimeProcessKind;
  ownership: "managed" | "external" | "stale-or-unknown";
};

// `ps args` is not an executable name. A shell used to run a diagnostic can contain
// the words "llama-server" or "finetune" in its script text, even though it is not
// that process. Classify only known executable forms, and keep ambiguous commands out
// of the inventory rather than showing a fictional orphan.
export function classifyRuntimeProcess(command: string): RuntimeProcessKind {
  const trimmed = command.trim();
  const executable = trimmed.split(/\s+/, 1)[0] ?? "";
  const basename = executable.slice(executable.lastIndexOf("/") + 1);

  if (basename === "llama-server") return "llama-server";
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(basename) && /\bfinetune(?:[_-]\w+)?\.py(?:\s|$)/.test(trimmed)) return "finetune";
  if (basename === "ollama") return "ollama";
  if (basename === "next" && /^next\s+dev\b/.test(trimmed)) return "preview";
  if (basename === "vite" || basename === "webpack-dev-server") return "preview";
  return "other";
}

export function parseRuntimeProcesses(raw: string, owned: ReadonlySet<number>, webServicePids: ReadonlySet<number> = new Set()): RuntimeProcess[] {
  return raw.split("\n").flatMap((line): RuntimeProcess[] => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) return [];
    const pid = Number(m[1]);
    const command = m[6];
    // A Next production process normally reports itself only as `next-server`.
    // Its command line has no project root, so service control-group ownership is
    // the reliable way to distinguish Project-LAL from another local Next app.
    const classified = classifyRuntimeProcess(command);
    // Managed model/training children live in the web service's cgroup too. Their
    // executable identity is more specific than the parent-service fallback.
    const kind = classified !== "other" ? classified : webServicePids.has(pid) ? "lal-web" : "other";
    if (kind === "other") return [];
    return [{
      pid, ppid: Number(m[2]), elapsed: m[3], state: m[4], rssKb: Number(m[5]), command,
      kind,
      ownership: owned.has(pid) || webServicePids.has(pid) ? "managed" : kind === "ollama" ? "external" : "stale-or-unknown",
    }];
  });
}
