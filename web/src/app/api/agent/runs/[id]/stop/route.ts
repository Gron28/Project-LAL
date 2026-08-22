import { NextRequest, NextResponse } from "next/server";
import { getRun, stopRun } from "@/lib/runs";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";

export const dynamic = "force-dynamic";

// Real server-side stop: aborts the run's controller, which cancels the upstream
// model fetch (llama-server stops decoding) and unwinds the tool loop at the next
// checkpoint. This replaces the old Stop, which only aborted the browser's own
// connection while the loop kept running unattended.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  const { id } = await params;
  if (stopRun(id)) return NextResponse.json({ ok: true, stopping: true });
  const meta = getRun(id);
  if (!meta) return NextResponse.json({ ok: false, error: "no such run" }, { status: 404 });
  // Not live: nothing to stop, but that's a success from the caller's point of view.
  return NextResponse.json({ ok: true, stopping: false, status: meta.status });
}
