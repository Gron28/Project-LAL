"use client";
// Modal directory browser for picking a /code project folder — replaces the old
// window.prompt. Browses via /api/agent/browse ($HOME-confined, dirs only).
import { useEffect, useState } from "react";
import { ArrowUp, Folder, FolderGit2, FolderPlus, GitBranch, X } from "lucide-react";

type Listing = { path: string; parent: string | null; home: string; dirs: string[]; isGit: boolean };

// Guess a folder name from a git remote URL, same convention `git clone` itself uses:
// last path segment, minus a trailing .git.
function nameFromUrl(url: string): string {
  const seg = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() || "";
  return seg.replace(/\.git$/, "");
}

export default function DirPicker({ open, recents, onPick, onClose }: {
  open: boolean;
  recents: string[];
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [manual, setManual] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"browse" | "clone" | "new">("browse");
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [cloneNameTouched, setCloneNameTouched] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneMsg, setCloneMsg] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState("");

  const nav = async (path?: string, hidden = showHidden) => {
    setError("");
    try {
      const qs = new URLSearchParams();
      if (path) qs.set("path", path);
      if (hidden) qs.set("hidden", "1");
      const r = await fetch("/api/agent/browse?" + qs.toString());
      const j = await r.json();
      if (!r.ok) { setError(j.error || "failed to open directory"); return; }
      setListing(j);
    } catch {
      setError("failed to open directory");
    }
  };

  useEffect(() => {
    // Reset form state + reload the listing when the modal opens — the reload is an
    // async fetch (nav), not derivable at render.
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setManual(""); setTab("browse"); setCloneUrl(""); setCloneName(""); setCloneNameTouched(false); setCloneMsg("");
      setNewName(""); setCreateMsg("");
      nav(listing?.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const doCreate = async () => {
    if (!listing || !newName.trim() || creating) return;
    setCreating(true);
    setCreateMsg("");
    try {
      const r = await fetch("/api/agent/projects", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: listing.path + "/" + newName.trim(), create: true }),
      });
      const j = await r.json();
      if (j.ok && j.path) onPick(j.path);
      else setCreateMsg(j.error || "create failed");
    } catch (e) { setCreateMsg((e as Error).message); }
    finally { setCreating(false); }
  };

  const doClone = async () => {
    if (!listing || !cloneUrl.trim() || !cloneName.trim() || cloning) return;
    setCloning(true);
    setCloneMsg("");
    try {
      const r = await fetch("/api/agent/git", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: listing.path, op: "clone", url: cloneUrl.trim(), name: cloneName.trim() }),
      });
      const j = await r.json();
      if (j.ok && j.path) onPick(j.path);
      else setCloneMsg(j.error || j.output || "clone failed");
    } catch (e) { setCloneMsg((e as Error).message); }
    finally { setCloning(false); }
  };

  if (!open) return null;

  const crumbs = (() => {
    if (!listing) return [];
    const { home, path } = listing;
    if (path === home) return [{ label: "~", path: home }];
    const rest = path.slice(home.length).split("/").filter(Boolean);
    const out = [{ label: "~", path: home }];
    let acc = home;
    for (const seg of rest) { acc += "/" + seg; out.push({ label: seg, path: acc }); }
    return out;
  })();

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-xl w-[620px] max-w-full max-h-[85vh] min-h-0 flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-soft)]">
          <div className="flex items-center gap-1">
            <button onClick={() => setTab("browse")}
              className={"text-xs font-semibold tracking-widest rounded px-2 py-1 " + (tab === "browse" ? "text-[var(--accent-ai)] bg-[var(--surface-2,#11151c)]" : "text-[var(--muted)]")}>
              OPEN FOLDER
            </button>
            <button onClick={() => setTab("clone")}
              className={"flex items-center gap-1.5 text-xs font-semibold tracking-widest rounded px-2 py-1 " + (tab === "clone" ? "text-[var(--accent-ai)] bg-[var(--surface-2,#11151c)]" : "text-[var(--muted)]")}>
              <GitBranch size={12} /> CLONE
            </button>
            <button onClick={() => setTab("new")}
              className={"flex items-center gap-1.5 text-xs font-semibold tracking-widest rounded px-2 py-1 " + (tab === "new" ? "text-[var(--accent-ai)] bg-[var(--surface-2,#11151c)]" : "text-[var(--muted)]")}>
              <FolderPlus size={12} /> NEW
            </button>
          </div>
          <label className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--muted)] cursor-pointer">
            <input type="checkbox" checked={showHidden} onChange={(e) => { setShowHidden(e.target.checked); nav(listing?.path, e.target.checked); }} />
            hidden
          </label>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--text-2)]"><X size={15} /></button>
        </div>

        {tab === "clone" && (
          <div className="px-4 pt-2 pb-1 text-[11px] text-[var(--muted)] border-b border-[var(--border-soft)] shrink-0">
            navigate to the folder to clone into, then fill in the repo below
          </div>
        )}
        {tab === "new" && (
          <div className="px-4 pt-2 pb-1 text-[11px] text-[var(--muted)] border-b border-[var(--border-soft)] shrink-0">
            navigate to where the new project should live, then name it below
          </div>
        )}
        {tab === "browse" && recents.length > 0 && (
          <div className="px-4 pt-2 pb-1 border-b border-[var(--border-soft)] shrink-0">
            <div className="text-[10px] uppercase tracking-widest text-[var(--muted)] mb-1">recent</div>
            <div className="flex flex-wrap gap-1.5 pb-2">
              {recents.slice(0, 4).map((p) => (
                <button key={p} onClick={() => onPick(p)} title={p}
                  className="text-[11px] font-mono border border-[var(--border)] rounded px-2 py-1 hover:border-[var(--accent-ai)] hover:text-[var(--accent-ai)]">
                  {p.split("/").slice(-2).join("/")}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-1 px-4 py-2 text-xs font-mono flex-wrap shrink-0">
          <button onClick={() => listing?.parent && nav(listing.parent)} disabled={!listing?.parent}
            title="up one level" className="mr-1 text-[var(--text-2)] disabled:opacity-30"><ArrowUp size={13} /></button>
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-1">
              {i > 0 && <span className="text-[var(--muted)]">/</span>}
              <button onClick={() => nav(c.path)} className="hover:text-[var(--accent-ai)]">{c.label}</button>
            </span>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-2">
          {error && <div className="text-xs text-[var(--accent-danger)] px-2 py-1">{error}</div>}
          {listing?.dirs.length === 0 && !error && <div className="text-xs text-[var(--muted)] px-2 py-1">no subdirectories</div>}
          {listing?.dirs.map((d) => (
            <button key={d}
              onDoubleClick={() => tab === "browse" && onPick(listing.path + "/" + d)}
              onClick={() => nav(listing.path + "/" + d)}
              title={tab === "browse" ? "click to enter, double-click to select" : "click to enter"}
              className="w-full flex items-center gap-2 text-xs font-mono px-2 py-1.5 rounded hover:bg-[var(--surface-2,#11151c)] text-left">
              <Folder size={13} className="text-[var(--muted)] shrink-0" />
              <span className="truncate">{d}</span>
            </button>
          ))}
        </div>

        {tab === "browse" ? (
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-[var(--border-soft)] shrink-0">
            <input value={manual} onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && manual.trim()) onPick(manual.trim()); }}
              placeholder="or paste an absolute path…"
              className="flex-1 bg-[var(--surface-2,#11151c)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] font-mono" />
            {listing?.isGit && (
              <span className="flex items-center gap-1 text-[10px] text-[var(--accent-ai)]" title="this folder is a git repository">
                <FolderGit2 size={12} /> git
              </span>
            )}
            <button onClick={() => manual.trim() ? onPick(manual.trim()) : listing && onPick(listing.path)}
              className="text-xs font-semibold bg-[var(--accent-ai)] text-[#05090c] rounded px-3 py-1.5">
              Select {manual.trim() ? "path" : "this folder"}
            </button>
          </div>
        ) : tab === "clone" ? (
          <div className="flex flex-col gap-2 px-4 py-3 border-t border-[var(--border-soft)] shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--muted)] shrink-0">into:</span>
              <span className="text-[11px] font-mono truncate" title={listing?.path}>{listing?.path}</span>
            </div>
            <input value={cloneUrl}
              onChange={(e) => { setCloneUrl(e.target.value); if (!cloneNameTouched) setCloneName(nameFromUrl(e.target.value)); }}
              placeholder="git remote URL (https://…, git@host:…)"
              className="bg-[var(--surface-2,#11151c)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] font-mono" />
            <div className="flex items-center gap-2">
              <input value={cloneName} onChange={(e) => { setCloneName(e.target.value); setCloneNameTouched(true); }}
                placeholder="folder name" className="flex-1 bg-[var(--surface-2,#11151c)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] font-mono" />
              <button onClick={doClone} disabled={!cloneUrl.trim() || !cloneName.trim() || cloning}
                className="text-xs font-semibold bg-[var(--accent-ai)] text-[#05090c] rounded px-3 py-1.5 disabled:opacity-40 shrink-0">
                {cloning ? "cloning…" : "Clone here"}
              </button>
            </div>
            {cloneMsg && <pre className="text-[10px] text-[var(--accent-danger)] whitespace-pre-wrap max-h-20 overflow-auto">{cloneMsg}</pre>}
          </div>
        ) : (
          <div className="flex flex-col gap-2 px-4 py-3 border-t border-[var(--border-soft)] shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--muted)] shrink-0">into:</span>
              <span className="text-[11px] font-mono truncate" title={listing?.path}>{listing?.path}</span>
            </div>
            <div className="flex items-center gap-2">
              <input value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) doCreate(); }}
                placeholder="new folder name" className="flex-1 bg-[var(--surface-2,#11151c)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] font-mono" />
              <button onClick={doCreate} disabled={!newName.trim() || creating}
                className="text-xs font-semibold bg-[var(--accent-ai)] text-[#05090c] rounded px-3 py-1.5 disabled:opacity-40 shrink-0">
                {creating ? "creating…" : "Create project here"}
              </button>
            </div>
            {createMsg && <pre className="text-[10px] text-[var(--accent-danger)] whitespace-pre-wrap max-h-20 overflow-auto">{createMsg}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}
