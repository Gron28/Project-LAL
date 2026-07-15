import { NextResponse } from "next/server";
import { cliAuthenticatedDeviceId, cliAuthorized, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";
import { accessClientRun, appendClientEvents, type ClientEventInput } from "@/lib/runs";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "client run events", authorized);
  if (!authorized) return unauthorizedResponse();
  const deviceId = cliAuthenticatedDeviceId(request);
  if (!deviceId) return NextResponse.json({ error: "a valid x-lal-device-id is required" }, { status: 400 });
  const { id } = await params;
  const access = accessClientRun(id, deviceId, request.headers.get("x-lal-run-token") || "");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.error === "client run not found" ? 404 : 403 });
  const body = await request.json().catch(() => null) as { events?: unknown } | null;
  const result = appendClientEvents(access.meta, Array.isArray(body?.events) ? body.events as ClientEventInput[] : []);
  return result.ok ? NextResponse.json(result) : NextResponse.json(result, { status: 400 });
}
