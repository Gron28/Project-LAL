import { NextResponse } from "next/server";
import { cliAuthenticatedDeviceId, cliAuthorized, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";
import { accessClientRun, finishClientRun, type RunStatus } from "@/lib/runs";

export const dynamic = "force-dynamic";
const FINAL = new Set<RunStatus>(["done", "error", "stopped"]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "client run finish", authorized);
  if (!authorized) return unauthorizedResponse();
  const deviceId = cliAuthenticatedDeviceId(request);
  if (!deviceId) return NextResponse.json({ error: "a valid x-lal-device-id is required" }, { status: 400 });
  const { id } = await params;
  const access = accessClientRun(id, deviceId, request.headers.get("x-lal-run-token") || "");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.error === "client run not found" ? 404 : 403 });
  const body = await request.json().catch(() => null) as { status?: unknown; error?: unknown } | null;
  const status = typeof body?.status === "string" ? body.status as RunStatus : undefined;
  if (!status || !FINAL.has(status)) return NextResponse.json({ error: "status must be done, error, or stopped" }, { status: 400 });
  const result = finishClientRun(access.meta, status as Extract<RunStatus, "done" | "error" | "stopped">, typeof body?.error === "string" ? body.error : undefined);
  return result.ok ? NextResponse.json(result) : NextResponse.json(result, { status: 409 });
}
