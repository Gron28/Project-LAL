import { NextRequest, NextResponse } from "next/server";
import { listFolders, addFolder, removeFolder } from "@/lib/lab";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listFolders());
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  return NextResponse.json(addFolder(String(b.name || "").trim()));
}

export async function DELETE(req: NextRequest) {
  const name = new URL(req.url).searchParams.get("name") || "";
  return NextResponse.json(removeFolder(name));
}
