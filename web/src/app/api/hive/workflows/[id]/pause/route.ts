import { NextResponse } from "next/server";
import { pauseHiveWorkflow } from "@/lib/hive/engine";

export const dynamic = "force-dynamic";
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return pauseHiveWorkflow(id) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "workflow not found" }, { status: 404 });
}
