import { NextRequest, NextResponse } from "next/server";
import { startTrain, stopTrain, trainStatus, listTrainRuns, listExperiments, deleteTrainRun, getBattery, TRAIN_BASES } from "@/lib/lab";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const name = new URL(req.url).searchParams.get("name") || "";
  return NextResponse.json({ ...trainStatus(name), bases: TRAIN_BASES, runs: listTrainRuns(), experiments: listExperiments() });
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  if (b.action === "stop") return NextResponse.json(stopTrain());
  return NextResponse.json(await startTrain({
    name: b.name || "model",
    base: b.base || TRAIN_BASES[0],
    steps: +(b.steps || 150),
    lr: +(b.lr || 0.0002),
    targetLoss: b.targetLoss != null ? +b.targetLoss : 0.1,
    patience: b.patience != null ? +b.patience : undefined,
    mode: b.mode === "sft" ? "sft" : b.mode === "hqq" ? "hqq" : "raw",
    dataFile: b.dataFile || "",
    text: b.text || "",
    valFrac: b.valFrac != null ? +b.valFrac : undefined,
    block: b.block != null ? +b.block : undefined,
    // true -> the whole battery; or an explicit list of suite ids
    autoBench: b.autoBench === true ? getBattery().suites : Array.isArray(b.autoBench) ? b.autoBench.map(String) : undefined,
    snapshotEvery: b.snapshotEvery != null ? +b.snapshotEvery : undefined,
    noProbeEmbed: !!b.noProbeEmbed,
  }));
}

export async function DELETE(req: NextRequest) {
  const name = new URL(req.url).searchParams.get("name") || "";
  const result = deleteTrainRun(name);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
