import { NextResponse } from "next/server";
import { stopAllRuns } from "@/lib/runs";
import { stopAllHiveWorkflows } from "@/lib/hive/engine";
import { stopAllServing } from "@/lib/lab";

export const dynamic = "force-dynamic";

// Deliberately separate from the per-run stop route: this is the explicit
// emergency brake when a user suspects detached or invisible agent loops are
// consuming the local GPU.
export async function POST() {
  // Mark Hive records cancelled before aborting the generic controllers.  The
  // latter still owns all code/chat/deliberation runs and any queued Hive jobs.
  const hiveIds = stopAllHiveWorkflows();
  const stopped = stopAllRuns();
  await stopAllServing();
  return NextResponse.json({ ok: true, stopping: stopped.length, runIds: stopped, hiveIds, gpuReleased: true });
}
