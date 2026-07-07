"use client";
// Lazy file tree over /api/agent/fs (project-confined). Directories fetch on
// expand; refreshTick refetches everything currently expanded (bumped by the
// page when an agent tool mutates files, or after a human save/commit).
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";

type Entry = { name: string; dir: boolean; size?: number };

const DIM_DIRS = new Set(["node_modules", ".git", ".next", "__pycache__"]);

export default function FileTree({ project, refreshTick, onOpenFile, selected }: {
  project: string;
  refreshTick: number;
  onOpenFile: (rel: string) => void;
  selected: string | null;
}) {
  const [dirs, setDirs] = useState<Map<string, Entry[] | "loading">>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["."]));
  const [error, setError] = useState("");

  const fetchDir = async (rel: string): Promise<Entry[]> => {
    const qs = new URLSearchParams({ op: "list", path: rel });
    if (project) qs.set("project", project);
    const r = await fetch("/api/agent/fs?" + qs.toString());
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "list failed");
    return j.entries as Entry[];
  };

  // project change: reset and load root
  useEffect(() => {
    setDirs(new Map());
    setExpanded(new Set(["."]));
    setError("");
    fetchDir(".")
      .then((e) => setDirs(new Map([[".", e]])))
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // agent touched files: refetch every expanded dir (cheap parallel lists)
  useEffect(() => {
    if (!refreshTick) return;
    const open = [...expanded];
    Promise.all(open.map(async (rel) => [rel, await fetchDir(rel).catch(() => null)] as const))
      .then((pairs) => setDirs((prev) => {
        const next = new Map(prev);
        for (const [rel, e] of pairs) if (e) next.set(rel, e);
        return next;
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const toggle = (rel: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) { next.delete(rel); return next; }
      next.add(rel);
      return next;
    });
    if (!dirs.has(rel)) {
      setDirs((prev) => new Map(prev).set(rel, "loading"));
      fetchDir(rel)
        .then((e) => setDirs((prev) => new Map(prev).set(rel, e)))
        .catch(() => setDirs((prev) => { const n = new Map(prev); n.delete(rel); return n; }));
    }
  };

  const render = (rel: string, depth: number): React.ReactNode => {
    const entries = dirs.get(rel);
    if (entries === "loading") return <div key={rel + "/…"} className="text-[10px] text-[var(--muted)]" style={{ paddingLeft: depth * 12 + 20 }}>loading…</div>;
    if (!entries) return null;
    return entries.map((e) => {
      const childRel = rel === "." ? e.name : rel + "/" + e.name;
      if (e.dir) {
        const open = expanded.has(childRel);
        const dim = DIM_DIRS.has(e.name);
        return (
          <div key={childRel}>
            <button onClick={() => toggle(childRel)}
              className={"w-full flex items-center gap-1.5 text-[11px] font-mono py-1 rounded hover:bg-[var(--surface-2,#11151c)] text-left " + (dim ? "opacity-40" : "")}
              style={{ paddingLeft: depth * 12 + 4 }}>
              {open ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
              <Folder size={11} className="text-[var(--muted)] shrink-0" />
              <span className="truncate">{e.name}</span>
            </button>
            {open && render(childRel, depth + 1)}
          </div>
        );
      }
      return (
        <button key={childRel} onClick={() => onOpenFile(childRel)}
          className={"w-full flex items-center gap-1.5 text-[11px] font-mono py-1 rounded text-left hover:bg-[var(--surface-2,#11151c)] "
            + (selected === childRel ? "text-[var(--accent-ai)] bg-[var(--surface-2,#11151c)]" : "text-[var(--text-2)]")}
          style={{ paddingLeft: depth * 12 + 20 }}>
          <File size={11} className="shrink-0 text-[var(--muted)]" />
          <span className="truncate">{e.name}</span>
        </button>
      );
    });
  };

  return (
    <div className="py-1">
      {error && <div className="text-[11px] text-[var(--accent-danger)] px-2 py-1">{error}</div>}
      {render(".", 0)}
    </div>
  );
}
