import { NextRequest, NextResponse } from "next/server";
import { extractText } from "@/lib/lab";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// PDF/txt/book -> plain text (used by the Train page to turn a book into training text).
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const text = extractText(file.name, buf);
    return NextResponse.json({ name: file.name, chars: text.length, text });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
