import { NextRequest, NextResponse } from "next/server";
import { editHiveExecutionPolicy, editHivePlan, forkHiveWorkflow, rewindHiveWorkflow } from "@/lib/hive/engine";
import { appendHiveEvent, decideEvidence } from "@/lib/hive/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === "fork") return NextResponse.json(forkHiveWorkflow(id), { status: 201 });
    if (body.action === "rewind") return NextResponse.json(rewindHiveWorkflow(id, String(body.nodeId || "")));
    if (body.action === "execution_policy") {
      editHiveExecutionPolicy(id, { budget: body.budget, preferredModel: body.preferredModel, controlMode: body.controlMode });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "plan") {
      if (!body.dependencies || typeof body.dependencies !== "object" || Array.isArray(body.dependencies)) throw new Error("dependencies object is required");
      editHivePlan(id, body.dependencies as Record<string, string[]>);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "evidence") {
      if (body.decision !== "pinned" && body.decision !== "rejected") throw new Error("decision must be pinned or rejected");
      decideEvidence(id, String(body.evidenceId || ""), body.decision, String(body.reason || ""));
      appendHiveEvent(id, { kind: "evidence_decision", lifecycle: "operator_intervention", payload: { actor: "local-owner", evidenceId: body.evidenceId, decision: body.decision, reason: body.reason || "" } });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "output") {
      if (body.decision !== "useful" && body.decision !== "defective") throw new Error("decision must be useful or defective");
      appendHiveEvent(id, { kind: "output_decision", lifecycle: "operator_intervention", payload: { actor: "local-owner", decision: body.decision, reason: String(body.reason || "").slice(0, 2_000) } });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "action must be fork, rewind, execution_policy, plan, evidence, or output" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
