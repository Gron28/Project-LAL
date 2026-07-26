import { NextRequest, NextResponse } from "next/server";
import { LINEAGE_EVALUATION_SCHEMA_VERSION, getLineageEvaluationRepository } from "@/lib/lineage-evaluations";
export const dynamic = "force-dynamic";
/** Read-only entity plus direct immutable provenance relations. */
export function GET(_request: NextRequest, context: { params: Promise<{ id:string }> }) { return context.params.then(({ id }) => { const repository=getLineageEvaluationRepository(), entity=repository.getEntity(id); return entity ? NextResponse.json({ protocolVersion:LINEAGE_EVALUATION_SCHEMA_VERSION,entity,relations:repository.relationsFor(id) },{ headers:{ "cache-control":"no-store" } }) : NextResponse.json({ error:"lineage entity not found" },{ status:404 }); }); }
