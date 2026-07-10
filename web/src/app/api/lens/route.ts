import { NextRequest, NextResponse } from "next/server";
import { listLensableModels, lensRunning, runLensScript } from "@/lib/lab";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET() {
  return NextResponse.json({ models: listLensableModels(), running: lensRunning() });
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const model = typeof b.model === "string" ? b.model : "";
  const messages = Array.isArray(b.messages) ? b.messages : null;
  if (!model) return NextResponse.json({ error: "model is required" }, { status: 400 });
  if (!messages?.length) return NextResponse.json({ error: "messages is required" }, { status: 400 });
  const topK = Number.isInteger(b.topK) && b.topK > 0 && b.topK <= 20 ? b.topK : undefined;
  const r = await runLensScript(model, messages, { topK });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
  return NextResponse.json({ result: r.result });
}
