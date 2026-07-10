"use client";
// Minimal git surface for the current /code project: branch, working-tree status,
// per-file diff, commit. Backed by /api/agent/git (fixed argv shapes server-side).
import { useEffect, useState } from "react";
import { GitBranch, GitCommitHorizontal, RefreshCw } from "lucide-react";

type StatusFile = { path: string; x: string; y: string };
type Status = { repo: boolean; branch?: string; ahead?: number; behind?: number; files?: StatusFile[] };

const codeColor = (x: string, y: string) => {
  if (x === "?" || x === "A") return "var(--accent-ai)";
  if (x === "D" || y === "D") return "var(--accent-danger)";
  return "var(--accent-warn, #d29922)";
};

function DiffView({ diff, truncated }: { diff: string; truncated?: boolean }) {
  return (
    <pre className="text-[10px] font-mono bg-[var(--surface-2,#11151c)] rounded p-2 overflow-auto max-h-72 whitespace-pre">
      {diff.split("\n").map((l, i) => (
        <div key={i} style={{
          color: l.startsWith("+") ? "var(--accent-success)" : l.startsWith("-") ? "var(--accent-danger)" : l.startsWith("@@") ? "var(--text-2)" : "var(--muted)",
        }}>{l || " "}</div>
      ))}
      {truncated && <div className="text-[var(--muted)]">[diff truncated]</div>}
    </pre>
  );
}

export default function GitPanel({ project, refreshTick, onCommitted }: {
  project: string;
  refreshTick: number;
  onCommitted: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ diff: string; truncated?: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");

  const load = async () => {
    try {
      const qs = new URLSearchParams({ op: "status" });
      if (project) qs.set("project", project);
      const r = await fetch("/api/agent/git?" + qs.toString());
      const j = (await r.json()) as Status;
      setStatus(j);
      setChecked(new Set((j.files ?? []).map((f) => f.path)));
    } catch { setStatus(null); }
  };

  useEffect(() => { load(); setDiffFor(null); setDiff(null); setOutput(""); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [project]);
  useEffect(() => { if (refreshTick) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [refreshTick]);

  const showDiff = async (p: string) => {
    if (diffFor === p) { setDiffFor(null); setDiff(null); return; }
    setDiffFor(p);
    setDiff(null);
    try {
      const qs = new URLSearchParams({ op: "diff", path: p });
      if (project) qs.set("project", project);
      const r = await fetch("/api/agent/git?" + qs.toString());
      setDiff(await r.json());
    } catch { setDiff({ diff: "(diff failed)" }); }
  };

  const commit = async () => {
    if (!message.trim() || busy) return;
    setBusy(true);
    setOutput("");
    try {
      const r = await fetch("/api/agent/git", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: project || undefined, op: "commit", message: message.trim(), paths: [...checked] }),
      });
      const j = await r.json();
      setOutput(j.output || j.error || "");
      if (j.ok) { setMessage(""); setDiffFor(null); setDiff(null); await load(); onCommitted(); }
    } catch (e) { setOutput((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!status) return <div className="p-3 text-[11px] text-[var(--muted)]">loading…</div>;
  if (!status.repo) return <div className="p-3 text-[11px] text-[var(--muted)]">not a git repository</div>;

  const files = status.files ?? [];
  return (
    <div className="p-2 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-mono px-1">
        <GitBranch size={12} className="text-[var(--accent-ai)] shrink-0" />
        <span className="truncate">{status.branch || "(no branch)"}</span>
        {(status.ahead ?? 0) > 0 && <span className="text-[var(--muted)]">↑{status.ahead}</span>}
        {(status.behind ?? 0) > 0 && <span className="text-[var(--muted)]">↓{status.behind}</span>}
        <button onClick={load} title="refresh" className="ml-auto text-[var(--muted)] hover:text-[var(--text-2)]"><RefreshCw size={11} /></button>
      </div>

      {files.length === 0 && <div className="text-[11px] text-[var(--muted)] px-1">working tree clean</div>}
      {files.map((f) => (
        <div key={f.path}>
          <div className="flex items-center gap-1.5 text-[11px] font-mono">
            <input type="checkbox" checked={checked.has(f.path)}
              onChange={(e) => setChecked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(f.path); else n.delete(f.path); return n; })} />
            <button onClick={() => showDiff(f.path)} className="flex items-center gap-1.5 min-w-0 hover:text-[var(--accent-ai)] text-left">
              <span className="w-5 shrink-0 text-center" style={{ color: codeColor(f.x, f.y) }}>{(f.x + f.y).trim()}</span>
              <span className="truncate">{f.path}</span>
            </button>
          </div>
          {diffFor === f.path && (diff ? <DiffView diff={diff.diff} truncated={diff.truncated} /> : <div className="text-[10px] text-[var(--muted)] pl-6">loading diff…</div>)}
        </div>
      ))}

      {files.length > 0 && (
        <div className="space-y-1.5 pt-1 border-t border-[var(--border-soft)]">
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="commit message…"
            className="w-full bg-[var(--surface-2,#11151c)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] font-mono resize-none" />
          <button onClick={commit} disabled={!message.trim() || checked.size === 0 || busy}
            className="w-full flex items-center justify-center gap-1.5 text-[11px] font-semibold bg-[var(--accent-ai)] text-[#05090c] rounded px-2 py-1.5 disabled:opacity-40">
            <GitCommitHorizontal size={13} /> {busy ? "committing…" : `commit ${checked.size} file${checked.size === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
      {output && <pre className="text-[10px] text-[var(--muted)] whitespace-pre-wrap bg-[var(--surface-2,#11151c)] rounded p-2 max-h-32 overflow-auto">{output}</pre>}
    </div>
  );
}
