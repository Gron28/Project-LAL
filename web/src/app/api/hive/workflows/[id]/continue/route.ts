import { NextRequest, NextResponse } from "next/server";
import { continueHiveWorkflow } from "@/lib/hive/engine";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(continueHiveWorkflow(id, String(body.message || ""), body), { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
