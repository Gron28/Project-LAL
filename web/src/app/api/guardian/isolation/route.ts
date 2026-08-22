import { NextRequest, NextResponse } from "next/server";
import { readGuardianIsolation } from "@/lib/guardian-isolation";
import { readGuardianOwnerSession } from "@/lib/guardian-owner-auth";

export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  if (!readGuardianOwnerSession(request)) return NextResponse.json({ error: "pair this browser as the LAL owner first" }, { status: 401 });
  return NextResponse.json(readGuardianIsolation());
}
