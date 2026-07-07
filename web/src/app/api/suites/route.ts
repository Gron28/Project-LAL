import { NextRequest, NextResponse } from "next/server";
import { listSuites, getSuite, saveSuite, deleteSuite, parseImport } from "@/lib/lab";

export const dynamic = "force-dynamic";

// GET            -> [{id,label,count,cats}]
// GET ?id=fractal -> {id,label,items}
export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const s = getSuite(id);
    return s ? NextResponse.json(s) : NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ suites: listSuites() });
}

// POST {id,label,items}                 -> save a suite
// POST {id,label,importText,mode}       -> import items (mode: 'replace' | 'append')
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  if (!b.id) return NextResponse.json({ error: "no id" }, { status: 400 });
  let items = b.items;
  if (b.importText) {
    const imported = parseImport(b.importText, b.defaultCat || "imported");
    if (!imported.length) return NextResponse.json({ error: "no valid items parsed" }, { status: 400 });
    const existing = b.mode === "append" ? (getSuite(b.id)?.items || []) : [];
    items = [...existing, ...imported];
  }
  return NextResponse.json(saveSuite(b.id, b.label || b.id, items || []));
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id") || "";
  deleteSuite(id);
  return NextResponse.json({ ok: true });
}
