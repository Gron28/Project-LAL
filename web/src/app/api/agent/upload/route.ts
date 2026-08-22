import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { resolveSafe } from "@/lib/tools";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";
import { DEFAULT_WORKSPACE, workspaceGrantRepository } from "@/lib/workspace-grants";

export const dynamic = "force-dynamic";

// Lets the /code UI put a user-attached image into the agent's project directory
// so describe_image (a workspace-file tool) can actually see it — without this,
// showing the agent a screenshot meant copying it into the workspace by hand
// outside the app entirely.
export async function POST(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  const b = await req.json().catch(() => ({}));
  if (!(typeof b.project === "string" && b.project)) fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true });
  const root = workspaceGrantRepository.resolveGrantedDirectory(typeof b.project === "string" && b.project ? b.project : DEFAULT_WORKSPACE);
  if (!root) return NextResponse.json({ error: "project is not owner-granted or no longer exists" }, { status: 403 });

  const name = String(b.filename || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80) || "upload";
  const dataUrl = String(b.dataUrl || "");
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return NextResponse.json({ error: "expected a data: URL" }, { status: 400 });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 12 * 1024 * 1024) return NextResponse.json({ error: "file too large (>12MB)" }, { status: 400 });

  const rel = "uploads/" + Date.now().toString(36) + "-" + name;
  let target: string;
  try { target = resolveSafe(root, rel); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  return NextResponse.json({ path: rel });
}
