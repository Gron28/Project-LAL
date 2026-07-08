import { NextRequest, NextResponse } from "next/server";
import { listRuns } from "@/lib/runs";

export const dynamic = "force-dynamic";

// The one truthful answer to "is something running?" — every page load asks this
// instead of guessing from transcript shape (the old way, which produced permanently
// stuck busy spinners on runs that had actually died).
export function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit")) || 50;
  return NextResponse.json(listRuns(limit));
}
