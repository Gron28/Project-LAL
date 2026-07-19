import { NextResponse } from "next/server";
import { refreshLiveCapabilityRegistry } from "@/lib/capability-registry-live";

export const dynamic = "force-dynamic";

/** Versioned, read-only model/runtime/artifact catalog. Discovery has no download side effects. */
export async function GET() {
  const snapshot = await refreshLiveCapabilityRegistry();
  return NextResponse.json(snapshot, { headers: { "cache-control": "no-store" } });
}
