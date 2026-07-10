import { NextRequest, NextResponse } from "next/server";
import { approveTrainingExample, attributionReport, decideCheckpointPromotion, migrateJsonlCorpus, proposeCorrectiveExample, provenanceSummary, registerCheckpoint } from "@/lib/hive/provenance";

export const dynamic = "force-dynamic";
export async function GET() { return NextResponse.json(provenanceSummary()); }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    switch (body.action) {
      case "migrate_jsonl":
        if (!body.approved) return NextResponse.json({ error: "human approval is required before registering a corpus" }, { status: 403 });
        return NextResponse.json({ manifest: migrateJsonlCorpus(body.path, body.metadata || { source: body.path }) });
      case "propose_example": return NextResponse.json({ id: proposeCorrectiveExample(body.input) }, { status: 202 });
      case "approve_example": return NextResponse.json({ ok: approveTrainingExample(body.id, !!body.approved) });
      case "register_checkpoint":
        if (!body.approved) return NextResponse.json({ error: "training/checkpoint registration approval is required" }, { status: 403 });
        registerCheckpoint(body.input); return NextResponse.json({ ok: true }, { status: 201 });
      case "promote_checkpoint":
        if (!body.secondApproval) return NextResponse.json({ error: "a separate promotion approval is required" }, { status: 403 });
        return NextResponse.json({ ok: decideCheckpointPromotion(body.id, !!body.approved) });
      case "attribute": return NextResponse.json(attributionReport(String(body.failure || "")));
      default: return NextResponse.json({ error: "unknown provenance action" }, { status: 400 });
    }
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}
