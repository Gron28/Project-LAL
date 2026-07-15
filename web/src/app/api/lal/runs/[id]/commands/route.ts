import { NextResponse } from "next/server";
import { cliAuthenticatedDeviceId, cliAuthorized, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";
import { enqueueClientCommand } from "@/lib/runs";

export const dynamic = "force-dynamic";

/** A paired controller may queue only a bounded text submission. This is not a
 * remote shell, approval, or arbitrary-event endpoint. The single-user pairing
 * token is the present owner-authentication boundary. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "client run command", authorized);
  if (!authorized) return unauthorizedResponse();
  const requesterDeviceId = cliAuthenticatedDeviceId(request);
  if (!requesterDeviceId) return NextResponse.json({ error: "a valid x-lal-device-id is required" }, { status: 400 });
  const { id } = await params;
  const body = await request.json().catch(() => null) as { type?: unknown; text?: unknown } | null;
  if (body?.type !== "submit") return NextResponse.json({ error: "only submit commands are supported" }, { status: 400 });
  const result = enqueueClientCommand(id, requesterDeviceId, body.text);
  return result.ok ? NextResponse.json(result, { status: 201 }) : NextResponse.json(result, { status: result.error === "client run not found" ? 404 : 409 });
}
