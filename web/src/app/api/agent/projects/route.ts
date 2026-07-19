// Project grants for the Library "Projects" tab. A recent picker entry is not
// sufficient authority: this route is the durable grant/revocation boundary for
// filesystem access through /api/agent/fs.
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { rememberProject, forgetProject } from "@/lib/lab";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";
import { workspaceGrantRepository } from "@/lib/workspace-grants";

export const dynamic = "force-dynamic";

export async function GET() {
  const projects = workspaceGrantRepository.list().map((grant) => ({ path: grant.path, exists: fs.existsSync(grant.path), grantedAt: grant.grantedAt }));
  return NextResponse.json({ projects });
}

// POST {path, create?} — register an existing directory as a project ("import"),
// or create a brand-new empty one first ("create") then register it. Same $HOME
// confinement posture as /api/agent/browse (single-user LAN/tailscale app).
export async function POST(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) {
    return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  }
  const b = await req.json().catch(() => null);
  if (!b || typeof b.path !== "string" || !b.path.trim()) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }
  const p = path.resolve(b.path.trim());
  if (b.create) {
    const home = fs.realpathSync(os.homedir());
    if (p !== home && !p.startsWith(home + path.sep)) {
      return NextResponse.json({ error: "new projects must be created under your home directory" }, { status: 403 });
    }
    if (fs.existsSync(p)) return NextResponse.json({ error: "already exists: " + p }, { status: 400 });
    fs.mkdirSync(p, { recursive: true });
  } else if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    return NextResponse.json({ error: "not a directory: " + p }, { status: 400 });
  }
  const grant = workspaceGrantRepository.grant(p);
  if (!grant) return NextResponse.json({ error: "not a directory: " + p }, { status: 400 });
  // Keep the existing picker UX in sync, but the grant is the authority record.
  rememberProject(grant.path);
  return NextResponse.json({ ok: true, path: grant.path, grantedAt: grant.grantedAt });
}

// DELETE ?path=<abs> — forgets the project (removes it from the recents list).
// Does NOT touch anything on disk; this is the safe/non-destructive "remove from
// library" action, distinct from deleting the folder's actual files.
export async function DELETE(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) {
    return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  }
  const p = req.nextUrl.searchParams.get("path");
  if (!p) return NextResponse.json({ error: "path required" }, { status: 400 });
  const revoked = workspaceGrantRepository.revoke(p);
  forgetProject(p);
  return NextResponse.json({ ok: true, revoked });
}
