import { NextRequest, NextResponse } from "next/server";
import { deleteRun, getRun, getRunTrace } from "@/lib/runs";
import { diagnoseRun } from "@/lib/autopsy";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (new URL(req.url).searchParams.get("trace") === "1") {
    // trace + diagnosis travel together: the Library's inspector shows WHAT
    // happened (trace) and WHY it counts as clean/flawed/failed (diagnosis).
    return NextResponse.json({ run, trace: getRunTrace(id), diagnosis: diagnoseRun(id) });
  }
  return NextResponse.json(run);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  const { id } = await params;
  const result = deleteRun(id);
  return NextResponse.json(result, { status: result.ok ? 200 : result.error === "run not found" ? 404 : 409 });
}
