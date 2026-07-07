import { NextRequest, NextResponse } from "next/server";
import { listDataFiles, readDataFile, saveDataFile, deleteDataFile, extractText } from "@/lib/lab";

export const dynamic = "force-dynamic";

// GET /api/train/data            -> { files: [{name, chars}] }
// GET /api/train/data?file=x.txt -> { name, content }
export async function GET(req: NextRequest) {
  const file = new URL(req.url).searchParams.get("file");
  if (!file) return NextResponse.json({ files: listDataFiles() });
  const content = readDataFile(file);
  if (content == null) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ name: file, content });
}

// POST multipart: file upload (.txt / .jsonl / .pdf → txt)
// POST json: { name, content } to create/overwrite from pasted text
export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });
    const buf = Buffer.from(await file.arrayBuffer());
    let name = file.name;
    let content: string;
    if (name.toLowerCase().endsWith(".pdf")) {
      content = extractText(name, buf);
      name = name.replace(/\.pdf$/i, ".txt");
    } else {
      content = buf.toString("utf8");
    }
    const result = saveDataFile(name, content);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  }
  const b = await req.json().catch(() => ({}));
  if (!b.name || b.content == null) return NextResponse.json({ error: "name and content required" }, { status: 400 });
  const result = saveDataFile(b.name, b.content);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

// DELETE /api/train/data?file=x.jsonl
export async function DELETE(req: NextRequest) {
  const file = new URL(req.url).searchParams.get("file") || "";
  const result = deleteDataFile(file);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
