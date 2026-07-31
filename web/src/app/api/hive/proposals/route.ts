import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { createImprovementProposal, listImprovementProposals } from "@/lib/hive/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ proposals: listImprovementProposals() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    const kind = String(body.kind) as "prompt" | "tool" | "routing" | "workflow" | "acceptance" | "model";
    if (!["prompt", "tool", "routing", "workflow", "acceptance", "model"].includes(kind)) throw new Error("invalid proposal kind");
    const proposal = createImprovementProposal({
      id: `proposal-${crypto.randomUUID()}`,
      kind,
      summary: String(body.summary || "").trim(),
      supportingFailures: Array.isArray(body.supportingFailures) ? body.supportingFailures.map(String) : [],
      expectedMetrics: body.expectedMetrics && typeof body.expectedMetrics === "object" ? body.expectedMetrics : {},
    });
    return NextResponse.json(proposal, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
