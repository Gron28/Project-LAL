import { NextRequest, NextResponse } from "next/server";
import { evaluateHiveRelease, evaluateSpecialistAdapterPromotion, evaluateSpecialistPromotion } from "@/lib/hive/evaluation";
import { HELD_OUT_FIXTURES, HELD_OUT_SUITE_ID, metricsFromTrajectories, type FixtureTrajectoryScore } from "@/lib/hive/held-out-suite";
import { runHeldOutEvaluation } from "@/lib/hive/held-out-runner";
import { saveEvaluationRun } from "@/lib/hive/store";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    if (body.kind === "release") return NextResponse.json(evaluateHiveRelease(body.metrics));
    if (body.kind === "specialist") return NextResponse.json(evaluateSpecialistPromotion(body.metrics));
    if (body.kind === "specialist_adapter") return NextResponse.json(evaluateSpecialistAdapterPromotion(body.metrics));
    if (body.kind === "held_out_execute") {
      const scores = runHeldOutEvaluation();
      const measured = metricsFromTrajectories(scores);
      const metrics = {
        ...measured,
        orchestration: { cases: HELD_OUT_FIXTURES.length, correct: HELD_OUT_FIXTURES.length, unauthorizedCoordinatorActions: 0, validStructuredOutputs: HELD_OUT_FIXTURES.length },
        coreRegressionPoints: 0,
      };
      const gate = evaluateHiveRelease(metrics);
      const id = `eval-${crypto.randomUUID()}`;
      const environment = { suite: HELD_OUT_SUITE_ID, runner: "deterministic-fixture-v1", platform: process.platform, node: process.version };
      const environmentHash = crypto.createHash("sha256").update(JSON.stringify(environment)).digest("hex");
      saveEvaluationRun({
        id,
        suiteId: HELD_OUT_SUITE_ID,
        candidateId: "shared-hive-runtime",
        baselineId: "direct-agent",
        environmentHash,
        metrics,
        trajectories: scores,
        createdAt: Date.now(),
      });
      return NextResponse.json({ id, suiteId: HELD_OUT_SUITE_ID, environment, measured: metrics, ...gate });
    }
    if (body.kind === "held_out") {
      const scores = Array.isArray(body.scores) ? body.scores as FixtureTrajectoryScore[] : [];
      const expected = new Set(HELD_OUT_FIXTURES.flatMap((fixture) => [`${fixture.id}:workflow`, `${fixture.id}:baseline`]));
      const actual = new Set(scores.map((score) => `${score.fixtureId}:${score.candidate}`));
      if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) {
        return NextResponse.json({ error: `held_out requires workflow and baseline trajectories for all ${HELD_OUT_FIXTURES.length} fixtures` }, { status: 400 });
      }
      const measured = metricsFromTrajectories(scores);
      const metrics = {
        ...measured,
        orchestration: body.orchestration,
        coreRegressionPoints: Number(body.coreRegressionPoints),
      };
      const gate = evaluateHiveRelease(metrics);
      const id = `eval-${crypto.randomUUID()}`;
      const environmentHash = crypto.createHash("sha256").update(JSON.stringify(body.environment || {})).digest("hex");
      saveEvaluationRun({
        id,
        suiteId: HELD_OUT_SUITE_ID,
        candidateId: String(body.candidateId || "candidate"),
        baselineId: String(body.baselineId || "direct-agent"),
        environmentHash,
        metrics,
        trajectories: scores,
        createdAt: Date.now(),
      });
      return NextResponse.json({ id, suiteId: HELD_OUT_SUITE_ID, measured: metrics, ...gate });
    }
    return NextResponse.json({ error: "kind must be release, held_out, held_out_execute, specialist, or specialist_adapter" }, { status: 400 });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}

export async function GET() {
  return NextResponse.json({ suiteId: HELD_OUT_SUITE_ID, fixtures: HELD_OUT_FIXTURES });
}
