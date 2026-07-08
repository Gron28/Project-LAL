import { readSysInfo } from "@/lib/sysinfo";
import { servingInfo, stopServing } from "@/lib/lab";
import { anyRunLive } from "@/lib/runs";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ...(await readSysInfo()), serving: servingInfo(), runLive: anyRunLive() });
}

// Manual "unload GPU now" (the nav indicator's button). Refused while a run is
// live — killing the model under an active loop would fail the run mid-flight.
export async function DELETE() {
  if (anyRunLive()) return Response.json({ ok: false, error: "a run is live — stop it first" }, { status: 409 });
  stopServing();
  return Response.json({ ok: true });
}
