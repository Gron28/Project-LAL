import { NextRequest, NextResponse } from "next/server";
import { listConvos } from "@/lib/lab";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const kind = new URL(req.url).searchParams.get("kind");
  return NextResponse.json(listConvos(kind === "chat" || kind === "code" ? kind : undefined));
}
