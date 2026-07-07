import { NextRequest, NextResponse } from "next/server";
import { listCheckpoints, compareAdapters, adapterEvolution } from "@/lib/lab";

export const dynamic = "force-dynamic";

// GET /api/compare -> { checkpoints: string[] }
export async function GET() {
  return NextResponse.json({ checkpoints: listCheckpoints() });
}

// POST /api/compare { names: string[] }   -> { results: [{name, modules, matrix}] }
// POST /api/compare { evolution: string } -> { result: {name, modules, steps, series} }
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  if (b.evolution) {
    const r = await adapterEvolution(String(b.evolution));
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ result: r.result });
  }
  const names: string[] = Array.isArray(b.names) ? b.names.map(String) : [];
  if (names.length < 2) return NextResponse.json({ error: "pick at least 2 checkpoints" }, { status: 400 });
  const r = await compareAdapters(names);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ results: r.results });
}
