import { NextRequest, NextResponse } from "next/server";
import { readSettings, writeSettings } from "@/lib/lab";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = readSettings();
  return NextResponse.json({ web: s.web, groundDocs: s.groundDocs });
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const s = writeSettings({ web: b.web, groundDocs: b.groundDocs });
  return NextResponse.json({ web: !!s.web, groundDocs: !!s.groundDocs });
}
