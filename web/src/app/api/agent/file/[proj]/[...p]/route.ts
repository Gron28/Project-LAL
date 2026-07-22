import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Serve files from an agent project for in-app preview — path-style so a previewed
// index.html can load its styles.css/script.js by relative reference:
//   /api/agent/file/<base64url(projectRoot) | "_">/<relative/path>
// Confined to the project root (lexical + symlink realpath checks). HTML gets a CSP
// sandbox: scripts run, but the page can't reach the app's APIs or storage.
// turbopackIgnore: this is a runtime filesystem path, not a bundler asset —
// without the ignore comment Turbopack can't statically resolve process.cwd()
// and conservatively traces the whole project tree looking for the target.
const DEFAULT_WORKSPACE = path.join(/*turbopackIgnore: true*/ path.resolve(process.cwd(), ".."), "workspace");

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
  let root = DEFAULT_WORKSPACE;
  if (proj && proj !== "_") {
    try { root = Buffer.from(proj, "base64url").toString("utf8"); } catch { return NextResponse.json({ error: "bad project" }, { status: 400 }); }
  }
  let rootReal: string;
  try { rootReal = fs.realpathSync(path.resolve(root)); } catch { return NextResponse.json({ error: "project not found" }, { status: 404 }); }
  const rel = (p || []).map(decodeURIComponent).join("/");
  const target = path.resolve(rootReal, rel);
  if (target !== rootReal && !target.startsWith(rootReal + path.sep)) {
    return NextResponse.json({ error: "path escapes project" }, { status: 400 });
  }
  let real: string;
  try { real = fs.realpathSync(target); } catch { return NextResponse.json({ error: "file not found" }, { status: 404 }); }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    return NextResponse.json({ error: "path escapes project (symlink)" }, { status: 400 });
  }
  if (!fs.statSync(real).isFile()) return NextResponse.json({ error: "not a file" }, { status: 400 });
  const type = TYPES[path.extname(real).toLowerCase()] || "application/octet-stream";
  const headers: Record<string, string> = { "content-type": type, "cache-control": "no-store" };
  // allow-same-origin: without it, sandboxed pages get an opaque origin and ANY
  // localStorage/sessionStorage access throws SecurityError, uncaught — killed a
  // real "todo with persistence"-style app outright. This origin has no auth and
  // only two low-sensitivity UI-preference keys in localStorage (checked), so the
  // isolation this was buying wasn't worth the breakage. allow-top-navigation and
  // allow-popups stay withheld — a generated page still can't hijack the tab or
  // spam windows.
  if (type.startsWith("text/html")) headers["content-security-policy"] = "sandbox allow-scripts allow-same-origin allow-pointer-lock allow-modals allow-forms";
  return new NextResponse(new Uint8Array(fs.readFileSync(real)), { headers });
}
