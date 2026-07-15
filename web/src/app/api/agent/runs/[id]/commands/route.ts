import { NextResponse } from "next/server";
import { enqueueClientControlCommand } from "@/lib/runs";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { text?: unknown } | null;
  const result = enqueueClientControlCommand(id, request.headers.get("x-lal-control-token") || "", body?.text);
  return result.ok ? NextResponse.json(result, { status: 201 }) : NextResponse.json(result, { status: result.error === "client run not found" ? 404 : 403 });
}
