import { NextResponse } from "next/server";
import { buildMissionDashboard } from "@/lib/hive/mission-dashboard";
import { workflowSnapshot } from "@/lib/hive/store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snapshot = workflowSnapshot(id, 2_000);
  if (!snapshot) return NextResponse.json({ error: "workflow not found" }, { status: 404 });
  return NextResponse.json(buildMissionDashboard(snapshot.workflow, snapshot.nodes, snapshot.evidence, snapshot.events));
}
