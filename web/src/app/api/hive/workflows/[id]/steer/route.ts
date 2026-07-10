import { NextRequest, NextResponse } from "next/server";
import { steerHiveWorkflow } from "@/lib/hive/engine";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.message !== "string" || !body.message.trim()) return NextResponse.json({ error: "message is required" }, { status: 400 });
  try { return NextResponse.json(steerHiveWorkflow(id, body.message, !!body.pause)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 409 }); }
}
