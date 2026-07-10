import { NextResponse } from "next/server";
import { readArtifact } from "@/lib/hive/store";

export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  const artifact = readArtifact(hash);
  return artifact ? new Response(new Uint8Array(artifact)) : NextResponse.json({ error: "artifact not found" }, { status: 404 });
}
