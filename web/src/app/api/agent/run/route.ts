import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Stubbed: chat never proposes tools here, so there's nothing to execute.
export async function POST() {
  return NextResponse.json({ ok: false, note: "tools not supported here" }, { status: 200 });
}
