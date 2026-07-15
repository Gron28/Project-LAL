import { NextResponse } from "next/server";
import { cliAuthenticatedDeviceId, cliAuthorized, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";
import { accessClientRun, heartbeatClientRun } from "@/lib/runs";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "client run heartbeat", authorized);
  if (!authorized) return unauthorizedResponse();
  const deviceId = cliAuthenticatedDeviceId(request);
  if (!deviceId) return NextResponse.json({ error: "a valid x-lal-device-id is required" }, { status: 400 });
  const { id } = await params;
  const access = accessClientRun(id, deviceId, request.headers.get("x-lal-run-token") || "");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.error === "client run not found" ? 404 : 403 });
  const body = await request.json().catch(() => null) as { ackCommand?: { id?: unknown; leaseId?: unknown } } | null;
  return NextResponse.json({ ok: true, ...heartbeatClientRun(access.meta, body?.ackCommand) });
}
