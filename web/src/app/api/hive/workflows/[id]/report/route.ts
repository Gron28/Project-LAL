import { NextRequest, NextResponse } from "next/server";
import { buildPostRunReport, redactPostRunReport } from "@/lib/hive/post-run-report";
import { workflowSnapshot } from "@/lib/hive/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snapshot = workflowSnapshot(id, 2_000);
  if (!snapshot) return NextResponse.json({ error: "workflow not found" }, { status: 404 });
  const report = buildPostRunReport(snapshot.workflow, snapshot.nodes, snapshot.evidence, snapshot.events);
  return NextResponse.json(req.nextUrl.searchParams.get("redacted") === "1" ? redactPostRunReport(report) : report);
}
