import { NextRequest } from "next/server";
import { guardianOwnerReport } from "@/lib/guardian-report";
import { readGuardianOwnerSession } from "@/lib/guardian-owner-auth";

export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  if (!readGuardianOwnerSession(request)) return Response.json({ error: "pair this browser as the LAL owner first" }, { status: 401 });
  return new Response(guardianOwnerReport(), { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": "attachment; filename=lal-guardian-owner-report.md", "cache-control": "no-store" } });
}
