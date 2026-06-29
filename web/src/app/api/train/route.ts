import { NextRequest, NextResponse } from "next/server";
import { startTrain, trainStatus, listTrainRuns, TRAIN_BASES } from "@/lib/lab";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const name = new URL(req.url).searchParams.get("name") || "";
  return NextResponse.json({ ...trainStatus(name), bases: TRAIN_BASES, runs: listTrainRuns() });
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  return NextResponse.json(startTrain({
    name: b.name || "model",
    base: b.base || TRAIN_BASES[0],
    steps: +(b.steps || 150),
    lr: +(b.lr || 0.0002),
    text: b.text || "",
  }));
}
