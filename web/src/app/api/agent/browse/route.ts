// Directory browser backing the /code project picker. Lists DIRECTORIES only,
// confined to the $HOME subtree (plus the default workspace).
//
// Security posture: this is a single-user app on LAN/tailscale with no auth, and the
// /code agent already gets run_shell in whatever directory the user picks — so this
// endpoint is not the security boundary. The $HOME confinement is blast-radius
// limiting (don't be a whole-filesystem oracle) and UX (/proc, /etc are noise).
// If this app is ever exposed beyond the tailnet, this route needs real auth first.
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";

const DEFAULT_WORKSPACE = path.join(path.resolve(process.cwd(), ".."), "workspace");
const LIST_CAP = 500;

function within(base: string, p: string): boolean {
  return p === base || p.startsWith(base + path.sep);
}

export async function GET(req: NextRequest) {
  const home = fs.realpathSync(os.homedir());
  const sp = req.nextUrl.searchParams;
  const showHidden = sp.get("hidden") === "1";
  const raw = sp.get("path") || home;

  let real: string;
  try {
    real = fs.realpathSync(path.resolve(raw));
  } catch {
    return NextResponse.json({ error: "directory not found" }, { status: 404 });
  }
  let wsReal = "";
  try { wsReal = fs.realpathSync(DEFAULT_WORKSPACE); } catch {}
  if (!within(home, real) && !(wsReal && within(wsReal, real))) {
    return NextResponse.json({ error: "outside home" }, { status: 403 });
  }
  let st: fs.Stats;
  try { st = fs.statSync(real); } catch { return NextResponse.json({ error: "directory not found" }, { status: 404 }); }
  if (!st.isDirectory()) return NextResponse.json({ error: "not a directory" }, { status: 400 });

  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(real, { withFileTypes: true })
      .filter((e) => {
        if (!e.isDirectory()) return false;
        if (e.name === "node_modules") return false;
        if (!showHidden && e.name.startsWith(".")) return false;
        return true;
      })
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, LIST_CAP);
  } catch {
    return NextResponse.json({ error: "not readable" }, { status: 403 });
  }

  return NextResponse.json({
    path: real,
    parent: real === home ? null : path.dirname(real),
    home,
    dirs,
    isGit: fs.existsSync(path.join(real, ".git")),
  });
}
