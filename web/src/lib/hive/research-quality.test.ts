import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceRecord } from "./contracts.ts";
import { classifySource, evaluateResearchRequirement, evidenceEntailsClaim, isContradictionText, unresolvedResearchGaps } from "./research-quality.ts";

const evidence = (excerpt: string): EvidenceRecord => ({
  id: "ev-1",
  url: "https://docs.example.com/runtime",
  retrievedAt: 1,
  sourceHash: "hash",
  excerpt,
  stance: "supporting",
});

test("an existing but unrelated evidence record does not support a claim", () => {
  assert.equal(
    evidenceEntailsClaim("The runtime resumes from durable checkpoints", evidence("The API supports colorful dashboard themes.")),
    false,
  );
});

test("claim verification requires meaningful source overlap", () => {
  assert.equal(
    evidenceEntailsClaim("The runtime resumes from durable checkpoints", evidence("The runtime resumes execution from durable checkpoints after interruption.")),
    true,
  );
});

test("source classification favors direct documentation", () => {
  assert.deepEqual(classifySource("https://docs.example.com/runtime"), { sourceClass: "primary", authorityScore: 0.85 });
  assert.deepEqual(classifySource("https://adk.dev/evaluate/"), { sourceClass: "primary", authorityScore: 0.9 });
  assert.deepEqual(classifySource("https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/sessions/manage-sessions-adk"), { sourceClass: "primary", authorityScore: 0.9 });
});

test("contradiction language remains machine-visible", () => {
  assert.equal(isContradictionText("The two fetched sources directly disagree about resume support."), true);
  assert.equal(isContradictionText("Both sources document the same behavior."), false);
});

test("research criteria are scored from their own durable facts", () => {
  const facts = {
    entailmentPassed: false,
    independentSources: true,
    reportArtifact: true,
    gapsExplicit: true,
    contradictionsExplicit: true,
    overallVerified: false,
  };
  assert.equal(evaluateResearchRequirement("Every factual claim is entailed by evidence", facts).passed, false);
  assert.equal(evaluateResearchRequirement("At least two independent source origins", facts).passed, true);
  assert.equal(evaluateResearchRequirement("Unresolved gaps and contradictions are explicit", facts).passed, true);
});

test("evidence-linked findings clear copied stale gaps but not unrelated gaps", () => {
  const findings = [{
    id: "evaluation",
    text: "Primary ADK documentation describes built-in evaluation mechanisms and cites the evaluation guide.",
    evidenceIds: ["ev-1"],
  }];
  assert.deepEqual(
    unresolvedResearchGaps([
      "Whether ADK provides built-in evaluation mechanisms.",
      "The canonical documentation sources required to verify the claim.",
      "Whether ADK supports durable resumable workflows.",
    ], findings),
    ["Whether ADK supports durable resumable workflows."],
  );
});
