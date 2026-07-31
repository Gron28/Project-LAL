import { NextRequest, NextResponse } from "next/server";
import { editHiveTaskContract } from "@/lib/hive/engine";
import { getWorkflow } from "@/lib/hive/store";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workflow = getWorkflow(id);
  return workflow
    ? NextResponse.json({ envelope: workflow.envelope, verdict: workflow.working.verdict || null })
    : NextResponse.json({ error: "workflow not found" }, { status: 404 });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  try {
    return NextResponse.json({ envelope: editHiveTaskContract(id, body.envelope || body) });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 409 });
  }
}
