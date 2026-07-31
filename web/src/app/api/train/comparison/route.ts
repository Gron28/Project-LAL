import { NextRequest, NextResponse } from "next/server";
import { comparisonState, prepareComparison, startComparison } from "@/lib/model-comparison";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

export async function GET() { return NextResponse.json(comparisonState()); }

export async function POST(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  const body = await req.json().catch(() => ({}));
  if (body.action === "prepare") return NextResponse.json(prepareComparison());
  if (body.action === "start") return NextResponse.json(startComparison());
  return NextResponse.json({ error: "unknown comparison action" }, { status: 400 });
}
