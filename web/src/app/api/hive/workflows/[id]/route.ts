import { NextRequest, NextResponse } from "next/server";
import { deleteHiveWorkflow, workflowSnapshot } from "@/lib/hive/engine";
import { diagnoseHiveWorkflow } from "@/lib/hive/autopsy";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snapshot = workflowSnapshot(id, Number(req.nextUrl.searchParams.get("events")) || 300);
  return snapshot ? NextResponse.json({ ...snapshot, diagnosis: diagnoseHiveWorkflow(id) }) : NextResponse.json({ error: "workflow not found" }, { status: 404 });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ok = deleteHiveWorkflow(id);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "workflow not found" }, { status: 404 });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 409 }); }
}
