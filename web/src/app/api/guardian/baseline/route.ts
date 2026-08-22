import { NextRequest, NextResponse } from "next/server";
import { captureGuardianBaseline, compareGuardianBaseline } from "@/lib/guardian-baseline";
import { authorizeGuardianOwnerMutation, readGuardianOwnerSession } from "@/lib/guardian-owner-auth";

export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  if (!readGuardianOwnerSession(request)) return NextResponse.json({ error: "pair this browser as the LAL owner first" }, { status: 401 });
  return NextResponse.json(compareGuardianBaseline());
}
export function POST(request: NextRequest) {
  const owner = authorizeGuardianOwnerMutation(request);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: 401 });
  try { return NextResponse.json({ baseline: captureGuardianBaseline() }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "baseline capture failed" }, { status: 409 }); }
}
