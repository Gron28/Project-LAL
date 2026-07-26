import { NextRequest, NextResponse } from "next/server";
import { inspectHuggingFaceModel, searchHuggingFaceModels } from "@/lib/huggingface-catalog";

export const dynamic = "force-dynamic";

// This endpoint performs explicit metadata reads only. Downloading remains a
// separate POST to model-acquisitions after the user selects an exact file.
export async function GET(request: NextRequest) {
  try {
    const inspect = request.nextUrl.searchParams.get("inspect");
    if (inspect === "1") {
      const id = request.nextUrl.searchParams.get("id") || "", revision = request.nextUrl.searchParams.get("revision") || "";
      return NextResponse.json({ model: await inspectHuggingFaceModel(id, revision) }, { headers: { "cache-control": "no-store" } });
    }
    const query = request.nextUrl.searchParams.get("query") || "";
    return NextResponse.json({ results: await searchHuggingFaceModels(query) }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
}
