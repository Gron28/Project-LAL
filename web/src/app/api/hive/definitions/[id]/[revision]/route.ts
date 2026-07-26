import { NextResponse } from "next/server";
import { getWorkflowRevisionRepository } from "@/lib/hive/graph-revisions";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; revision: string }> }) {
  const { id, revision } = await params;
  const record = getWorkflowRevisionRepository().get(id, revision);
  return record ? NextResponse.json({ revision: record }, { headers: { "cache-control": "no-store" } }) : NextResponse.json({ error: "workflow revision not found" }, { status: 404 });
}
