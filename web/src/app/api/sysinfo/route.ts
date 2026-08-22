import { readSysInfo } from "@/lib/sysinfo";
import { servingInfo, stopAllServing } from "@/lib/lab";
import { anyRunLive } from "@/lib/runs";
import { readRuntimeStatus } from "@/lib/runtime-status";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ...(await readSysInfo()), serving: servingInfo(), runLive: anyRunLive(), runtime: readRuntimeStatus() });
}

// Manual "unload GPU now" (the nav indicator's button). Refused while a run is
// live — killing the model under an active loop would fail the run mid-flight.
export async function DELETE(request: Request) {
  const authorization = authorizeBrowserMutation(request);
  if (!authorization.ok) return Response.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  if (anyRunLive()) return Response.json({ ok: false, error: "a run is live — stop it first" }, { status: 409 });
  await stopAllServing();
  return Response.json({ ok: true });
}
