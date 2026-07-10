import { NextRequest, NextResponse } from "next/server";
import { overrideHiveNode } from "@/lib/hive/engine";

export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.nodeId !== "string" || !["skip", "retry"].includes(body.action)) return NextResponse.json({ error: "nodeId and action (skip|retry) are required" }, { status: 400 });
  try { overrideHiveNode(id, body.nodeId, body.action); return NextResponse.json({ ok: true }); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 409 }); }
}
