"use client";
// Human file editor over /api/agent/fs. CodeMirror 6, loaded via dynamic import()
// only when a file is actually opened (never statically imported — keeps it out of
// the route bundle and away from SSR). Saves use an mtime handshake: a 409 means
// someone (usually the agent) wrote the file since we loaded it, and the user
// chooses reload vs overwrite — nothing is ever silently clobbered, in either
// direction.
import { useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { ExternalLink, Save, X } from "lucide-react";

async function languageFor(name: string) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  try {
    switch (ext) {
      case "ts": case "tsx":
        return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: ext === "tsx" });
      case "js": case "jsx": case "mjs": case "cjs":
        return (await import("@codemirror/lang-javascript")).javascript({ jsx: ext === "jsx" });
      case "py": return (await import("@codemirror/lang-python")).python();
      case "md": return (await import("@codemirror/lang-markdown")).markdown();
      case "json": case "jsonl": return (await import("@codemirror/lang-json")).json();
      case "html": case "htm": return (await import("@codemirror/lang-html")).html();
      case "css": return (await import("@codemirror/lang-css")).css();
      default: return null;
    }
  } catch { return null; }
}

type Notice = { kind: "conflict" | "disk-changed"; mtimeMs: number } | null;

export default function EditorPane({ project, filePath, refreshTick, rawHref, onClose, onSaved }: {
  project: string;
  filePath: string;
  refreshTick: number;
  rawHref: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const mtimeRef = useRef<number>(0);
  const dirtyRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "binary" | "error">("loading");
  const [errText, setErrText] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveRef = useRef<() => void>(() => {});

  const readFile = async () => {
    const qs = new URLSearchParams({ op: "read", path: filePath });
    if (project) qs.set("project", project);
    const r = await fetch("/api/agent/fs?" + qs.toString());
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "read failed");
    return j as { content: string; mtimeMs: number; binary: boolean; truncated: boolean };
  };

  const setDoc = (view: EditorView, content: string) => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    dirtyRef.current = false;
    setDirty(false);
  };

  // mount / file change: load content + build the editor
  useEffect(() => {
    let dead = false;
    setStatus("loading");
    setNotice(null);
    setDirty(false);
    dirtyRef.current = false;
    (async () => {
      try {
        const [{ basicSetup }, { EditorView, keymap }, { oneDark }, file] = await Promise.all([
          import("codemirror"),
          import("@codemirror/view"),
          import("@codemirror/theme-one-dark"),
          readFile(),
        ]);
        if (dead) return;
        if (file.binary) { setStatus("binary"); return; }
        mtimeRef.current = file.mtimeMs;
        setTruncated(file.truncated);
        const lang = await languageFor(filePath);
        if (dead || !hostRef.current) return;
        viewRef.current?.destroy();
        const view = new EditorView({
          doc: file.content,
          parent: hostRef.current,
          extensions: [
            basicSetup,
            oneDark,
            EditorView.theme({
              "&": { backgroundColor: "var(--surface-1)", fontSize: "12px", height: "100%" },
              ".cm-gutters": { backgroundColor: "var(--surface-1)" },
            }),
            keymap.of([{ key: "Mod-s", run: () => { saveRef.current(); return true; }, preventDefault: true }]),
            EditorView.updateListener.of((u) => {
              if (u.docChanged && !dirtyRef.current) { dirtyRef.current = true; setDirty(true); }
            }),
            ...(file.truncated ? [EditorView.editable.of(false)] : []),
            ...(lang ? [lang] : []),
          ],
        });
        viewRef.current = view;
        setStatus("ready");
      } catch (e) {
        if (!dead) { setStatus("error"); setErrText((e as Error).message); }
      }
    })();
    return () => {
      dead = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, filePath]);

  const save = async (force = false) => {
    const view = viewRef.current;
    if (!view || saving) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { project: project || undefined, path: filePath, content: view.state.doc.toString() };
      if (!force) body.baseMtimeMs = mtimeRef.current;
      const r = await fetch("/api/agent/fs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (r.status === 409) { setNotice({ kind: "conflict", mtimeMs: j.mtimeMs }); return; }
      if (!r.ok) { setErrText(j.error || "save failed"); return; }
      mtimeRef.current = j.mtimeMs;
      dirtyRef.current = false;
      setDirty(false);
      setNotice(null);
      setErrText("");
      onSaved();
    } finally { setSaving(false); }
  };
  saveRef.current = () => { void save(false); };

  const reloadFromDisk = async () => {
    try {
      const file = await readFile();
      if (file.binary) { setStatus("binary"); return; }
      mtimeRef.current = file.mtimeMs;
      if (viewRef.current) setDoc(viewRef.current, file.content);
      setNotice(null);
    } catch (e) { setErrText((e as Error).message); }
  };

  // agent touched files: refresh a clean editor silently; warn a dirty one
  useEffect(() => {
    if (!refreshTick || status !== "ready") return;
    (async () => {
      try {
        const file = await readFile();
        if (file.mtimeMs === mtimeRef.current) return;
        if (!dirtyRef.current && viewRef.current) {
          mtimeRef.current = file.mtimeMs;
          setDoc(viewRef.current, file.content);
        } else {
          setNotice({ kind: "disk-changed", mtimeMs: file.mtimeMs });
        }
      } catch { /* file may be mid-write; next tick will catch up */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-soft)] shrink-0">
        <span className="text-[11px] font-mono truncate">{filePath}</span>
        {dirty && <span className="text-[var(--accent-warn,#d29922)] text-sm leading-none" title="unsaved changes">•</span>}
        {truncated && <span className="text-[10px] text-[var(--muted)]">read-only (file &gt;1MB)</span>}
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <button onClick={() => save(false)} disabled={!dirty || saving} title="save (Ctrl+S)"
            className="flex items-center gap-1 text-[11px] border rounded px-2 py-1 disabled:opacity-30"
            style={{ borderColor: dirty ? "var(--accent-ai)" : "var(--border)", color: dirty ? "var(--accent-ai)" : "var(--muted)" }}>
            <Save size={12} /> save
          </button>
          <a href={rawHref} target="_blank" rel="noreferrer" title="open raw" className="text-[var(--muted)] hover:text-[var(--text-2)]">
            <ExternalLink size={13} />
          </a>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--text-2)]"><X size={14} /></button>
        </span>
      </div>

      {notice && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] border-b border-[var(--accent-warn,#d29922)]/50 text-[var(--accent-warn,#d29922)] shrink-0">
          {notice.kind === "conflict" ? "file changed on disk since you loaded it — not saved" : "file changed on disk (agent edit?) while you have unsaved changes"}
          <span className="ml-auto flex gap-2">
            <button onClick={reloadFromDisk} className="border border-[var(--border)] rounded px-2 py-0.5">reload from disk</button>
            {notice.kind === "conflict" && <button onClick={() => save(true)} className="border border-[var(--accent-warn,#d29922)] rounded px-2 py-0.5">overwrite anyway</button>}
          </span>
        </div>
      )}
      {errText && <div className="px-3 py-1 text-[11px] text-[var(--accent-danger)] shrink-0">{errText}</div>}

      {status === "loading" && <div className="p-4 text-xs text-[var(--muted)]">loading…</div>}
      {status === "binary" && (
        <div className="p-4 text-xs text-[var(--muted)]">
          binary file — <a href={rawHref} target="_blank" rel="noreferrer" className="text-[var(--accent-ai)]">open raw</a>
        </div>
      )}
      {status === "error" && <div className="p-4 text-xs text-[var(--accent-danger)]">{errText || "failed to open file"}</div>}
      <div ref={hostRef} className="flex-1 overflow-auto" style={{ display: status === "ready" ? undefined : "none" }} />
    </div>
  );
}
