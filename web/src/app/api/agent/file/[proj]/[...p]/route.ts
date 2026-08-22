import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { GENERATED_PREVIEW_CSP } from "@/lib/preview-security";
import { DEFAULT_WORKSPACE, workspaceGrantRepository } from "@/lib/workspace-grants";

export const dynamic = "force-dynamic";

// Serve files from an agent project for in-app preview — path-style so a previewed
// index.html can load its styles.css/script.js by relative reference:
//   /api/agent/file/<base64url(projectRoot) | "_">/<relative/path>
// Confined to the project root (lexical + symlink realpath checks). HTML gets a CSP
// sandbox: scripts run, but the page can't reach the app's APIs or storage.
// turbopackIgnore: this is a runtime filesystem path, not a bundler asset —
// without the ignore comment Turbopack can't statically resolve process.cwd()
// and conservatively traces the whole project tree looking for the target.
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ proj: string; p: string[] }> }) {
  const { proj, p } = await ctx.params;
  let requestedRoot = DEFAULT_WORKSPACE;
  if (proj && proj !== "_") {
    try { requestedRoot = Buffer.from(proj, "base64url").toString("utf8"); } catch { return NextResponse.json({ error: "bad project" }, { status: 400 }); }
  }
  const rootReal = workspaceGrantRepository.resolveGrantedDirectory(requestedRoot);
  if (!rootReal) return NextResponse.json({ error: "project is not owner-granted or no longer exists" }, { status: 403 });
  const rel = (p || []).map(decodeURIComponent).join("/");
  const target = path.resolve(rootReal, rel);
  if (target !== rootReal && !target.startsWith(rootReal + path.sep)) {
    return NextResponse.json({ error: "path escapes project" }, { status: 400 });
  }
  let real: string;
  try { real = fs.realpathSync(/*turbopackIgnore: true*/ target); } catch { return NextResponse.json({ error: "file not found" }, { status: 404 }); }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    return NextResponse.json({ error: "path escapes project (symlink)" }, { status: 400 });
  }
  if (!fs.statSync(real).isFile()) return NextResponse.json({ error: "not a file" }, { status: 400 });
  const type = TYPES[path.extname(real).toLowerCase()] || "application/octet-stream";
  const headers: Record<string, string> = { "content-type": type, "cache-control": "no-store" };
  // Previewed files are generated/untrusted code. Do NOT add allow-same-origin:
  // paired with allow-scripts, it would give that code the WebUI origin and let
  // it call owner-level APIs (and potentially remove its own iframe sandbox).
  // An opaque origin means browser storage is unavailable in previews by design;
  // generated apps must handle that gracefully rather than inheriting LAL power.
  if (type.startsWith("text/html")) headers["content-security-policy"] = GENERATED_PREVIEW_CSP;
  return new NextResponse(new Uint8Array(fs.readFileSync(/*turbopackIgnore: true*/ real)), { headers });
}
