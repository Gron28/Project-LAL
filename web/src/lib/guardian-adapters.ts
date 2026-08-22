import fs from "node:fs";
import path from "node:path";

/**
 * Adapter discovery is deliberately non-invasive. It reports tools that are
 * already present on the owner's machine; installing, configuring, scanning,
 * and any remediation remain separate, explicit future actions.
 */
export type GuardianAdapter = {
  id: string;
  name: string;
  domain: "malware" | "endpoint" | "network" | "privacy" | "runtime";
  state: "available" | "missing";
  executable: string | null;
  capabilities: string[];
};

type AdapterDefinition = Omit<GuardianAdapter, "state" | "executable"> & { executables: string[] };

const ADAPTERS: AdapterDefinition[] = [
  { id: "yara", name: "YARA", domain: "malware", executables: ["yara"], capabilities: ["file signatures", "malware classification"] },
  { id: "clamav", name: "ClamAV", domain: "malware", executables: ["clamscan", "clamdscan"], capabilities: ["signature scans", "on-access service"] },
  { id: "osquery", name: "osquery", domain: "endpoint", executables: ["osqueryi", "osqueryd"], capabilities: ["inventory", "posture queries"] },
  { id: "velociraptor", name: "Velociraptor", domain: "endpoint", executables: ["velociraptor"], capabilities: ["DFIR artifacts", "hunts"] },
  { id: "opensnitch", name: "OpenSnitch", domain: "network", executables: ["opensnitchd"], capabilities: ["per-app egress", "firewall policy"] },
  { id: "portmaster", name: "Portmaster", domain: "privacy", executables: ["portmaster"], capabilities: ["per-app privacy", "secure DNS"] },
  { id: "falco", name: "Falco", domain: "runtime", executables: ["falco"], capabilities: ["syscall detections", "eBPF telemetry"] },
  { id: "wazuh", name: "Wazuh agent", domain: "endpoint", executables: ["wazuh-agentd"], capabilities: ["FIM", "vulnerability posture"] },
];

function executablePath(name: string, searchPath: string): string | null {
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next directory */ }
  }
  return null;
}

export function detectGuardianAdapters(searchPath = process.env.PATH || ""): GuardianAdapter[] {
  return ADAPTERS.map((adapter) => {
    const executable = adapter.executables.map((name) => executablePath(name, searchPath)).find((candidate): candidate is string => !!candidate) ?? null;
    return { id: adapter.id, name: adapter.name, domain: adapter.domain, state: executable ? "available" : "missing", executable, capabilities: adapter.capabilities };
  });
}

const cache = globalThis as unknown as { __lal_guardian_adapters?: { at: number; adapters: GuardianAdapter[] } };

export function readGuardianAdapters(): GuardianAdapter[] {
  const now = Date.now();
  if (cache.__lal_guardian_adapters && now - cache.__lal_guardian_adapters.at < 30_000) return cache.__lal_guardian_adapters.adapters;
  const adapters = detectGuardianAdapters();
  cache.__lal_guardian_adapters = { at: now, adapters };
  return adapters;
}
