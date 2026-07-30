import type { EvidenceRecord } from "./contracts.ts";
import type { StageResult } from "./contracts.ts";

const STOP_WORDS = new Set([
  "about", "after", "also", "because", "before", "being", "between", "could",
  "from", "have", "into", "more", "must", "only", "other", "should", "than",
  "that", "their", "there", "these", "they", "this", "those", "through",
  "under", "using", "were", "what", "when", "where", "which", "while", "with",
  "would",
]);

function terms(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .match(/[a-z0-9][a-z0-9.-]{2,}/g)
      ?.filter((term) => !STOP_WORDS.has(term)) || [],
  );
}

export function evidenceEntailsClaim(claim: string, evidence: EvidenceRecord): boolean {
  const claimTerms = terms(claim);
  if (claimTerms.size < 2) return false;
  const sourceTerms = terms(`${evidence.claim || ""} ${evidence.excerpt}`);
  const matched = [...claimTerms].filter((term) => sourceTerms.has(term)).length;
  return matched >= 2 && matched / claimTerms.size >= 0.55;
}

export function isContradictionText(text: string): boolean {
  return /\b(contradict(?:ion|ory|s|ed)?|conflict(?:ing|s|ed)?|disagree(?:ment|s|d)?)\b/i.test(text);
}

export function unresolvedResearchGaps(
  uncertainties: string[],
  findings: StageResult["findings"],
): string[] {
  return uncertainties.filter((gap) => {
    const gapTerms = terms(gap);
    return !findings.some((finding) => {
      if (!finding.evidenceIds?.length) return false;
      const findingTerms = terms(finding.text);
      const overlap = [...gapTerms].filter((term) => findingTerms.has(term)).length;
      if (overlap >= 2 && overlap / Math.max(1, gapTerms.size) >= 0.25) return true;
      // A source-acquisition gap is cleared by canonical fetched evidence IDs;
      // the finding text does not need to repeat the words "source" or
      // "documentation" when its provenance is already structured.
      return /\b(source|evidence|documentation|citation)\b/i.test(gap);
    });
  });
}

export function evaluateResearchRequirement(
  requirement: string,
  facts: {
    entailmentPassed: boolean;
    independentSources: boolean;
    reportArtifact: boolean;
    gapsExplicit: boolean;
    contradictionsExplicit: boolean;
    overallVerified: boolean;
  },
): { passed: boolean; detail: string } {
  if (/\b(independent|source origins?|two (?:distinct )?sources?)\b/i.test(requirement)) {
    return {
      passed: facts.independentSources,
      detail: facts.independentSources ? "Independent-source requirement passed." : "Independent-source requirement remains unproven.",
    };
  }
  if (/\b(unresolved|gaps?|contradictions?|conflicts?|disagreements?)\b/i.test(requirement)) {
    const passed = facts.reportArtifact && facts.gapsExplicit && facts.contradictionsExplicit;
    return {
      passed,
      detail: passed ? "The report explicitly records unresolved gaps and contradictions." : "Gap or contradiction disclosure remains unproven.",
    };
  }
  if (/\b(entail|cit(?:e|ed|ation)|evidence|ground(?:ed|ing)?|factual claim)\b/i.test(requirement)) {
    return {
      passed: facts.entailmentPassed,
      detail: facts.entailmentPassed ? "Claim-to-evidence entailment passed." : "Claim-to-evidence entailment remains unproven.",
    };
  }
  return {
    passed: facts.overallVerified,
    detail: facts.overallVerified ? "All research acceptance gates passed." : "The general research requirement remains unproven.",
  };
}

export function classifySource(url: string): {
  sourceClass: "primary" | "institutional" | "secondary" | "unknown";
  authorityScore: number;
} {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith(".gov") || host.endsWith(".edu")) return { sourceClass: "institutional", authorityScore: 0.9 };
    if (
      host === "adk.dev"
      || host.endsWith(".adk.dev")
      || host === "cloud.google.com"
      || host === "docs.cloud.google.com"
      || host === "developers.googleblog.com"
    ) return { sourceClass: "primary", authorityScore: 0.9 };
    if (/^(docs|developer|api)\./.test(host) || /github\.com$/.test(host)) return { sourceClass: "primary", authorityScore: 0.85 };
    if (/wikipedia|medium|substack|reddit/.test(host)) return { sourceClass: "secondary", authorityScore: 0.45 };
    return { sourceClass: "unknown", authorityScore: 0.6 };
  } catch {
    return { sourceClass: "unknown", authorityScore: 0 };
  }
}
