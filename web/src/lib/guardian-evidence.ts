import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { authorizeDefensiveAction, type DefensiveEngagement } from "./defensive-engagement.ts";
import { detectGuardianAdapters } from "./guardian-adapters.ts";

export type GuardianSeverity = "info" | "low" | "medium" | "high" | "critical";
export type GuardianFinding = {
  id: string;
  createdAt: number;
  scanId: string;
  source: "yara" | "clamav" | "sigma" | "manual";
  severity: GuardianSeverity;
  title: string;
  target: string;
  evidence: { ruleId: string; detail: string; sha256: string };
  previousHash: string;
  hash: string;
};

export type GuardianScanResult = {
  scanId: string;
  state: "completed" | "blocked" | "unavailable" | "failed";
  findings: GuardianFinding[];
  error: string | null;
};

const stable = (value: unknown) => JSON.stringify(value, Object.keys(value as object).sort());
const hash = (value: unknown) => crypto.createHash("sha256").update(stable(value)).digest("hex");

export function makeGuardianFinding(input: Omit<GuardianFinding, "id" | "hash" | "previousHash">, previousHash = "genesis"): GuardianFinding {
  const base = { ...input, previousHash };
  return { ...base, id: hash({ scanId: input.scanId, source: input.source, target: input.target, ruleId: input.evidence.ruleId, detail: input.evidence.detail }), hash: hash(base) };
}

export function verifyGuardianFindings(findings: readonly GuardianFinding[]): boolean {
  let previousHash = "genesis";
  for (const finding of findings) {
    const findingHash = finding.hash;
    const base = {
      createdAt: finding.createdAt, scanId: finding.scanId, source: finding.source, severity: finding.severity,
      title: finding.title, target: finding.target, evidence: finding.evidence, previousHash: finding.previousHash,
    };
    if (finding.previousHash !== previousHash || findingHash !== hash(base)) return false;
    previousHash = findingHash;
  }
  return true;
}

export function parseYaraOutput(output: string): Array<{ ruleId: string; target: string; detail: string }> {
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\S+)(?:\s+\[([^\]]+)\])?\s+(.+)$/);
    if (!match) return [];
    return [{ ruleId: match[1], target: match[3], detail: match[2] ? `tags: ${match[2]}` : "YARA rule matched" }];
  });
}

export function parseClamAvOutput(output: string): Array<{ ruleId: string; target: string; detail: string }> {
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(.*):\s+(.+)\s+FOUND$/);
    return match ? [{ target: match[1], ruleId: match[2], detail: "ClamAV signature matched" }] : [];
  });
}

export class GuardianEvidenceStore {
  private readonly file: string;
  constructor(file = path.join(process.cwd(), ".data", "guardian", "findings.ndjson")) { this.file = file; }

  all(): GuardianFinding[] {
    try {
      return fs.readFileSync(this.file, "utf8").trim().split("\n").flatMap((line): GuardianFinding[] => {
        try {
          const finding = JSON.parse(line) as GuardianFinding;
          return typeof finding.id === "string" && typeof finding.hash === "string" && typeof finding.createdAt === "number" ? [finding] : [];
        } catch { return []; }
      });
    } catch { return []; }
  }

  list(limit = 100): GuardianFinding[] { return this.all().slice(-limit); }

  append(input: Omit<GuardianFinding, "id" | "hash" | "previousHash">): GuardianFinding {
    const existing = this.list(10_000);
    const finding = makeGuardianFinding(input, existing.at(-1)?.hash ?? "genesis");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(finding) + "\n", { mode: 0o600 });
    return finding;
  }
}

export function readGuardianEvidence(limit = 100): { findings: GuardianFinding[]; integrity: boolean } {
  const all = new GuardianEvidenceStore().all();
  return { findings: all.slice(-limit).reverse(), integrity: verifyGuardianFindings(all) };
}

function targetPath(target: string): string | null {
  if (!target.startsWith("host:")) return null;
  const candidate = target.slice("host:".length);
  if (!path.isAbsolute(candidate) || candidate === path.parse(candidate).root) return null;
  try { return fs.realpathSync(candidate); } catch { return null; }
}

/**
 * A first, deliberately bounded adapter: scan one owner-authorized regular
 * file against one local YARA rule file. Directory walks, downloads, and
 * remediation are intentionally separate capabilities, not implicit flags.
 */
