import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CandidateRecipe, DatasetSelection } from "./contracts.ts";

export type CompatibilityManifest = {
  id: string;
  backendId: string;
  trainableCheckpoint: { id: string; revision: string; sha256: string; path?: string };
  runtimeGguf: { id: string; sha256: string; path?: string };
  tokenizerSha256: string;
  chatTemplateSha256: string;
  loraTargets: ("attention" | "attention_mlp")[];
  objectives: ("sft" | "sft_replay" | "sft_kl")[];
  measured: { ramBytes: number; vramBytes: number; measuredAt: number; hostFingerprint: string };
};
export type CompatibilityResult = { compatible: boolean; code: "compatible" | "artifact_missing" | "hash_mismatch" | "objective_unsupported" | "targets_unsupported" | "resource_insufficient"; detail: string };
export type TrainingJob = { id: string; campaignId: string; candidateId: string; checkpoint?: unknown };
export type TrainingHandle = { id: string; backendId: string; state: "running" | "paused"; checkpoint?: unknown };
export type AdapterArtifact = { id: string; sha256: string; path: string; baseSha256: string };

export interface TrainingBackend {
  readonly id: string;
  probe(base: CompatibilityManifest, recipe: CandidateRecipe): CompatibilityResult;
  start(job: TrainingJob, recipe: CandidateRecipe, datasets: DatasetSelection[]): Promise<TrainingHandle>;
  resume(job: TrainingJob, checkpoint: unknown): Promise<TrainingHandle>;
  cancel(job: TrainingJob): Promise<unknown>;
  convert(candidate: CandidateRecipe): Promise<AdapterArtifact>;
}
export interface ResearchProvider {
  readonly id: string;
  readonly remote: boolean;
  propose(campaignBrief: Record<string, unknown>, developmentHistory: DevelopmentHistory): Promise<ExperimentProposal>;
}
export type DevelopmentHistory = { trials: { recipe: Omit<CandidateRecipe, "hypothesis">; aggregateScores: Record<string, number>; failureCategories: string[] }[] };
export type ExperimentProposal = { recipe: Partial<CandidateRecipe>; hypothesis: string };

/** Reproducible local default; it proposes only bounded knobs from aggregate history. */
export class LocalResearchProvider implements ResearchProvider {
  readonly id="local"; readonly remote=false;
  async propose(_campaignBrief:Record<string,unknown>,history:DevelopmentHistory):Promise<ExperimentProposal>{
    const index=history.trials.length%3;
    return validateResearchProposal(index===0
      ? {hypothesis:"Test whether lower-rank attention-only adaptation retains more base capability.",recipe:{rank:8,alpha:16,targets:"attention",learningRate:.0001,retentionPercent:20}}
      : index===1
        ? {hypothesis:"Test stronger replay at the conservative learning rate after observed regression categories.",recipe:{objective:"sft_replay",rank:16,alpha:32,targets:"attention_mlp",learningRate:.00005,retentionPercent:30}}
        : {hypothesis:"Test moderate KL anchoring against the frozen adapter-disabled base.",recipe:{objective:"sft_kl",rank:16,alpha:32,targets:"attention_mlp",learningRate:.0001,retentionPercent:20,klCoefficient:.05}});
  }
}

export class TrainingBackendRegistry {
  private readonly backends = new Map<string, TrainingBackend>();
  register(backend: TrainingBackend): void { if (this.backends.has(backend.id)) throw new Error(`training backend already registered: ${backend.id}`); this.backends.set(backend.id, backend); }
  get(id: string): TrainingBackend | null { return this.backends.get(id) ?? null; }
  list(): string[] { return [...this.backends.keys()].sort(); }
  select(manifests: CompatibilityManifest[], recipe: CandidateRecipe): { backend: TrainingBackend; manifest: CompatibilityManifest } | null {
    for (const manifest of manifests) { const backend=this.get(manifest.backendId); if (backend?.probe(manifest,recipe).compatible) return { backend,manifest }; }
    return null;
  }
}

