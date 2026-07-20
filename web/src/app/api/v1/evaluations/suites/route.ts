import { NextResponse } from "next/server";
import { LINEAGE_EVALUATION_SCHEMA_VERSION, getLineageEvaluationRepository } from "@/lib/lineage-evaluations";
export const dynamic = "force-dynamic";
/** Versioned read-only suite ledger; benchmark execution has no HTTP mutation path yet. */
export function GET() { return NextResponse.json({ protocolVersion: LINEAGE_EVALUATION_SCHEMA_VERSION, suites:getLineageEvaluationRepository().listSuites() }, { headers:{ "cache-control":"no-store" } }); }
