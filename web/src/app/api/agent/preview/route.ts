// Run + preview a project's dev server from the /code UI: start it as a managed
// background process, capture its logs, and expose it on the tailnet at the same
// port (via `tailscale serve`) so it's reachable from any device without touching
// the project's own config. One preview at a time (mirrors this app's single-tenant
// GPU precedent — simpler than tracking multiple tailscale serve mounts + ports).
import { NextRequest, NextResponse } from "next/server";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";

const DEFAULT_WORKSPACE = path.join(path.resolve(process.cwd(), ".."), "workspace");
const LOG_CAP_BYTES = 65536;
const LOG_CAP_LINES = 400;
// Ports this app/box already depends on — refuse to let a preview collide with them.
const RESERVED_PORTS = new Set([8770, 8099, 11434, 8443, 3000]);

type PreviewState = {
  child: ChildProcess;
  project: string;
  command: string;
  port: number;
  startedAt: number;
  log: string[];
  logBytes: number;
  running: boolean;
  exitCode: number | null;
  tailscale: { ok: boolean; output: string } | null;
};

const g = globalThis as unknown as { __code_preview?: PreviewState };

function projectRoot(raw: string | null): { root: string } | { error: string } {
  if (!raw) { fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true }); return { root: DEFAULT_WORKSPACE }; }
  const p = path.resolve(raw);
  try {
    if (!fs.statSync(p).isDirectory()) return { error: "not a directory: " + p };
  } catch { return { error: "directory not found: " + p }; }
  return { root: p };
}

function appendLog(state: PreviewState, chunk: string) {
  for (const line of chunk.split("\n")) {
    if (!line) continue;
    state.log.push(line);
    state.logBytes += line.length;
  }
  while (state.log.length > LOG_CAP_LINES || state.logBytes > LOG_CAP_BYTES) {
    const dropped = state.log.shift();
    if (dropped === undefined) break;
    state.logBytes -= dropped.length;
  }
}

async function statusPayload() {
  const s = g.__code_preview;
  if (!s) return { running: false };
  const host = process.env.PREVIEW_HOST || os.hostname();
  return {
    running: s.running,
    project: s.project,
    command: s.command,
    port: s.port,
    startedAt: s.startedAt,
    pid: s.child.pid,
    exitCode: s.exitCode,
    log: s.log.join("\n"),
    localUrl: "http://127.0.0.1:" + s.port,
    // A tailnet already routes directly to this machine. Binding a project to
    // 0.0.0.0 lets a phone open http://main-pc:<port> without a Serve proxy.
    networkUrl: `http://${host}:${s.port}`,
    tailscale: s.tailscale,
  };
}

export async function GET() {
  return NextResponse.json(await statusPayload());
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b.op !== "string") return NextResponse.json({ error: "expected {op:'start'|'stop', ...}" }, { status: 400 });

  if (b.op === "stop") {
    const s = g.__code_preview;
    if (!s) return NextResponse.json({ ok: true, running: false });
    try { if (s.child.pid) process.kill(-s.child.pid, "SIGKILL"); } catch {}
    s.running = false;
    return NextResponse.json(await statusPayload());
  }

  if (b.op !== "start") return NextResponse.json({ error: "unknown op" }, { status: 400 });

  const existing = g.__code_preview;
  if (existing?.running) {
    return NextResponse.json(
      { error: `a preview is already running (${existing.project.split("/").pop()} on port ${existing.port}) — stop it first` },
      { status: 409 },
    );
  }

  const pr = projectRoot(typeof b.project === "string" && b.project ? b.project : null);
  if ("error" in pr) return NextResponse.json({ error: pr.error }, { status: 400 });
  const command = typeof b.command === "string" ? b.command.trim() : "";
  if (!command) return NextResponse.json({ error: "command required" }, { status: 400 });
  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return NextResponse.json({ error: "port must be between 1024 and 65535" }, { status: 400 });
  if (RESERVED_PORTS.has(port)) return NextResponse.json({ error: `port ${port} is used by this app/box already — pick another` }, { status: 400 });

  let child: ChildProcess;
  try {
    // detached so Stop can kill the whole process group (npm run dev often forks
    // a child of its own — killing just the shell leaves the real server running).
    child = spawn("bash", ["-c", command], { cwd: pr.root, detached: true });
  } catch (e) {
    return NextResponse.json({ error: "failed to start: " + (e as Error).message }, { status: 500 });
  }

  const state: PreviewState = {
    child, project: pr.root, command, port, startedAt: Date.now(),
    log: [], logBytes: 0, running: true, exitCode: null, tailscale: null,
  };
  g.__code_preview = state;
  child.stdout?.on("data", (d) => appendLog(state, d.toString()));
  child.stderr?.on("data", (d) => appendLog(state, d.toString()));
  child.on("exit", (code) => {
    state.running = false;
    state.exitCode = code;
  });
  child.on("error", (e) => appendLog(state, "error: " + e.message));

  // Give the command a moment to bind before returning its direct network URL.
  await new Promise((r) => setTimeout(r, 1500));

  return NextResponse.json(await statusPayload());
}
