import { NextRequest, NextResponse } from "next/server";
import { JOB_PROTOCOL_VERSION, getJobRepository } from "@/lib/jobs";
export const dynamic = "force-dynamic";
/** Read-only until each job adapter supplies its own tested authorization path. */
export function GET(request: NextRequest) { const n=Number(request.nextUrl.searchParams.get("limit") ?? "50"); return NextResponse.json({ protocolVersion: JOB_PROTOCOL_VERSION, jobs: getJobRepository().list(Number.isSafeInteger(n) ? n : 50) }); }
