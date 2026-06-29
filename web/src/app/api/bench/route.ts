import { NextRequest, NextResponse } from "next/server";
import { runBench } from "@/lib/lab";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  if (!b.model) return NextResponse.json({ error: "no model" }, { status: 400 });
  try {
    return NextResponse.json(await runBench(b.model));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
