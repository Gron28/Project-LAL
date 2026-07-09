import { NextResponse } from "next/server";
import { modelReport } from "@/lib/autopsy";

export const dynamic = "force-dynamic";

// GET /api/agent/runs/report — the per-model scoreboard aggregated from every
// terminal run ledger on disk: clean/flawed/failed verdicts, tool failure rates,
// decode speed, token confidence, and each model's most common failure codes.
// This is "measure what works" — the input the evolution loop retrains against.
export function GET() {
  return NextResponse.json(modelReport());
}
