import { NextRequest, NextResponse } from "next/server";
import { deleteRun, getRun, getRunTrace } from "@/lib/runs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (new URL(req.url).searchParams.get("trace") === "1") {
    return NextResponse.json({ run, trace: getRunTrace(id) });
  }
  return NextResponse.json(run);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = deleteRun(id);
  return NextResponse.json(result, { status: result.ok ? 200 : result.error === "run not found" ? 404 : 409 });
}
