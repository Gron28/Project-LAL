export type GuardianReportInput = {
  generatedAt: number;
  guardian: { coverage: { processes: boolean; network: boolean }; processCount: number; connectionCount: number };
  correlation: { cases: Array<{ priority: string; title: string; signals: Array<{ source: string; summary: string }>; uncertainty: string; safeNextStep: string }>; sources: { findingsIntegrity: boolean } };
  adapters: Array<{ name: string; state: string; capabilities: string[] }>;
  isolation: { service: string; bubblewrap: string; userNamespaces: string };
  posture: { state: string } | null;
  quarantine: { records: unknown[]; integrity: boolean };
  runtime: { serving: { model: string | null; backend: string | null; context: number | null; profile: string | null }; activeRuns: unknown[] };
  machineScan?: { id: string; state: string; startedAt: number; finishedAt: number | null; progress: { filesSeen: number; directoriesSeen: number; unreadable: number }; coverage: { timeLimitReached: boolean; fileLimitReached: boolean }; findings: Array<{ severity: string; title: string; path: string; rule: string; detail: string }>; telemetry?: { processes: number; listeners: Array<{ protocol: string; local: string; process: string | null; pid: number | null }>; remoteConnections: Array<{ protocol: string; state: string; local: string; remote: string; process: string | null; pid: number | null }>; localSessions: string[]; recentLogins: string[]; enabledServices: string[]; authorizedKeyFiles: string[]; coverage: { processes: boolean; network: boolean; sessions: boolean; services: boolean }; errors: string[] } } | null;
};
const bullet = (value: string) => `- ${value}\n`;
export function renderGuardianOwnerReport(input: GuardianReportInput): string {
  const runtime = input.runtime.serving;
  const lines = ["# LAL Guardian owner report\n", `Generated locally: ${new Date(input.generatedAt).toISOString()}\n`, "## Runtime\n", bullet(`Serving model: ${runtime.model ?? "none"}`), bullet(`Backend: ${runtime.backend ?? "none"}; context: ${runtime.context ?? "n/a"}; profile: ${runtime.profile ?? "n/a"}`), bullet(`Managed active runs: ${input.runtime.activeRuns.length}`), "\n## Coverage and isolation\n", bullet(`Processes: ${input.guardian.coverage.processes ? "available" : "unavailable"} (${input.guardian.processCount} observed)`), bullet(`Network: ${input.guardian.coverage.network ? "available" : "unavailable"} (${input.guardian.connectionCount} observed)`), bullet(`Findings ledger integrity: ${input.correlation.sources.findingsIntegrity ? "verified" : "FAILED"}`), bullet(`LAL service isolation: ${input.isolation.service}; Bubblewrap: ${input.isolation.bubblewrap}; user namespaces: ${input.isolation.userNamespaces}`), "\n## Evidence review cases\n"];
  if (!input.correlation.cases.length) lines.push("No review cases from the currently available evidence. This is not proof the host is safe.\n");
  for (const item of input.correlation.cases) {
    lines.push(`### [${item.priority}] ${item.title}\n`);
    for (const signal of item.signals) lines.push(bullet(`${signal.source}: ${signal.summary}`));
    lines.push(`Uncertainty: ${item.uncertainty}\n\nSafe next step: ${item.safeNextStep}\n\n`);
  }
  lines.push("## Local defensive adapters\n");
  for (const adapter of input.adapters) lines.push(bullet(`${adapter.name}: ${adapter.state} (${adapter.capabilities.join(", ")})`));
  lines.push("\n## Posture and reversible actions\n", bullet(`OSQuery posture: ${input.posture?.state ?? "not collected"}`), bullet(`Quarantine ledger integrity: ${input.quarantine.integrity ? "verified" : "FAILED"}; recorded events: ${input.quarantine.records.length}`), "\nThis report is generated on the owner host. It does not contact a network destination, execute remediation, or treat a detection as proof of compromise.\n");
  const scan = input.machineScan;
  lines.push("\n## Latest built-in machine scan\n");
  if (!scan) lines.push("No built-in machine scan has been run yet.\n");
  else {
    lines.push(bullet(`Scan ${scan.id}: ${scan.state}; started ${new Date(scan.startedAt).toISOString()}${scan.finishedAt ? `; finished ${new Date(scan.finishedAt).toISOString()}` : ""}`));
    lines.push(bullet(`Coverage: ${scan.progress.filesSeen} files, ${scan.progress.directoriesSeen} directories, ${scan.progress.unreadable} unreadable paths${scan.coverage.timeLimitReached || scan.coverage.fileLimitReached ? "; partial due to scan bound" : ""}`));
    if (!scan.findings.length) lines.push("No built-in rule findings. This is not proof the machine is safe.\n");
    for (const item of scan.findings) lines.push(bullet(`[${item.severity}] ${item.title}: ${item.path} (${item.rule}) — ${item.detail}`));
    if (scan.telemetry) {
      lines.push("\n### Access and telemetry snapshot\n");
      lines.push(bullet(`Processes visible: ${scan.telemetry.processes}; process coverage: ${scan.telemetry.coverage.processes ? "available" : "unavailable"}`));
      lines.push(bullet(`Listening services: ${scan.telemetry.listeners.length}; network coverage: ${scan.telemetry.coverage.network ? "available" : "unavailable"}`));
      lines.push(bullet(`Active remote connections: ${scan.telemetry.remoteConnections.length}`));
      lines.push(bullet(`Current local sessions: ${scan.telemetry.localSessions.length}; login-history coverage: ${scan.telemetry.coverage.sessions ? "available" : "unavailable"}`));
      lines.push(bullet(`Enabled system services: ${scan.telemetry.enabledServices.length}; service coverage: ${scan.telemetry.coverage.services ? "available" : "unavailable"}`));
      lines.push(bullet(`SSH authorized-key files found: ${scan.telemetry.authorizedKeyFiles.length}`));
      for (const item of scan.telemetry.listeners.slice(0, 30)) lines.push(bullet(`Listener: ${item.protocol} ${item.local} · ${item.process ?? "unknown process"}${item.pid ? ` (pid ${item.pid})` : ""}`));
      for (const item of scan.telemetry.remoteConnections.slice(0, 30)) lines.push(bullet(`Remote connection: ${item.protocol} ${item.local} → ${item.remote} · ${item.process ?? "unknown process"}${item.pid ? ` (pid ${item.pid})` : ""}`));
      for (const item of scan.telemetry.errors) lines.push(bullet(`Telemetry gap: ${item}`));
    }
  }
  return lines.join("");
}