export function verifyCompatibility(manifest: CompatibilityManifest, recipe: CandidateRecipe, available: { ramBytes?: number; vramBytes?: number } = {}): CompatibilityResult {
  if (!manifest.objectives.includes(recipe.objective)) return { compatible:false,code:"objective_unsupported",detail:`${manifest.backendId} does not implement ${recipe.objective}` };
  if (!manifest.loraTargets.includes(recipe.targets)) return { compatible:false,code:"targets_unsupported",detail:`${manifest.backendId} does not support ${recipe.targets}` };
  for (const artifact of [manifest.trainableCheckpoint, manifest.runtimeGguf]) {
    if (!artifact.path) continue;
    if (!fs.existsSync(artifact.path)) return { compatible:false,code:"artifact_missing",detail:`artifact is missing: ${path.basename(artifact.path)}` };
    const actual=crypto.createHash("sha256").update(fs.readFileSync(artifact.path)).digest("hex");
    if (actual !== artifact.sha256) return { compatible:false,code:"hash_mismatch",detail:`artifact hash changed: ${artifact.id}` };
  }
  if ((available.ramBytes !== undefined && available.ramBytes < manifest.measured.ramBytes) || (available.vramBytes !== undefined && available.vramBytes < manifest.measured.vramBytes)) return { compatible:false,code:"resource_insufficient",detail:"host is below the measured RAM/VRAM requirement" };
  return { compatible:true,code:"compatible",detail:"exact artifacts, objective, targets, and measured resources match" };
}

const allowedProposalKeys = new Set(["objective","rank","alpha","dropout","targets","learningRate","warmupRatio","schedule","retentionPercent","klCoefficient","seed","hypothesis"]);
export function validateResearchProposal(proposal: ExperimentProposal): ExperimentProposal {
  if (!proposal || typeof proposal !== "object" || !proposal.hypothesis?.trim()) throw new Error("research proposal requires a hypothesis");
  for (const key of Object.keys(proposal.recipe)) if (!allowedProposalKeys.has(key)) throw new Error(`research proposal field is not allowlisted: ${key}`);
  const r=proposal.recipe;
  if (r.rank !== undefined && ![8,16].includes(r.rank)) throw new Error("rank is outside the bounded search space");
  if (r.alpha !== undefined && r.rank !== undefined && r.alpha !== 2*r.rank) throw new Error("alpha must equal 2 × rank");
  if (r.learningRate !== undefined && ![.00005,.0001,.0002].includes(r.learningRate)) throw new Error("learning rate is outside the bounded search space");
  if (r.retentionPercent !== undefined && ![10,20,30].includes(r.retentionPercent)) throw new Error("retention mix is outside the bounded search space");
  if (r.objective === "sft_kl" && r.klCoefficient !== undefined && ![.02,.05,.1].includes(r.klCoefficient)) throw new Error("KL coefficient is outside the bounded search space");
  return structuredClone(proposal);
}

export type DisclosureRecord = { providerId: string; campaignId: string; at: number; fields: string[]; privateRows: number; consentId?: string };
export function buildResearchBrief(input: { campaignId: string; provider: ResearchProvider; aggregateHistory: DevelopmentHistory; privateRows?: unknown[]; consentId?: string }): { brief: Record<string, unknown>; disclosure: DisclosureRecord } {
  if (input.provider.remote && input.privateRows?.length && !input.consentId) throw new Error("remote providers cannot receive private rows without campaign-specific consent");
  const privateRows=input.consentId ? input.privateRows ?? [] : [];
  const brief={ campaignId:input.campaignId,developmentHistory:input.aggregateHistory,...(privateRows.length ? { approvedPrivateRows:privateRows } : {}) };
  return { brief,disclosure:{ providerId:input.provider.id,campaignId:input.campaignId,at:Date.now(),fields:Object.keys(brief).sort(),privateRows:privateRows.length,...(input.consentId ? { consentId:input.consentId } : {}) } };
}
