import { cliAuthorized, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "heartbeat", authorized);
  if (!authorized) return unauthorizedResponse();
  return Response.json({ ok: true, seenAt: new Date().toISOString() });
}
