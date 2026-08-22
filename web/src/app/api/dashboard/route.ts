import { NextRequest, NextResponse } from "next/server";
import { getLayout, saveLayout, deleteLayout, listLayouts, type Layout } from "@/lib/lab";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const name = new URL(req.url).searchParams.get("name") || undefined;
  const { active, layout } = getLayout(name);
  return NextResponse.json({ active, layout, layouts: listLayouts() });
}

export async function POST(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  const b = await req.json().catch(() => ({}));
  const name = (b.name || "default").toString();
  const layout = b.layout as Layout;
  if (!layout || !Array.isArray(layout.widgets)) return NextResponse.json({ error: "layout.widgets required" }, { status: 400 });
  saveLayout(name, { cols: layout.cols || 12, widgets: layout.widgets });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  const name = new URL(req.url).searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  deleteLayout(name);
  return NextResponse.json({ ok: true });
}
