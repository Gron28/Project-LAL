import { readGuardianAdapters } from "./guardian-adapters.ts";
import { readGuardianCorrelation } from "./guardian-correlation.ts";
import { readGuardianIsolation } from "./guardian-isolation.ts";
import { readGuardianStatus } from "./guardian-observer.ts";
import { readGuardianPosture } from "./guardian-posture.ts";
import { readGuardianQuarantine } from "./guardian-remediation.ts";
import { readRuntimeStatus } from "./runtime-status.ts";
import { listMachineScans } from "./guardian-machine-scan.ts";
import { renderGuardianOwnerReport, type GuardianReportInput } from "./guardian-report-render.ts";

export function guardianOwnerReport(): string {
  const quarantine = readGuardianQuarantine();
  return renderGuardianOwnerReport({ generatedAt: Date.now(), guardian: readGuardianStatus(), correlation: readGuardianCorrelation(), adapters: readGuardianAdapters(), isolation: readGuardianIsolation(), posture: readGuardianPosture(), quarantine, runtime: readRuntimeStatus(), machineScan: listMachineScans(1)[0] ?? null });
}
export { renderGuardianOwnerReport, type GuardianReportInput };
