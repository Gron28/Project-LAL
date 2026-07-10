import { NextRequest, NextResponse } from "next/server";
import { evaluateHiveRelease, evaluateSpecialistPromotion } from "@/lib/hive/evaluation";

export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    if (body.kind === "release") return NextResponse.json(evaluateHiveRelease(body.metrics));
    if (body.kind === "specialist") return NextResponse.json(evaluateSpecialistPromotion(body.metrics));
    return NextResponse.json({ error: "kind must be release or specialist" }, { status: 400 });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}
