import { NextResponse } from "next/server";
import { listConvos } from "@/lib/lab";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listConvos());
}
