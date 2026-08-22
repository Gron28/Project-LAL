import { NextRequest, NextResponse } from "next/server";
import { collectGuardianPosture, readGuardianPosture } from "@/lib/guardian-posture";
import { authorizeGuardianOwnerMutation, readGuardianOwnerSession } from "@/lib/guardian-owner-auth";

export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  if (!readGuardianOwnerSession(request)) return NextResponse.json({ error: "pair this browser as the LAL owner first" }, { status: 401 });
  return NextResponse.json({ snapshot: readGuardianPosture() });
}
export function POST(request: NextRequest) {
  const owner = authorizeGuardianOwnerMutation(request);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: 401 });
  return NextResponse.json({ snapshot: collectGuardianPosture() });
}
