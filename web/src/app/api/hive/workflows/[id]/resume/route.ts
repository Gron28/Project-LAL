import { NextRequest, NextResponse } from "next/server";
import { resumeHiveWorkflow } from "@/lib/hive/engine";

export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try { return NextResponse.json({ ok: true, runId: resumeHiveWorkflow(id, body.preferredModel, !!body.autoApprove) }, { status: 202 }); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 409 }); }
}
