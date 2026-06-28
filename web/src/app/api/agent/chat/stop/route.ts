import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Client aborts its own fetch; generation stops being consumed. No-op server side.
export async function POST() {
  return NextResponse.json({ ok: true });
}
