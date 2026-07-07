import { NextRequest, NextResponse } from "next/server";
import { runBench, SUITES, getSuite, listBench, saveBench, deleteBench, pinBench } from "@/lib/lab";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

// GET -> all saved benchmark results (to seed the dashboard on load)
export async function GET() {
  return NextResponse.json({ results: listBench() });
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  if (!b.model) return NextResponse.json({ error: "no model" }, { status: 400 });
  const suiteName = (b.suite as string) || "fractal";
  const stored = getSuite(suiteName);                       // editable file-backed suite
  const items = stored?.items?.length ? stored.items : (SUITES[suiteName] || SUITES.fractal);
  const opts = { grade: stored?.grade, maxTokens: stored?.maxTokens, think: stored?.think };
  try {
    const result = { ...(await runBench(b.model, items, opts)), suite: suiteName };
    saveBench(suiteName, result);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const u = new URL(req.url);
  deleteBench(u.searchParams.get("suite") || "", u.searchParams.get("model") || "");
  return NextResponse.json({ ok: true });
}

// PATCH {suite, model, pinned} -> pin/unpin a saved result as a champion baseline
export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  if (!b.suite || !b.model) return NextResponse.json({ error: "suite and model required" }, { status: 400 });
  const r = pinBench(b.suite, b.model, !!b.pinned);
  return r.ok ? NextResponse.json(r) : NextResponse.json(r, { status: 404 });
}
