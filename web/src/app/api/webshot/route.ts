import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const WEBSHOTS_DIR = path.join(process.cwd(), ".data", "webshots");

// GET /api/webshot?id=<shotId> -> the PNG captured by gradeWebgen for a bench item
export async function GET(req: NextRequest) {
  const id = (new URL(req.url).searchParams.get("id") || "").replace(/[^a-z0-9]/gi, "");
  if (!id) return NextResponse.json({ error: "no id" }, { status: 400 });
  const p = path.join(WEBSHOTS_DIR, id + ".png");
  try {
    const buf = fs.readFileSync(p);
    return new NextResponse(new Uint8Array(buf), { headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" } });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
