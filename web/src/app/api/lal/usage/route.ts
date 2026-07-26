import { cliAuthorized, recordCliAccess, unauthorizedResponse } from "@/lib/lal-cli";
import { readUsage, summarizeUsage } from "@/lib/usage-ledger";

export const dynamic = "force-dynamic";

/** Default window: the last 30 days. Long enough for weekday patterns to mean
 *  something, short enough that a full scan stays trivial. */
const DEFAULT_DAYS = 30;
const MAX_DAYS = 400;

export async function GET(request: Request) {
  const authorized = cliAuthorized(request);
  recordCliAccess(request, "usage analytics", authorized);
  if (!authorized) return unauthorizedResponse();

  const url = new URL(request.url);
  const requestedDays = Number(url.searchParams.get("days"));
  const days =
    Number.isFinite(requestedDays) && requestedDays > 0
      ? Math.min(Math.floor(requestedDays), MAX_DAYS)
      : DEFAULT_DAYS;
  const device = url.searchParams.get("device");

  const since = Date.now() - days * 86_400_000;
  let records = readUsage(since);
  // Per-user/per-device slicing: match either the opaque id or the friendly name,
  // since callers know one or the other.
  if (device) records = records.filter((r) => r.dev === device || r.devName === device);

  return Response.json({ days, device: device ?? null, ...summarizeUsage(records) });
}
