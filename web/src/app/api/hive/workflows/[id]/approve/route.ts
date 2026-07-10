import { NextRequest, NextResponse } from "next/server";
import { approveHiveAction } from "@/lib/hive/engine";

export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await params; // workflow identity is part of the resource URL; approval IDs are globally unique.
  const body = await req.json().catch(() => ({}));
  if (typeof body.callId !== "string" || typeof body.allow !== "boolean") return NextResponse.json({ error: "callId and allow are required" }, { status: 400 });
  return approveHiveAction(body.callId, body.allow) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "pending approval not found" }, { status: 404 });
}
