import { NextRequest, NextResponse } from "next/server";
import { readGuardianOwnerSession } from "@/lib/guardian-owner-auth";
import { listMachineScans, startMachineScan } from "@/lib/guardian-machine-scan";

export const dynamic = "force-dynamic";
const destination = (request: NextRequest) => new URL("/guardian", request.headers.get("origin") || request.url);
export function POST(request: NextRequest) {
  if (!readGuardianOwnerSession(request)) return NextResponse.redirect(new URL("/guardian", destination(request)), 303);
  if (!listMachineScans(10).some((scan) => scan.state === "queued" || scan.state === "running")) startMachineScan();
  return NextResponse.redirect(destination(request), 303);
}
