import { NextRequest } from "next/server";
import fs from "node:fs";
import { modelFile } from "@/lib/lab";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const name = new URL(req.url).searchParams.get("model") || "";
  const p = modelFile(name);
  if (!p) return new Response("not found", { status: 404 });
  const stat = fs.statSync(p);
  const stream = fs.createReadStream(p) as unknown as ReadableStream;
  return new Response(stream, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${name}.gguf"`,
      "content-length": String(stat.size),
    },
  });
}
