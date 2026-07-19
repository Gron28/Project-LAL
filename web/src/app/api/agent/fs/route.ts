// Project-confined filesystem access for the /code UI: directory listing for the
// file tree, file read for the editor, file write for human edits. The agent's own
// file tools live in lib/tools.ts; this route is the *human's* path to the same
// project root, confined by the same resolveSafe.
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { resolveSafe } from "@/lib/tools";
import { authorizeBrowserMutation } from "@/lib/browser-mutation-guard";

export const dynamic = "force-dynamic";

const DEFAULT_WORKSPACE = path.join(path.resolve(process.cwd(), ".."), "workspace");
const READ_CAP = 1024 * 1024; // 1MB — editor is for source files, not datasets
const LIST_CAP = 500;

function projectRoot(raw: string | null): { root: string } | { error: string } {
  if (!raw) { fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true }); return { root: DEFAULT_WORKSPACE }; }
  const p = path.resolve(raw);
  try {
    if (!fs.statSync(p).isDirectory()) return { error: "not a directory: " + p };
  } catch { return { error: "directory not found: " + p }; }
  return { root: p };
}

function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8192);
  return probe.includes(0);
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const pr = projectRoot(sp.get("project"));
  if ("error" in pr) return NextResponse.json({ error: pr.error }, { status: 400 });
  const op = sp.get("op") || "list";
  let target: string;
  try {
    target = resolveSafe(pr.root, sp.get("path") || ".");
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  if (op === "list") {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return NextResponse.json({ error: "not a readable directory" }, { status: 404 });
    }
    const sorted = ents
      .map((e) => {
        const dir = e.isDirectory();
        let size: number | undefined;
        if (!dir) { try { size = fs.statSync(path.join(target, e.name)).size; } catch {} }
        return { name: e.name, dir, ...(size !== undefined ? { size } : {}) };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const truncated = sorted.length > LIST_CAP;
    return NextResponse.json({
      path: sp.get("path") || ".",
      entries: truncated ? sorted.slice(0, LIST_CAP) : sorted,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  if (op === "read") {
    let st: fs.Stats;
    try { st = fs.statSync(target); } catch { return NextResponse.json({ error: "not found" }, { status: 404 }); }
    if (!st.isFile()) return NextResponse.json({ error: "not a file" }, { status: 400 });
    const fd = fs.openSync(target, "r");
    let buf: Buffer;
    try {
      buf = Buffer.alloc(Math.min(st.size, READ_CAP));
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally { fs.closeSync(fd); }
    if (looksBinary(buf)) {
      return NextResponse.json({ content: "", size: st.size, mtimeMs: st.mtimeMs, binary: true, truncated: false });
    }
    return NextResponse.json({
      content: buf.toString("utf8"),
      size: st.size,
      mtimeMs: st.mtimeMs,
      binary: false,
      truncated: st.size > READ_CAP,
    });
  }

  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}

// PUT {project, path, content, baseMtimeMs?} — save a human edit. baseMtimeMs is the
// mtime the editor loaded; a mismatch means someone (usually the agent) wrote the file
// since, and we 409 instead of silently clobbering. A second PUT without baseMtimeMs
// is the deliberate overwrite.
export async function PUT(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) {
    return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  }
  const b = await req.json().catch(() => null);
  if (!b || typeof b.path !== "string" || typeof b.content !== "string") {
    return NextResponse.json({ error: "expected {project?, path, content, baseMtimeMs?}" }, { status: 400 });
  }
  const pr = projectRoot(typeof b.project === "string" && b.project ? b.project : null);
  if ("error" in pr) return NextResponse.json({ error: pr.error }, { status: 400 });
  if (b.content.length > READ_CAP) return NextResponse.json({ error: "file too large (1MB cap)" }, { status: 413 });
  if (b.content.includes("\0")) return NextResponse.json({ error: "text files only" }, { status: 400 });
  let target: string;
  try {
    target = resolveSafe(pr.root, b.path);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  if (typeof b.baseMtimeMs === "number") {
    try {
      const cur = fs.statSync(target).mtimeMs;
      if (cur !== b.baseMtimeMs) {
        return NextResponse.json({ error: "modified on disk", mtimeMs: cur }, { status: 409 });
      }
    } catch {} // file deleted since load — treat the save as a re-create
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, b.content, "utf8");
  const st = fs.statSync(target);
  return NextResponse.json({ ok: true, mtimeMs: st.mtimeMs, size: st.size });
}

// DELETE ?project&path= — remove a single FILE (not a directory — deliberately no
// recursive delete here; a whole-folder wipe is destructive enough that it belongs
// in a terminal, not a one-click library button).
export async function DELETE(req: NextRequest) {
  const authorization = authorizeBrowserMutation(req);
  if (!authorization.ok) {
    return NextResponse.json({ error: "browser mutation rejected", code: authorization.code }, { status: authorization.status });
  }
  const sp = req.nextUrl.searchParams;
  const pr = projectRoot(sp.get("project"));
  if ("error" in pr) return NextResponse.json({ error: pr.error }, { status: 400 });
  const rel = sp.get("path");
  if (!rel) return NextResponse.json({ error: "path required" }, { status: 400 });
  let target: string;
  try {
    target = resolveSafe(pr.root, rel);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  let st: fs.Stats;
  try { st = fs.statSync(target); } catch { return NextResponse.json({ error: "not found" }, { status: 404 }); }
  if (!st.isFile()) return NextResponse.json({ error: "not a file (directories aren't deletable here)" }, { status: 400 });
  fs.unlinkSync(target);
  return NextResponse.json({ ok: true });
}
