import { NextRequest, NextResponse } from "next/server";
import { authorizeGuardianOwnerMutation, readGuardianOwnerSession } from "@/lib/guardian-owner-auth";
import { listMachineScans, readMachineScan, startMachineScan } from "@/lib/guardian-machine-scan";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  if (!readGuardianOwnerSession(request)) return NextResponse.json({ error: "pair this browser as the LAL owner first" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id");
  if (id) { const scan = readMachineScan(id); return scan ? NextResponse.json({ scan }) : NextResponse.json({ error: "scan not found" }, { status: 404 }); }
  return NextResponse.json({ scans: listMachineScans() });
}

export function POST(request: NextRequest) {
  const owner = authorizeGuardianOwnerMutation(request);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: 401 });
  const active = listMachineScans(10).find((scan) => scan.state === "queued" || scan.state === "running");
  if (active) return NextResponse.json({ scan: active });
  return NextResponse.json({ scan: startMachineScan() }, { status: 202 });
}
