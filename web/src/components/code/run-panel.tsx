"use client";
// "Run" tab: start a project's dev server as a managed background process and view
// it — locally and, via tailscale serve, from any device on the tailnet. Backed by
// /api/agent/preview (one global preview slot, matching this app's single-tenant
// GPU precedent elsewhere in the codebase).
import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Eye, EyeOff, Play, Square } from "lucide-react";

type Status = {
  running: boolean;
  project?: string;
  command?: string;
  port?: number;
  startedAt?: number;
  pid?: number;
  exitCode?: number | null;
  log?: string;
  localUrl?: string;
  tailnetUrl?: string | null;
  tailnetHost?: string | null;
  tailscale?: { ok: boolean; output: string } | null;
};

const fmtUptime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
};

export default function RunPanel({ project }: { project: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [command, setCommand] = useState("npm run dev");
  const [port, setPort] = useState(3000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showFrame, setShowFrame] = useState(false);
  const [now, setNow] = useState(() => Date.now()); // drives the uptime clock
  const logRef = useRef<HTMLPreElement>(null);

  const poll = async () => {
    try {
      const r = await fetch("/api/agent/preview");
      const j = (await r.json()) as Status;
      setStatus(j);
      if (j.port) setPort(j.port);
      if (j.command) setCommand(j.command);
    } catch { /* ignore a missed poll */ }
  };

  useEffect(() => {
    // Fetch-on-mount + poll — the setState happens inside poll()'s async continuation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    poll();
    const iv = setInterval(poll, 2000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(iv); clearInterval(clock); };
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [status?.log]);

  const start = async () => {
    if (!command.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/agent/preview", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "start", project: project || undefined, command: command.trim(), port }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error || "failed to start"); return; }
      setStatus(j);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/agent/preview", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "stop" }),
      });
      setStatus(await r.json());
      setShowFrame(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const running = !!status?.running;
  const someoneElse = running && status?.project && project && status.project !== project;
  const openUrl = status?.tailnetUrl || status?.localUrl || "";

  return (
    <div className="p-2 space-y-2">
      {!running && (
        <div className="space-y-1.5 px-1">
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm run dev"
            className="w-full bg-[var(--surface-2,#11151c)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] font-mono" />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--muted)]">port</span>
            <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))}
              className="w-20 bg-[var(--surface-2,#11151c)] border border-[var(--border)] rounded px-2 py-1 text-[11px] font-mono" />
            <button onClick={start} disabled={!command.trim() || busy}
              className="ml-auto flex items-center gap-1.5 text-[11px] font-semibold bg-[var(--accent-ai)] text-[#05090c] rounded px-3 py-1.5 disabled:opacity-40">
              <Play size={12} /> start
            </button>
          </div>
          {error && <div className="text-[11px] text-[var(--accent-danger)]">{error}</div>}
          <div className="text-[10px] text-[var(--muted)]">runs in this project&apos;s folder; exposed on the tailnet at the same port while running</div>
        </div>
      )}

      {running && (
        <div className="space-y-1.5 px-1">
          {someoneElse && (
            <div className="text-[11px] text-[var(--accent-warn,#d29922)]">
              running for {status.project} — only one preview at a time
            </div>
          )}
          <div className="flex items-center gap-2 text-[11px] font-mono">
            <span className="w-2 h-2 rounded-full bg-[var(--accent-ai)] shrink-0" />
            <span className="truncate">{status.command}</span>
          </div>
          <div className="text-[10px] text-[var(--muted)] flex items-center gap-2">
            <span>pid {status.pid}</span>
            <span>·</span>
            <span>{status.startedAt ? fmtUptime(now - status.startedAt) : ""}</span>
            <button onClick={stop} disabled={busy} className="ml-auto flex items-center gap-1 text-[var(--accent-danger)] border border-[var(--accent-danger)]/50 rounded px-2 py-0.5">
              <Square size={10} /> stop
            </button>
          </div>

          {status.tailscale?.ok === false && (
            <div className="text-[10px] text-[var(--accent-warn,#d29922)]">
              tailnet exposure failed — reachable locally only ({status.tailscale.output.slice(0, 140)})
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <a href={openUrl} target="_blank" rel="noreferrer" title={openUrl}
              className="flex-1 flex items-center gap-1.5 text-[11px] text-[var(--accent-ai)] border border-[var(--border)] rounded px-2 py-1 truncate">
              <ExternalLink size={11} className="shrink-0" /> <span className="truncate">{openUrl}</span>
            </a>
            <button onClick={() => navigator.clipboard?.writeText(openUrl).catch(() => {})} title="copy link" className="text-[var(--muted)] hover:text-[var(--text-2)]">
              <Copy size={13} />
            </button>
            <button onClick={() => setShowFrame((v) => !v)} title={showFrame ? "hide preview" : "try live preview"} className="text-[var(--muted)] hover:text-[var(--text-2)]">
              {showFrame ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>

          {showFrame && (
            <div className="border border-[var(--border)] rounded overflow-hidden" style={{ height: 260 }}>
              <iframe src={openUrl} className="w-full h-full bg-white" title="live preview"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
            </div>
          )}

          <pre ref={logRef} className="text-[10px] font-mono bg-[var(--surface-2,#11151c)] rounded p-2 overflow-auto max-h-56 whitespace-pre-wrap">
            {status.log || "(no output yet)"}
          </pre>
        </div>
      )}
    </div>
  );
}
