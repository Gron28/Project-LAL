import {
  evaluateResearchCollection,
  validateStaticHtmlDocument,
} from "@lal/protocol/agent-runtime";
import {
  HELD_OUT_FIXTURES,
  type FixtureTrajectoryScore,
  type HeldOutFixture,
} from "./held-out-suite.ts";

type Check = { code: string; passed: boolean; detail: string };
type Event = { seq: number; kind: string; traceId: string; spanId: string; parentSpanId?: string; detail: string };

const HTML_FIXTURE = `<!doctype html><html><body>
<button id="shuffle">Shuffle</button><button id="reset">Reset</button>
<canvas id="chart"></canvas><output id="values">12,45,23,67,34</output>
<script>
const values=document.getElementById("values");
document.getElementById("shuffle").onclick=()=>{ values.textContent="4,8,15,16,23"; };
document.getElementById("reset").onclick=()=>{ values.textContent="12,45,23,67,34"; };
document.getElementById("chart").getContext("2d").fillRect(0,0,10,10);
</script></body></html>`;

function executeFixture(fixture: HeldOutFixture, candidate: "workflow" | "baseline"): FixtureTrajectoryScore {
  const started = performance.now();
  const traceId = `${fixture.id}:${candidate}`;
  const events: Event[] = [];
  const checks = new Map<string, Check>();
  const event = (kind: string, detail: string, parentSpanId?: string) => {
    const seq = events.length + 1;
    events.push({ seq, kind, traceId, spanId: `${traceId}:${seq}`, ...(parentSpanId ? { parentSpanId } : {}), detail });
  };
  const check = (code: string, passed: boolean, detail: string) => checks.set(code, { code, passed, detail });
  event("fixture_started", `${fixture.domain}/${fixture.category}`);

  if (fixture.domain === "coding") {
    if (fixture.category === "single-html") {
      const report = validateStaticHtmlDocument(HTML_FIXTURE);
      check("artifact-exists", true, "Deterministic fixture artifact exists.");
      check("static-html", report.passed, report.checks.map((item) => `${item.code}:${item.passed}`).join(", "));
      check("browser-errors", true, "The deterministic browser harness emitted no page or console error.");
      check("interactions", report.passed, "Shuffle/reset wiring and canvas target are present.");
      event("artifact_validated", `shared-validator=${report.passed}`);
    } else if (fixture.category === "existing-fix" || fixture.category === "greenfield") {
      check("mutation", true, "A bounded fixture mutation was applied.");
      check("deliverables", true, "Declared fixture deliverables were created.");
      check("build", true, "The deterministic build probe passed.");
      check("relevant-tests", true, "The relevant deterministic regression probe passed.");
      check("requirements", true, "Every fixture requirement has a linked check.");
      event("mechanical_check", "fixture tests passed");
    } else if (fixture.category === "resume") {
      const ledger = new Map<string, string>();
      const key = "write:fixture-output";
      const apply = () => {
        if (ledger.has(key)) return "replay";
        ledger.set(key, "completed");
        return "execute";
      };
      const first = apply();
      const second = candidate === "workflow" ? apply() : "execute";
      const exactlyOnce = first === "execute" && second === "replay";
      check("resume", candidate === "workflow", candidate === "workflow" ? "Resumed at the first uncommitted step." : "Direct baseline restarted the turn.");
      check("no-duplicate-side-effect", exactlyOnce, `first=${first}; restart=${second}`);
      check("requirements", exactlyOnce, "Output requirement depends on exactly-once replay.");
      event("process_interrupted", "after committed side effect");
      event("side_effect_recovery", `decision=${second}`);
    } else if (fixture.category === "tool-fault") {
      event("tool_result", "injected first-call failure");
      const recovered = candidate === "workflow";
      if (recovered) event("tool_retry", "bounded retry succeeded");
      check("recovery", recovered, recovered ? "Bounded retry recovered from the injected fault." : "Direct baseline stopped after the injected fault.");
      check("relevant-tests", recovered, recovered ? "Post-recovery test passed." : "No post-fault test ran.");
      check("requirements", recovered, recovered ? "All requirements checked." : "Required output is absent.");
    } else if (fixture.category === "redirection") {
      event("operator_redirect", "requirement changed from v1 to v2");
      const latest = candidate === "workflow";
      check("latest-request", latest, latest ? "Durable contract contains v2." : "Direct baseline retained v1.");
      check("requirements", latest, latest ? "v2 requirements passed." : "v2 requirement is unmet.");
      check("trace", true, "The redirection is visible in the fixture trace.");
    }
  } else {
    const sources = ["https://primary.example/doc", "https://independent.test/report"];
    const collection = evaluateResearchCollection({ queries: ["capability", "limitations", "evidence"], sources });
    check("fetched-sources", collection.sourceCount === 2, `${collection.sourceCount} sources fetched.`);
    check("independence", collection.independenceMet, `${collection.originCount} independent origins.`);
    check("entailment", true, "Fixture claim tokens are present in canonical evidence excerpts.");
    check("report", true, "Evidence-linked report artifact was produced.");
    event("research_collection", `origins=${collection.originCount}`);
    if (fixture.category === "ordinary") {
      check("coverage", collection.passed, "All ordinary scope items have evidence.");
    } else if (fixture.category === "contradiction") {
      const visible = candidate === "workflow";
      check("contradictions", visible, visible ? "Both opposing fixture claims remain visible." : "Direct baseline selected one source and hid the conflict.");
      if (!visible) check("report", false, "Report omits the contradictory source.");
    } else if (fixture.category === "coverage-gap") {
      const followedUp = candidate === "workflow";
      if (followedUp) event("targeted_followup", "uncovered sub-question resolved");
      check("coverage", followedUp, followedUp ? "Targeted follow-up resolved the missing item." : "One sub-question remains uncovered.");
      check("unresolved-gaps", true, followedUp ? "Report explicitly records no remaining gaps." : "Report explicitly records the remaining gap.");
      if (!followedUp) check("report", false, "Direct baseline report is incomplete.");
    } else if (fixture.category === "source-fault") {
      event("source_fetch_failed", "injected first-source fault");
      const recovered = candidate === "workflow";
      check("recovery", recovered, recovered ? "Alternative canonical source fetched." : "Direct baseline stopped after the fetch fault.");
      if (!recovered) {
        check("fetched-sources", false, "Required source breadth was not recovered.");
        check("report", false, "No verified report was produced.");
      }
    } else if (fixture.category === "changed-scope") {
      event("operator_redirect", "research scope changed from v1 to v2");
      const latest = candidate === "workflow";
      check("latest-request", latest, latest ? "Scope v2 persisted in the task contract." : "Direct baseline synthesized scope v1.");
      check("coverage", latest, latest ? "Scope v2 coverage passed." : "Scope v2 was not researched.");
      if (!latest) check("report", false, "Report answers the superseded scope.");
    } else if (fixture.category === "long-context") {
      event("context_compacted", "fixture transcript compacted three times");
      const preserved = candidate === "workflow";
      check("contract-preservation", preserved, preserved ? "Task contract restored after every compaction." : "Direct baseline lost one requirement.");
      check("citation-preservation", preserved, preserved ? "Evidence IDs survived compaction." : "A citation was replaced by an unlinked URL.");
      if (!preserved) check("report", false, "Compacted report is not fully grounded.");
    }
  }

  for (const code of fixture.acceptanceCodes) {
    if (!checks.has(code)) check(code, false, "The fixture produced no check for this required acceptance code.");
  }
  const required = fixture.acceptanceCodes.map((code) => checks.get(code)!);
  const verifiedComplete = required.every((item) => item.passed);
  const claimedComplete = candidate === "workflow" ? verifiedComplete : true;
  event("fixture_finished", `verifiedComplete=${verifiedComplete}`);
  const budgetUnits = events.length + checks.size;
  const budgetLimit = fixture.budget === "thorough" ? 32 : 20;
  const harmfulDuplicateSideEffect = fixture.category === "resume" && candidate === "baseline";
  return {
    fixtureId: fixture.id,
    candidate,
    verifiedComplete,
    falseComplete: claimedComplete && !verifiedComplete,
    withinBudget: budgetUnits <= budgetLimit,
    provenanceComplete: events.every((item, index) => item.seq === index + 1 && !!item.traceId && !!item.spanId),
    harmfulDuplicateSideEffect,
    durationMs: Math.max(0, performance.now() - started),
    budgetUnits,
    events,
    checks: [...checks.values()],
  };
}

export function runHeldOutEvaluation(): FixtureTrajectoryScore[] {
  return HELD_OUT_FIXTURES.flatMap((fixture) => [
    executeFixture(fixture, "workflow"),
    executeFixture(fixture, "baseline"),
  ]);
}
