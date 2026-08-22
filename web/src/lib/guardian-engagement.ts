import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  recordEngagementAction,
  validateDefensiveEngagement,
  verifyEngagementLedger,
  type DefensiveEngagement,
  type EngagementAction,
  type EngagementLedgerEntry,
} from "./defensive-engagement.ts";

export type GuardianEngagementRecord = {
  engagement: DefensiveEngagement;
  actions: EngagementLedgerEntry[];
};

export class GuardianEngagementStore {
  private readonly directory: string;
  constructor(directory = path.join(process.cwd(), ".data", "guardian", "engagements")) { this.directory = directory; }

  private file(id: string) { return path.join(this.directory, `${id}.json`); }

  create(engagement: DefensiveEngagement): GuardianEngagementRecord {
    const errors = validateDefensiveEngagement(engagement);
    if (errors.length) throw new Error(errors[0]);
    const record = { engagement, actions: [] };
    this.write(record);
    return record;
  }

  get(id: string): GuardianEngagementRecord | null {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(id), "utf8")) as GuardianEngagementRecord;
      if (!parsed?.engagement || !Array.isArray(parsed.actions) || validateDefensiveEngagement(parsed.engagement).length) return null;
      return parsed;
    } catch { return null; }
  }

  list(limit = 25): Array<GuardianEngagementRecord & { integrity: boolean }> {
    try {
      return fs.readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .flatMap((entry) => {
          const record = this.get(entry.name.slice(0, -5));
          return record ? [{ ...record, integrity: verifyEngagementLedger(record.actions) }] : [];
        })
        .sort((a, b) => b.engagement.startsAt - a.engagement.startsAt)
        .slice(0, limit);
    } catch { return []; }
  }

  record(id: string, action: EngagementAction): EngagementLedgerEntry | null {
    const record = this.get(id);
    if (!record || !verifyEngagementLedger(record.actions)) return null;
    const entry = recordEngagementAction(record.actions, record.engagement, action);
    record.actions.push(entry);
    this.write(record);
    return entry;
  }

  private write(record: GuardianEngagementRecord) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(record.engagement.id);
    const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(temp, target);
    fs.chmodSync(target, 0o600);
  }
}

export function createOwnerLocalScanEngagement(input: { target: string; ownerAttestation: string; technique: "yara_scan" | "clamav_scan" | "quarantine_file" | "restore_file"; now?: number }): DefensiveEngagement {
  const now = input.now ?? Date.now();
  return {
    id: `${input.technique.replace(/[^a-z0-9]/g, "")}_${crypto.randomUUID().replace(/-/g, "")}`,
    mode: "authorized_assessment",
    authorizationReference: "local-owner-guardian-workbench",
    ownerAttestation: input.ownerAttestation.trim(),
    targets: [input.target],
    excludedTargets: [],
    allowedTechniques: [input.technique],
    startsAt: now - 1_000,
    endsAt: now + 10 * 60_000,
    networkEnabled: false,
    requiresApprovalForContact: true,
    maxActions: 1,
    stopConditions: ["Do not scan another target", "Stop after one local scanner invocation", "Never contact or modify the target"],
  };
}

export function createOwnerYaraEngagement(input: { target: string; ownerAttestation: string; now?: number }): DefensiveEngagement {
  return createOwnerLocalScanEngagement({ ...input, technique: "yara_scan" });
}
