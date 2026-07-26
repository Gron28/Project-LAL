import { NextRequest, NextResponse } from "next/server";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";
import { getWorkflowRevisionRepository } from "@/lib/hive/graph-revisions";
import type { WorkflowDefinition } from "@/lib/hive/graph-authoring";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "workflow id is required" }, { status: 400 });
  return NextResponse.json({ revisions: getWorkflowRevisionRepository().list(id) }, { headers: { "cache-control": "no-store" } });
}

// Draft validation and publishing are deliberately explicit browser mutations.
// This route creates immutable records only; it never starts a HIVE workflow.
export async function POST(request: NextRequest) {
  const authorization = authorizeBrowserMutation(request);
  if (!authorization.ok) return NextResponse.json({ error: authorization.code }, { status: authorization.status });
  const body = await request.json().catch(() => ({}));
  const definition = body.definition as WorkflowDefinition | undefined;
  if (!definition) return NextResponse.json({ error: "workflow definition is required" }, { status: 400 });
  const repository = getWorkflowRevisionRepository();
  if (body.action === "validate") return NextResponse.json(repository.validate(definition));
  try { return NextResponse.json({ revision: repository.publish(definition) }, { status: 201 }); }
  catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
}
