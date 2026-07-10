import { NextRequest, NextResponse } from "next/server";
import { ROLE_PROFILES } from "@/lib/hive/presets";
import { resetRoleOverride, setRoleOverride } from "@/lib/hive/store";

export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ROLE_PROFILES[id]) return NextResponse.json({ error: "unknown role" }, { status: 404 });
  const b = await req.json().catch(() => ({}));
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  const preferredModel = typeof b.preferredModel === "string" ? b.preferredModel.trim() : "";
  setRoleOverride(id, { ...(prompt ? { prompt } : {}), ...(preferredModel ? { preferredModel } : {}) });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  resetRoleOverride(id);
  return NextResponse.json({ ok: true });
}
