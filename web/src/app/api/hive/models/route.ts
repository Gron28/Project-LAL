import { NextRequest, NextResponse } from "next/server";
import { discoverModelProfiles, probeModel } from "@/lib/hive/model-registry";

export const dynamic = "force-dynamic";
export const maxDuration = 600;
export async function GET() { return NextResponse.json({ models: discoverModelProfiles() }); }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (typeof body.profileId !== "string") return NextResponse.json({ error: "profileId is required" }, { status: 400 });
  try { return NextResponse.json({ model: await probeModel(body.profileId) }); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 404 }); }
}
