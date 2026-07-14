import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { deleteHiveWorkflow, workflowSnapshot } from "@/lib/hive/engine";
import { diagnoseHiveWorkflow } from "@/lib/hive/autopsy";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const eventLimit = Math.min(10_000, Math.max(1, Number(req.nextUrl.searchParams.get("events")) || 300));
  const eventAfter = Math.max(0, Number(req.nextUrl.searchParams.get("after")) || 0);
  const snapshot = workflowSnapshot(id, eventLimit, eventAfter);
  if (!snapshot) return NextResponse.json({ error: "workflow not found" }, { status: 404 });
  // Older coding runs predate the explicit workspace field, but they still ran
  // in process.cwd(). Surface that effective path so their files are visible too.
  const workflow = snapshot.workflow.kind === "coding" && !snapshot.workflow.envelope.workspace
    ? { ...snapshot.workflow, envelope: { ...snapshot.workflow.envelope, workspace: path.resolve(process.cwd()) } }
    : snapshot.workflow;
  return NextResponse.json({ ...snapshot, workflow, diagnosis: diagnoseHiveWorkflow(id) });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ok = deleteHiveWorkflow(id);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "workflow not found" }, { status: 404 });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 409 }); }
}
