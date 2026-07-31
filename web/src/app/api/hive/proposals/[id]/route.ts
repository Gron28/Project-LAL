import { NextRequest, NextResponse } from "next/server";
import { decideImprovementProposal, getImprovementProposal } from "@/lib/hive/store";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const proposal = getImprovementProposal(id);
  return proposal ? NextResponse.json(proposal) : NextResponse.json({ error: "proposal not found" }, { status: 404 });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    if (body.decision !== "promoted" && body.decision !== "rejected") throw new Error("decision must be promoted or rejected");
    return NextResponse.json(decideImprovementProposal(id, body.decision, String(body.evaluationRunId || ""), String(body.reason || "")));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
