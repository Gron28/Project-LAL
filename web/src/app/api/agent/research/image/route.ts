import { NextRequest } from "next/server";
import { fetchResearchAsset } from "@/lib/research-media";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url") || "";
  try {
    const response = await fetchResearchAsset(url, { headers: { accept: "image/avif,image/webp,image/png,image/jpeg" } });
    const type = response.headers.get("content-type") || "";
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (!response.ok || !type.startsWith("image/") || (declaredLength && declaredLength > 6_000_000)) return new Response("unsupported image", { status: 415 });
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 6_000_000) return new Response("image too large", { status: 413 });
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "private, max-age=86400", "content-security-policy": "default-src 'none'" } });
  } catch {
    return new Response("image unavailable", { status: 404 });
  }
}
