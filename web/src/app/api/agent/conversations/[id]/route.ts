import { NextRequest, NextResponse } from "next/server";
import { getConvo, saveConvo, deleteConvo } from "@/lib/lab";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = getConvo(id);
  return c ? NextResponse.json(c) : NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const c = getConvo(id) || { id, title: "", ts: Date.now(), messages: [] };
  if (Array.isArray(b.messages)) c.messages = b.messages;
  if (b.title) c.title = b.title;
  return NextResponse.json(saveConvo(c));
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteConvo(id);
  return NextResponse.json({ ok: true });
}
