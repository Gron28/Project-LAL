import { NextRequest, NextResponse } from "next/server";
import { JOB_PROTOCOL_VERSION, getJobRepository } from "@/lib/jobs";
export const dynamic = "force-dynamic";
export function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) { return context.params.then(({id}) => { const repo=getJobRepository(), job=repo.get(id); return job ? NextResponse.json({protocolVersion:JOB_PROTOCOL_VERSION,job,events:repo.events(id)}) : NextResponse.json({error:"job not found"},{status:404}); }); }
