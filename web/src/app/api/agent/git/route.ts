// Minimal git backend for the /code git panel: status, per-file diff, commit.
// Composes FIXED argv shapes server-side (the client never supplies raw git args),
// so the agent-tool's hard-block/approval classifier isn't needed here. Reuses
// runGit from lib/tools.ts (argv-based spawn, hardened env, 30s timeout, 16KB cap).
import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveSafe, runGit } from "@/lib/tools";

export const dynamic = "force-dynamic";

const DEFAULT_WORKSPACE = path.join(path.resolve(process.cwd(), ".."), "workspace");
const OUT_CAP = 16384; // runGit's own cap — used to flag truncation

// Cloning can take much longer than runGit's 30s cap (large repos, slow remotes), so
// it gets its own runner with a bigger timeout/output cap rather than reusing runGit.
function cloneRepo(parentDir: string, url: string, name: string): Promise<string> {
  return new Promise((resolve) => {
    const cap = 32768;
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      // "--" before the positional args is defense in depth against argument
      // injection (a url/name starting with "-" being parsed as a flag) on top of
      // the caller's own regex validation.
      child = spawn("git", ["clone", "--", url, name], {
        cwd: parentDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
      });
    } catch (e) { resolve("error: " + (e as Error).message); return; }
    const append = (d: Buffer) => { if (out.length < cap) out += d.toString(); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let done = false;
    const finish = (msg: string) => { if (done) return; done = true; resolve((msg || "(no output)").slice(0, cap)); };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(out + "\n[timed out after 180s]"); }, 180000);
    child.on("close", (code) => { clearTimeout(timer); finish(out + (code ? `\n[exit ${code}]` : "")); });
    child.on("error", (e) => { clearTimeout(timer); finish("error: " + e.message); });
  });
}

// Only well-formed git-remote-ish URLs — blocks local file:// access and (together
// with the "--" above) argument-injection strings that start with "-".
const SAFE_CLONE_URL = /^(https?:\/\/|git:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)\S+$/;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function projectRoot(raw: string | null): { root: string } | { error: string } {
  if (!raw) return { root: path.resolve(DEFAULT_WORKSPACE) };
  const p = path.resolve(raw);
  try {
    if (!fs.statSync(p).isDirectory()) return { error: "not a directory: " + p };
  } catch { return { error: "directory not found: " + p }; }
  return { root: p };
}

function isRepo(root: string): boolean {
  return fs.existsSync(path.join(root, ".git"));
}

type StatusFile = { path: string; x: string; y: string };

function parseStatus(out: string): { branch: string; ahead: number; behind: number; files: StatusFile[] } {
  let branch = "", ahead = 0, behind = 0;
  const files: StatusFile[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      // "## main...origin/main [ahead 1, behind 2]" | "## No commits yet on main"
      const m = line.slice(3);
      branch = (m.split("...")[0] || m).replace(/^No commits yet on /, "").trim();
      const a = m.match(/ahead (\d+)/); if (a) ahead = parseInt(a[1], 10);
      const b = m.match(/behind (\d+)/); if (b) behind = parseInt(b[1], 10);
      continue;
    }
    if (line.length < 4) continue;
    const x = line[0], y = line[1];
    let p = line.slice(3);
    const arrow = p.indexOf(" -> "); // rename: take the new path
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) { try { p = JSON.parse(p); } catch {} }
    files.push({ path: p, x, y });
  }
  return { branch, ahead, behind, files };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const pr = projectRoot(sp.get("project"));
  if ("error" in pr) return NextResponse.json({ error: pr.error }, { status: 400 });
  const op = sp.get("op") || "status";

  if (op === "status") {
    if (!isRepo(pr.root)) return NextResponse.json({ repo: false });
    const out = await runGit(pr.root, ["status", "--porcelain=v1", "-b"]);
    if (out.startsWith("error:")) return NextResponse.json({ error: out }, { status: 500 });
    return NextResponse.json({ repo: true, ...parseStatus(out) });
  }

  if (op === "diff") {
    if (!isRepo(pr.root)) return NextResponse.json({ error: "not a git repo" }, { status: 400 });
    const rel = sp.get("path") || "";
    try { resolveSafe(pr.root, rel); } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
    // Untracked files have no HEAD side; --no-index vs /dev/null renders them as
    // all-additions (git exits 1 there — runGit surfaces output either way).
    const status = await runGit(pr.root, ["status", "--porcelain=v1", "--", rel]);
    const untracked = status.split("\n").some((l) => l.startsWith("??"));
    const out = untracked
      ? await runGit(pr.root, ["diff", "--no-index", "--", "/dev/null", rel])
      : await runGit(pr.root, ["diff", "HEAD", "--", rel]);
    const diff = out.replace(/\n\[exit 1\]$/, ""); // --no-index exit 1 = "differences found", not an error
    return NextResponse.json({ diff, ...(out.length >= OUT_CAP ? { truncated: true } : {}) });
  }

  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}

// POST {project, op:"commit"|"clone", ...} — commit: stage the given paths (or -A) and
// commit. clone: git-clone a remote into a chosen parent directory.
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (!b || (b.op !== "commit" && b.op !== "clone")) return NextResponse.json({ error: "expected {op:'commit'|'clone', ...}" }, { status: 400 });
  const pr = projectRoot(typeof b.project === "string" && b.project ? b.project : null);
  if ("error" in pr) return NextResponse.json({ error: pr.error }, { status: 400 });

  if (b.op === "clone") {
    const url = typeof b.url === "string" ? b.url.trim() : "";
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!SAFE_CLONE_URL.test(url)) return NextResponse.json({ error: "url must be an https://, ssh://, or git@host:path remote" }, { status: 400 });
    if (!SAFE_NAME.test(name)) return NextResponse.json({ error: "folder name may only contain letters, numbers, dot, dash, underscore" }, { status: 400 });
    let dest: string;
    try { dest = resolveSafe(pr.root, name); } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
    if (fs.existsSync(dest)) return NextResponse.json({ error: "a file or folder named '" + name + "' already exists there" }, { status: 400 });
    const output = await cloneRepo(pr.root, url, name);
    const ok = fs.existsSync(path.join(dest, ".git"));
    return NextResponse.json({ ok, output, ...(ok ? { path: dest } : {}) });
  }

  if (!isRepo(pr.root)) return NextResponse.json({ error: "not a git repo" }, { status: 400 });
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!message) return NextResponse.json({ error: "commit message required" }, { status: 400 });
  const paths: string[] = Array.isArray(b.paths) ? b.paths.filter((p: unknown) => typeof p === "string") : [];
  for (const p of paths) {
    try { resolveSafe(pr.root, p); } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  const addOut = await runGit(pr.root, paths.length ? ["add", "--", ...paths] : ["add", "-A"]);
  if (addOut.startsWith("error:") || /\[exit \d+\]/.test(addOut)) {
    return NextResponse.json({ ok: false, output: addOut });
  }
  const out = await runGit(pr.root, ["commit", "-m", message]);
  const ok = !out.startsWith("error:") && !/\[exit \d+\]/.test(out);
  return NextResponse.json({ ok, output: out });
}
