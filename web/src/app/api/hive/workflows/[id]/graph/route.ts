import { NextResponse } from "next/server";
import { projectWorkflowGraph } from "@/lib/hive/graph";
import { getWorkflow, getWorkflowNodes } from "@/lib/hive/store";

export const dynamic = "force-dynamic";

// The graph endpoint is intentionally read-only. It validates and projects the
// stored spec; execution remains exclusively owned by the workflow engine.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workflow = getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "workflow not found" }, { status: 404 });
  return NextResponse.json({ workflowId: workflow.id, status: workflow.status, graph: projectWorkflowGraph(workflow.spec, getWorkflowNodes(workflow.id)) });
}
