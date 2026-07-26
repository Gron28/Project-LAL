import crypto from "node:crypto";

export type ResearchContract = {
  question: string;
  useContext: string;
  requiredOutput: string;
  sourceRequirements: string[];
  evidenceCutoff?: string;
  riskDomain: "general" | "medical" | "legal" | "security" | "other";
  expertReviewRequired: boolean;
  definitionOfDone: string[];
  uncertaintyRequired: boolean;
};
export type EngagementMode = "knowledge_review" | "local_lab" | "authorized_assessment";
export type DefensiveEngagement = {
  id: string;
  mode: EngagementMode;
  authorizationReference?: string;
  ownerAttestation?: string;
  targets: string[];
  excludedTargets: string[];
  allowedTechniques: string[];
  startsAt: number;
  endsAt: number;
  networkEnabled: boolean;
  requiresApprovalForContact: boolean;
  maxActions: number;
  stopConditions: string[];
};
export type EngagementAction = { id: string; target: string; technique: string; contactsTarget: boolean; mutatesTarget: boolean; approved: boolean; at: number };
export type EngagementLedgerEntry = EngagementAction & { previousHash: string; hash: string; outcome: "allowed" | "blocked"; reason?: string };

const stable = (value: unknown) => JSON.stringify(value, Object.keys(value as object).sort());
const hash = (value: unknown) => crypto.createHash("sha256").update(stable(value)).digest("hex");

export function validateResearchContract(contract: ResearchContract): string[] {
  const errors: string[] = [];
  if (!contract.question.trim() || !contract.useContext.trim() || !contract.requiredOutput.trim()) errors.push("question, use context, and required output are required");
  if (!contract.definitionOfDone.length) errors.push("at least one definition-of-done check is required");
  if (contract.riskDomain === "medical" || contract.riskDomain === "legal") {
    if (!contract.expertReviewRequired) errors.push("high-stakes research requires explicit expert-review status");
    if (!contract.uncertaintyRequired) errors.push("high-stakes research requires uncertainty output");
  }
  if (contract.evidenceCutoff && Number.isNaN(Date.parse(contract.evidenceCutoff))) errors.push("evidence cutoff must be an ISO date");
  return errors;
}

export function validateDefensiveEngagement(engagement: DefensiveEngagement): string[] {
  const errors: string[] = [];
  if (!engagement.id.trim() || !engagement.targets.length || !engagement.allowedTechniques.length) errors.push("engagement id, targets, and allowed techniques are required");
  if (!Number.isFinite(engagement.startsAt) || !Number.isFinite(engagement.endsAt) || engagement.endsAt <= engagement.startsAt) errors.push("engagement time window is invalid");
  if (!Number.isInteger(engagement.maxActions) || engagement.maxActions < 1) errors.push("max actions must be positive");
  if (engagement.mode === "authorized_assessment" && (!engagement.authorizationReference?.trim() || !engagement.ownerAttestation?.trim())) errors.push("authorized assessment requires authorization reference and owner attestation");
  if (engagement.mode !== "authorized_assessment" && engagement.networkEnabled) errors.push("only authorized assessments may enable target network access");
  if (engagement.mode === "local_lab" && engagement.targets.some((target) => !target.startsWith("lab:"))) errors.push("local lab targets must use the lab: namespace");
  return errors;
}

/** Mechanical policy check at the tool boundary. A research topic alone never
 * supplies permission to contact or alter a target. */
export function authorizeDefensiveAction(engagement: DefensiveEngagement, action: EngagementAction, priorActions = 0): { allowed: boolean; reason?: string } {
  const validation = validateDefensiveEngagement(engagement);
  if (validation.length) return { allowed: false, reason: validation[0] };
  if (action.at < engagement.startsAt || action.at > engagement.endsAt) return { allowed: false, reason: "outside engagement time window" };
  if (priorActions >= engagement.maxActions) return { allowed: false, reason: "engagement action limit reached" };
  if (engagement.excludedTargets.includes(action.target) || !engagement.targets.includes(action.target)) return { allowed: false, reason: "target is out of scope" };
  if (!engagement.allowedTechniques.includes(action.technique)) return { allowed: false, reason: "technique is out of scope" };
  if (engagement.mode === "knowledge_review" && (action.contactsTarget || action.mutatesTarget)) return { allowed: false, reason: "knowledge review cannot contact or mutate targets" };
  if (engagement.mode === "local_lab" && action.contactsTarget) return { allowed: false, reason: "local lab has network disabled" };
  if ((action.contactsTarget || action.mutatesTarget) && engagement.requiresApprovalForContact && !action.approved) return { allowed: false, reason: "explicit approval is required" };
  return { allowed: true };
}

/** Append-only hash-linked entries make later reports show both permitted and
 * refused actions without treating an intent as an executed action. */
export function recordEngagementAction(ledger: readonly EngagementLedgerEntry[], engagement: DefensiveEngagement, action: EngagementAction): EngagementLedgerEntry {
  const verdict = authorizeDefensiveAction(engagement, action, ledger.length);
  const previousHash = ledger.at(-1)?.hash ?? "genesis";
  const base = { ...action, previousHash, outcome: verdict.allowed ? "allowed" as const : "blocked" as const, ...(verdict.reason ? { reason: verdict.reason } : {}) };
  return { ...base, hash: hash(base) };
}

export function verifyEngagementLedger(ledger: readonly EngagementLedgerEntry[]): boolean {
  let previousHash = "genesis";
  for (const entry of ledger) {
    const { hash: entryHash, ...base } = entry;
    if (entry.previousHash !== previousHash || entryHash !== hash(base)) return false;
    previousHash = entryHash;
  }
  return true;
}
