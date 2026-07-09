import { NextResponse } from "next/server";
import { stopAllRuns } from "@/lib/runs";

export const dynamic = "force-dynamic";

// Deliberately separate from the per-run stop route: this is the explicit
// emergency brake when a user suspects detached or invisible agent loops are
// consuming the local GPU.
export function POST() {
  const stopped = stopAllRuns();
  return NextResponse.json({ ok: true, stopping: stopped.length, runIds: stopped });
}
