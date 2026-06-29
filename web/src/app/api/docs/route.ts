import { NextRequest, NextResponse } from "next/server";
import { listDocs, saveDoc, deleteDoc, moveDoc, extractText } from "@/lib/lab";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  return NextResponse.json(listDocs());
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  const folder = (form.get("folder") as string) || "";
  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
  const text = extractText(file.name, buf);
  if (!text.trim()) return NextResponse.json({ error: "no text extracted" }, { status: 400 });
  return NextResponse.json(saveDoc(file.name, text, folder));
}

export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  if (b.id) moveDoc(String(b.id), String(b.folder ?? ""));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id") || "";
  deleteDoc(id);
  return NextResponse.json({ ok: true });
}
