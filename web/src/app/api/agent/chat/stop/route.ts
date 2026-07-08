import { NextRequest, NextResponse } from "next/server";
import { stopRun } from "@/lib/runs";

export const dynamic = "force-dynamic";

// Real stop: chat generations run inside the run manager now, so stopping one
// aborts the upstream decode server-side. (The old version of this endpoint was a
// no-op — the model kept generating on the GPU after every "Stop".)
// Accepts {runId} (new client) or {genId} (older client field name, same meaning).
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const id = String(b.runId || b.genId || "");
  return NextResponse.json({ ok: true, stopped: id ? stopRun(id) : false });
}
