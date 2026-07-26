import { NextRequest, NextResponse } from "next/server";
import { LINEAGE_EVALUATION_SCHEMA_VERSION, getLineageEvaluationRepository } from "@/lib/lineage-evaluations";
export const dynamic = "force-dynamic";
/** Exact evidence is read-only; raw model output is returned as inert JSON. */
export function GET(_request: NextRequest, context: { params: Promise<{ id:string }> }) { return context.params.then(({ id }) => { const run=getLineageEvaluationRepository().getRun(id); return run ? NextResponse.json({ protocolVersion:LINEAGE_EVALUATION_SCHEMA_VERSION,run },{ headers:{ "cache-control":"no-store" } }) : NextResponse.json({ error:"evaluation run not found" },{ status:404 }); }); }
