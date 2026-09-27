import { NextRequest, NextResponse } from "next/server";
import { publicModels } from "@/lib/lab";
import { readModelArchitecture } from "@/lib/gguf-meta";

export const dynamic = "force-dynamic";

// GET ?model=<name> → the model's architecture read from its GGUF header (no
// weights are read). Only models in LAL's own inventory resolve, so this can
// never be pointed at an arbitrary file on disk.
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("model");
  if (!name) return NextResponse.json({ error: "model is required" }, { status: 400 });
  const info = publicModels().find((m) => m.name === name);
  if (!info?.path) return NextResponse.json({ error: `unknown model: ${name}` }, { status: 404 });
  try {
    return NextResponse.json({ model: name, source: info.source, gb: info.gb, architecture: readModelArchitecture(info.path) });
  } catch (error) {
    return NextResponse.json({ error: `could not read GGUF header: ${error instanceof Error ? error.message : String(error)}` }, { status: 422 });
  }
}
