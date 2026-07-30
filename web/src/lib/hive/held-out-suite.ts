export type HeldOutFixture = {
  id: string;
  domain: "coding" | "research";
  category: string;
  prompt: string;
  budget: "normal" | "thorough";
  acceptanceCodes: string[];
  fault?: string;
};

const codingCategories = [
  ["single-html", "Create a self-contained interactive HTML artifact.", ["artifact-exists", "static-html", "browser-errors", "interactions"]],
  ["existing-fix", "Fix a bounded regression in an existing project and preserve unrelated behavior.", ["mutation", "relevant-tests", "requirements"]],
  ["greenfield", "Create a minimal greenfield application from the supplied contract.", ["deliverables", "build", "requirements"]],
  ["resume", "Resume an interrupted coding task without repeating a recorded side effect.", ["resume", "no-duplicate-side-effect", "requirements"]],
  ["tool-fault", "Complete a coding task when the first tool result is an injected failure.", ["recovery", "relevant-tests", "requirements"]],
  ["redirection", "Apply a changed requirement after an operator redirect.", ["latest-request", "requirements", "trace"]],
] as const;

const researchCategories = [
  ["ordinary", "Research a bounded question using independent fetched sources.", ["coverage", "independence", "entailment", "report"]],
  ["contradiction", "Research a question whose supplied sources deliberately disagree.", ["contradictions", "entailment", "report"]],
  ["coverage-gap", "Research a multipart question with one deliberately difficult sub-question.", ["coverage", "unresolved-gaps", "report"]],
  ["source-fault", "Research despite an injected fetch failure and preserve the failure in the trace.", ["recovery", "fetched-sources", "report"]],
  ["changed-scope", "Honor a changed research scope after an operator redirect.", ["latest-request", "coverage", "report"]],
  ["long-context", "Preserve requirements and citations through repeated context compaction.", ["contract-preservation", "citation-preservation", "report"]],
] as const;

export const HELD_OUT_SUITE_ID = "hive-held-out-v1";

function expand(domain: "coding" | "research", categories: readonly (readonly [string, string, readonly string[]])[]): HeldOutFixture[] {
  return Array.from({ length: 30 }, (_, index) => {
    const category = categories[index % categories.length];
    const variant = Math.floor(index / categories.length) + 1;
    return {
      id: `${domain}-${String(index + 1).padStart(2, "0")}`,
      domain,
      category: category[0],
      prompt: `${category[1]} Fixture variant ${variant}; use only the deterministic fixture workspace and inputs.`,
      budget: index % 5 === 0 ? "thorough" : "normal",
      acceptanceCodes: [...category[2]],
      ...(category[0].includes("fault") ? { fault: category[0] } : {}),
    };
  });
}

export const HELD_OUT_FIXTURES: HeldOutFixture[] = [
  ...expand("coding", codingCategories),
  ...expand("research", researchCategories),
];

export type FixtureTrajectoryScore = {
  fixtureId: string;
  candidate: "workflow" | "baseline";
  verifiedComplete: boolean;
  falseComplete: boolean;
  withinBudget: boolean;
  provenanceComplete: boolean;
  harmfulDuplicateSideEffect: boolean;
  durationMs?: number;
  budgetUnits?: number;
  events?: { seq: number; kind: string; traceId: string; spanId: string; parentSpanId?: string; detail: string }[];
  checks?: { code: string; passed: boolean; detail: string }[];
};

export function metricsFromTrajectories(scores: FixtureTrajectoryScore[]) {
  const side = (candidate: FixtureTrajectoryScore["candidate"], domain: HeldOutFixture["domain"]) => {
    const ids = new Set(HELD_OUT_FIXTURES.filter((fixture) => fixture.domain === domain).map((fixture) => fixture.id));
    return scores.filter((score) => score.candidate === candidate && ids.has(score.fixtureId));
  };
  const rate = (items: FixtureTrajectoryScore[], field: keyof FixtureTrajectoryScore) =>
    items.length ? items.filter((item) => item[field] === true).length / items.length : 0;
  const workflow = scores.filter((score) => score.candidate === "workflow");
  return {
    research: {
      heldOutTasks: side("workflow", "research").length,
      verifiedCompletionRate: rate(side("workflow", "research"), "verifiedComplete"),
      bestSingleModelRate: rate(side("baseline", "research"), "verifiedComplete"),
    },
    coding: {
      heldOutTasks: side("workflow", "coding").length,
      verifiedCompletionRate: rate(side("workflow", "coding"), "verifiedComplete"),
      bestSingleModelRate: rate(side("baseline", "coding"), "verifiedComplete"),
    },
    withinBudgetRate: rate(workflow, "withinBudget"),
    falseCompletionRate: rate(workflow, "falseComplete"),
    completeProvenance: workflow.length > 0 && workflow.every((score) => score.provenanceComplete),
    restartExactlyOnce: workflow.filter((score) => /resume/.test(HELD_OUT_FIXTURES.find((fixture) => fixture.id === score.fixtureId)?.category || "")).every((score) => !score.harmfulDuplicateSideEffect),
  };
}
