import { NextResponse } from "next/server";
import { cliAuthenticatedDeviceId, cliAuthorized, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";
import { createClientRun, type ClientRunInit } from "@/lib/runs";

export const dynamic = "force-dynamic";

function deviceFor(request: Request): string | Response {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "client run registration", authorized);
  if (!authorized) return unauthorizedResponse();
  const deviceId = cliAuthenticatedDeviceId(request);
  return deviceId || NextResponse.json({ error: "a valid x-lal-device-id is required" }, { status: 400 });
}

/** Register a run that executes on a paired terminal. The server creates the
 * durable id/capability and accepts only display metadata; no remote path is
 * ever resolved or stored as a server workspace. */
export async function POST(request: Request) {
  const device = deviceFor(request);
  if (device instanceof Response) return device;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  const kind = ["code", "chat", "deliberate", "hive"].includes(String(body.kind)) ? String(body.kind) as ClientRunInit["kind"] : "code";
  const project = body.project && typeof body.project === "object" ? body.project as Record<string, unknown> : null;
  const { meta, ingestToken, controlToken } = createClientRun({
    kind,
    conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
    // Deliberately accept a display label only. path/pathHint/fingerprint are not
    // persisted here because this host must not pretend it owns a client workspace.
    projectLabel: typeof body.projectLabel === "string" ? body.projectLabel : typeof project?.label === "string" ? project.label : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    mode: typeof body.mode === "string" ? body.mode : undefined,
  }, device);
  return NextResponse.json({ run: meta, ingestToken, controlToken, heartbeatIntervalMs: 30_000 }, { status: 201 });
}
