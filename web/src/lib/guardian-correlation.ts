import crypto from "node:crypto";
import { compareGuardianBaseline, type GuardianBaselineComparison } from "./guardian-baseline.ts";
import { readGuardianEvidence, type GuardianFinding } from "./guardian-evidence.ts";
import { readGuardianPosture, type GuardianPostureSnapshot } from "./guardian-posture.ts";
import { readVelociraptorCollections, type VelociraptorCollection } from "./guardian-velociraptor.ts";

export type GuardianReviewCase = {
  id: string;
  kind: "file_detection" | "baseline_process_deviation" | "baseline_network_deviation" | "coverage_warning";
  priority: "info" | "medium" | "high";
  title: string;
  signals: Array<{ source: string; summary: string }>;
  uncertainty: string;
  safeNextStep: string;
};
export type GuardianCorrelation = { generatedAt: number; cases: GuardianReviewCase[]; sources: { findingsIntegrity: boolean; baseline: boolean; posture: GuardianPostureSnapshot | null; velociraptorCollections: number } };

const id = (kind: string, signals: unknown) => crypto.createHash("sha256").update(`${kind}\n${JSON.stringify(signals)}`).digest("hex").slice(0, 16);
const priority = (findings: GuardianFinding[]): "medium" | "high" => findings.some((finding) => finding.severity === "critical" || finding.severity === "high") || new Set(findings.map((finding) => finding.source)).size > 1 ? "high" : "medium";

export function correlateGuardianEvidence(input: { findings: GuardianFinding[]; findingsIntegrity: boolean; baseline: GuardianBaselineComparison; posture: GuardianPostureSnapshot | null; velociraptorCollections: VelociraptorCollection[]; now?: number }): GuardianCorrelation {
  const cases: GuardianReviewCase[] = [];
  const byTarget = new Map<string, GuardianFinding[]>();
  for (const finding of input.findings) byTarget.set(finding.target, [...(byTarget.get(finding.target) || []), finding]);
  for (const [target, findings] of byTarget) {
    const sources = [...new Set(findings.map((finding) => finding.source))];
    const corroborated = sources.length > 1;
    const signals = findings.map((finding) => ({ source: finding.source, summary: `${finding.evidence.ruleId} matched ${target}` }));
    cases.push({
      id: id("file_detection", signals), kind: "file_detection", priority: priority(findings),
      title: corroborated ? `Corroborated file detection: ${target}` : `File detection needs review: ${target}`,
      signals,
      uncertainty: corroborated ? "Independent local scanners agreed on the same file, but a signature match is still not proof of execution or compromise." : "Only one detection source reported this file; verify provenance and hash before drawing conclusions.",
      safeNextStep: "Preserve the file and its hash, review it in an isolated environment, and run another owner-approved local scanner if available.",
    });
  }
  if (input.baseline.newProcesses?.length) {
    const signals = input.baseline.newProcesses.slice(0, 12).map((process) => ({ source: "baseline", summary: `new process identity: ${process.executable}` }));
    cases.push({ id: id("baseline_process_deviation", signals), kind: "baseline_process_deviation", priority: "medium", title: `${input.baseline.newProcesses.length} new process identities since baseline`, signals, uncertainty: "A baseline difference only means the state changed; updates and normal applications can cause this.", safeNextStep: "Review the process timeline, publisher/package provenance, and any matching new network identity before changing the system." });
  }
  if (input.baseline.newConnections?.length) {
    const signals = input.baseline.newConnections.slice(0, 12).map((connection) => ({ source: "baseline", summary: `new network identity: ${connection.process || "unknown process"} → ${connection.remoteAddress}${connection.remotePort ? `:${connection.remotePort}` : ""}` }));
    cases.push({ id: id("baseline_network_deviation", signals), kind: "baseline_network_deviation", priority: "medium", title: `${input.baseline.newConnections.length} new network identities since baseline`, signals, uncertainty: "Connections can change with normal updates, browsers, and DNS/CDN routing. This is not a block recommendation.", safeNextStep: "Correlate with the process timeline and application owner; collect more passive evidence before applying a network policy." });
  }
  if (!input.findingsIntegrity) {
    const signals = [{ source: "findings ledger", summary: "hash-chain verification failed" }];
    cases.push({ id: id("coverage_warning", signals), kind: "coverage_warning", priority: "high", title: "Guardian findings ledger integrity failed", signals, uncertainty: "Existing findings cannot be trusted until the ledger is repaired or restored from an owner-controlled backup.", safeNextStep: "Preserve the ledger file, investigate the modification, and capture new observations separately rather than acting on the old records." });
  }
  if (input.posture && input.posture.state !== "completed") {
    const signals = [{ source: "osquery", summary: input.posture.error || input.posture.state }];
    cases.push({ id: id("coverage_warning", signals), kind: "coverage_warning", priority: "info", title: "OSQuery posture coverage is unavailable", signals, uncertainty: "This is a collection coverage gap, not evidence of a security incident.", safeNextStep: "Review the local adapter status and installation/configuration before relying on posture-based conclusions." });
  }
  return { generatedAt: input.now ?? Date.now(), cases: cases.sort((a, b) => (a.priority === "high" ? -1 : b.priority === "high" ? 1 : 0)).slice(0, 30), sources: { findingsIntegrity: input.findingsIntegrity, baseline: !!input.baseline.baseline, posture: input.posture, velociraptorCollections: input.velociraptorCollections.length } };
}

export function readGuardianCorrelation(): GuardianCorrelation {
  const evidence = readGuardianEvidence();
  return correlateGuardianEvidence({ findings: evidence.findings, findingsIntegrity: evidence.integrity, baseline: compareGuardianBaseline(), posture: readGuardianPosture(), velociraptorCollections: readVelociraptorCollections() });
}
