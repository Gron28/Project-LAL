import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Tool execution is inbox-specific; not supported in Local AI Lab (chat never proposes tools).
export async function POST() {
  return NextResponse.json({ ok: false, note: "tools not supported here" }, { status: 200 });
}
