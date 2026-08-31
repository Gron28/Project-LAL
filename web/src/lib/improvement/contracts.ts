export const IMPROVEMENT_SCHEMA_VERSION = 1 as const;

export type CampaignState =
  | "draft" | "queued" | "running" | "frozen" | "hidden_evaluation"
  | "awaiting_approval" | "promoted" | "rejected"
  | "paused" | "failed" | "cancelled";

export type RoleDefinition = {
  id: string;
  aliases?: string[];
  description: string;
  permittedTools: string[];
  objective: string;
};

export type ScoringPolicy = {
  minimumBaseImprovementPoints: number;
  confidenceLevel: number;
  parityMarginPoints: number;
  maximumRegressionPoints: number;
  workflowImprovementPoints: number;
  requireZeroUnauthorizedActions: boolean;
  requireZeroFalseCompletions: boolean;
};

export type RolePack = {
  schemaVersion: typeof IMPROVEMENT_SCHEMA_VERSION;
  id: string;
  version: string;
  sharedBaseRequired: boolean;
  roles: RoleDefinition[];
  developmentSuites: string[];
  hiddenSuite: string;
  regressionSuites: string[];
  workflowSuite: string;
  scoringPolicy: ScoringPolicy;
};

export type ArtifactBinding = {
  id: string;
  sha256: string;
  revision: string;
  path?: string;
  tokenizerSha256?: string;
  chatTemplateSha256?: string;
};

export type CampaignBudgetName = "smoke" | "balanced" | "thorough";
export type CampaignBudget = {
  name: CampaignBudgetName;
  maxTrials: number;
  maxGpuHours: number;
  scratchBytes: number;
  finalists: number;
  trainingSeeds: number;
  plateauTrials?: number;
};

export type DatasetSelection = {
  manifestId: string;
  sha256: string;
  taskFamilies: string[];
  privateTraceGroup?: string;
  consentId?: string;
};

export type ImprovementCampaignInput = {
  name: string;
  rolePack: { id: string; version: string };
  base: ArtifactBinding;
  runtimeBase: ArtifactBinding;
  reference: ArtifactBinding;
  datasets: DatasetSelection[];
  retentionDataset: DatasetSelection;
  judges: string[];
  researcher: { provider: string; allowRemote: boolean; disclosurePolicy: "aggregates_only" | "approved_rows" };
  budget: CampaignBudgetName;
  schedule: { timezone: string; idleWindows: { days: number[]; start: string; end: string }[]; pauseForInteractive: boolean };
  suiteRevisions: Record<string, string>;
  /** Optional UI-selected bounded search policy; omitted for legacy manifests. */
  strategy?: {
    objectives: TrainingObjective[];
    ranks: (8 | 16)[];
    targets: ("attention" | "attention_mlp")[];
    learningRates: (0.00005 | 0.0001 | 0.0002)[];
    warmupRatios: (0 | 0.05)[];
    schedules: ("constant" | "cosine")[];
    retentionPercents: (10 | 20 | 30)[];
    klCoefficients: (0.02 | 0.05 | 0.1)[];
    researcherEvery: number;
  };
};

export type ImprovementCampaign = ImprovementCampaignInput & {
  schemaVersion: typeof IMPROVEMENT_SCHEMA_VERSION;
  id: string;
  configSha256: string;
  state: CampaignState;
  createdAt: number;
  updatedAt: number;
  currentTrialId?: string;
  budgetConsumed: { trials: number; gpuSeconds: number; scratchBytes: number };
  frozenMethodCardSha256?: string;
  evaluationId?: string;
  jobId?: string;
  reason?: string;
};

export type TrainingObjective = "sft" | "sft_replay" | "sft_kl";
export type CandidateRecipeInput = {
  campaignId: string;
  roleId: string;
  objective: TrainingObjective;
  rank: 8 | 16;
  alpha: 16 | 32;
  dropout: 0.05;
  targets: "attention" | "attention_mlp";
  learningRate: 0.00005 | 0.0001 | 0.0002;
  warmupRatio: 0 | 0.05;
  schedule: "constant" | "cosine";
  retentionPercent: 10 | 20 | 30;
  klCoefficient?: 0.02 | 0.05 | 0.1;
  seed: number;
  budgetFraction: 0.25 | 0.5 | 1;
  hypothesis: string;
  parentCandidateId?: string;
  trainerRevision: string;
  researcherProposed?: boolean;
};
export type CandidateRecipe = CandidateRecipeInput & { id: string; sha256: string; createdAt: number };

export type TrialResultInput = {
  campaignId: string;
  candidateId: string;
  status: "succeeded" | "failed" | "incompatible" | "cancelled";
  development: Record<string, number>;
  regressions: Record<string, number>;
  telemetry: { steps: number; bestStep?: number; trainLoss?: number; validationLoss?: number; finiteGradients: boolean };
  resources: { gpuSeconds: number; peakMemoryBytes: number; scratchBytes: number; latencyMs?: number; tokens?: number; modelCalls?: number; energyProxy?: number };
  artifacts: { id: string; sha256: string }[];
  failure?: { code: string; message: string };
};
export type TrialResult = TrialResultInput & { id: string; sha256: string; recordedAt: number };

export type PairedScore = { cases: number; candidateRate: number; baseRate: number; referenceRate: number; improvementPoints: number; referenceGapPoints: number; confidenceInterval: [number, number] };
export type EvaluationGate = { code: string; passed: boolean; actual: number | boolean | string; required: string };
export type CampaignEvaluationInput = {
  campaignId: string;
  suiteRevision: string;
  candidateSet: Record<string, { adapterId: string; adapterSha256: string }>;
  baseSha256: string;
  referenceSha256: string;
  roleScores: Record<string, PairedScore>;
  workflowScore: PairedScore;
  coreRegressionPoints: number;
  schemaContractsPassed: boolean;
  toolContractsPassed: boolean;
  unauthorizedActions: number;
  falseCompletions: number;
  peakMemoryBytes: { candidate: number; reference: number };
  pareto: { latencyMs: number; energyProxy: number; tokens: number; modelCalls: number };
  judgeDisagreements: number;
  unresolvedReviews: number;
  evidenceIds: string[];
};
export type CampaignEvaluation = CampaignEvaluationInput & { id: string; sha256: string; verdict: "pass" | "fail" | "needs_review"; gates: EvaluationGate[]; recordedAt: number };

export type ActiveSpecialistSet = {
  id: string;
  campaignId: string;
  baseSha256: string;
  roleAdapters: Record<string, { adapterId: string; adapterSha256: string }>;
  previousSetId?: string;
  activatedAt: number;
  reason: string;
};

export const CAMPAIGN_BUDGETS: Record<CampaignBudgetName, CampaignBudget> = {
  smoke: { name: "smoke", maxTrials: 3, maxGpuHours: 2, scratchBytes: 20 * 1024 ** 3, finalists: 1, trainingSeeds: 1 },
  balanced: { name: "balanced", maxTrials: 12, maxGpuHours: 12, scratchBytes: 20 * 1024 ** 3, finalists: 2, trainingSeeds: 2 },
  thorough: { name: "thorough", maxTrials: 30, maxGpuHours: 36, scratchBytes: 50 * 1024 ** 3, finalists: 3, trainingSeeds: 3, plateauTrials: 6 },
};