export function runYaraScan(input: { engagement: DefensiveEngagement; target: string; ruleFile: string; scanId: string; store?: GuardianEvidenceStore; now?: number; priorActions?: number }): GuardianScanResult {
  const action = { id: input.scanId, target: input.target, technique: "yara_scan", contactsTarget: false, mutatesTarget: false, approved: true, at: input.now ?? Date.now() };
  const authorization = authorizeDefensiveAction(input.engagement, action, input.priorActions ?? 0);
  if (!authorization.allowed) return { scanId: input.scanId, state: "blocked", findings: [], error: authorization.reason || "scan is outside the engagement" };
  const target = targetPath(input.target);
  if (!target) return { scanId: input.scanId, state: "blocked", findings: [], error: "target must be an existing non-root host: absolute path" };
  try { if (!fs.statSync(target).isFile()) return { scanId: input.scanId, state: "blocked", findings: [], error: "initial YARA adapter only scans regular files" }; }
  catch { return { scanId: input.scanId, state: "blocked", findings: [], error: "target is not readable" }; }
  const rules = path.resolve(input.ruleFile);
  try { if (!fs.statSync(rules).isFile()) return { scanId: input.scanId, state: "blocked", findings: [], error: "rule file is not readable" }; }
  catch { return { scanId: input.scanId, state: "blocked", findings: [], error: "rule file is not readable" }; }
  const yara = detectGuardianAdapters().find((adapter) => adapter.id === "yara")?.executable;
  if (!yara) return { scanId: input.scanId, state: "unavailable", findings: [], error: "YARA is not installed or not on PATH" };
  const result = spawnSync(yara, [rules, target], { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) return { scanId: input.scanId, state: "failed", findings: [], error: result.error.message };
  if (result.status !== 0 && result.status !== 1) return { scanId: input.scanId, state: "failed", findings: [], error: (result.stderr || `yara exited ${result.status ?? "without a status"}`).trim() };
  const store = input.store ?? new GuardianEvidenceStore();
  const createdAt = input.now ?? Date.now();
  const findings = parseYaraOutput(result.stdout || "").map((match) => store.append({
    createdAt, scanId: input.scanId, source: "yara", severity: "medium", title: `YARA match: ${match.ruleId}`,
    target: match.target, evidence: { ruleId: match.ruleId, detail: match.detail, sha256: hash(`${match.ruleId}\n${match.target}\n${match.detail}`) },
  }));
  return { scanId: input.scanId, state: "completed", findings, error: null };
}

/** ClamAV is also bounded to a single regular file. Its update/configuration and
 * any quarantine/delete options stay outside this adapter. */
export function runClamAvScan(input: { engagement: DefensiveEngagement; target: string; scanId: string; store?: GuardianEvidenceStore; now?: number; priorActions?: number }): GuardianScanResult {
  const action = { id: input.scanId, target: input.target, technique: "clamav_scan", contactsTarget: false, mutatesTarget: false, approved: true, at: input.now ?? Date.now() };
  const authorization = authorizeDefensiveAction(input.engagement, action, input.priorActions ?? 0);
  if (!authorization.allowed) return { scanId: input.scanId, state: "blocked", findings: [], error: authorization.reason || "scan is outside the engagement" };
  const target = targetPath(input.target);
  if (!target) return { scanId: input.scanId, state: "blocked", findings: [], error: "target must be an existing non-root host: absolute path" };
  try { if (!fs.statSync(target).isFile()) return { scanId: input.scanId, state: "blocked", findings: [], error: "initial ClamAV adapter only scans regular files" }; }
  catch { return { scanId: input.scanId, state: "blocked", findings: [], error: "target is not readable" }; }
  const clamav = detectGuardianAdapters().find((adapter) => adapter.id === "clamav")?.executable;
  if (!clamav) return { scanId: input.scanId, state: "unavailable", findings: [], error: "ClamAV is not installed or not on PATH" };
  const result = spawnSync(clamav, ["--no-summary", "--", target], { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) return { scanId: input.scanId, state: "failed", findings: [], error: result.error.message };
  if (result.status !== 0 && result.status !== 1) return { scanId: input.scanId, state: "failed", findings: [], error: (result.stderr || `clamscan exited ${result.status ?? "without a status"}`).trim() };
  const store = input.store ?? new GuardianEvidenceStore();
  const createdAt = input.now ?? Date.now();
  const findings = parseClamAvOutput(result.stdout || "").map((match) => store.append({
    createdAt, scanId: input.scanId, source: "clamav", severity: "high", title: `ClamAV match: ${match.ruleId}`,
    target: match.target, evidence: { ruleId: match.ruleId, detail: match.detail, sha256: hash(`${match.ruleId}\n${match.target}\n${match.detail}`) },
  }));
  return { scanId: input.scanId, state: "completed", findings, error: null };
}
