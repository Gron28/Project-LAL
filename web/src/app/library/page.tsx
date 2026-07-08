"use client";
import { useEffect, useState } from "react";
import { ExternalLink, FolderOpen, MessageSquare, Pencil, Terminal, Trash2, X } from "lucide-react";
import FileTree from "@/components/code/file-tree";
import EditorPane from "@/components/code/editor-pane";
import DirPicker from "@/components/code/dir-picker";

type M = { name: string; source: "local" | "ollama"; gb: number };
type Doc = { id: string; name: string; folder: string; chars: number; ts: number };
type DataFile = { name: string; chars: number; kind: "raw" | "sft" };
type ConvoRow = { id: string; title: string; updatedAt: number; kind: "chat" | "code"; project?: string };
type ProjectRow = { path: string; exists: boolean };

const DATASETS = "__datasets";

const card = "bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)]";
const head = "px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase text-[var(--text-2)] flex items-center gap-2";
const btn = "text-[11px] tracking-wide border border-[var(--border)] text-[var(--text-2)] rounded-[var(--r-md)] px-2.5 py-1 hover:border-[var(--border-loud)] hover:text-[var(--text)]";

function Models() {
  const [detail, setDetail] = useState<M[]>([]);
  const [current, setCurrent] = useState("");
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const load = () => fetch("/api/agent/models").then((r) => r.json()).then((j) => { setDetail(j.detail || []); setCurrent(j.current || ""); });
  useEffect(() => { load(); }, []);
  const setCur = async (n: string) => { await fetch("/api/agent/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: n }) }); load(); };
  const del = async (n: string, source: "local" | "ollama") => { if (!confirm("Delete " + n + "?")) return; await fetch("/api/agent/models?name=" + encodeURIComponent(n) + "&source=" + source, { method: "DELETE" }); load(); };
  const startRename = (n: string) => { setRenamingName(n); setRenameVal(n); };
  const doRename = async (oldName: string) => {
    const to = renameVal.trim();
    setRenamingName(null);
    if (!to || to === oldName) return;
    const r = await fetch("/api/agent/models", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: oldName, to }) }).then((x) => x.json());
    if (!r.ok) alert(r.error || "rename failed");
    load();
  };

  const Row = ({ m }: { m: M }) => {
    const isRenaming = renamingName === m.name;
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-soft)] last:border-0">
        {isRenaming ? (
          <input
            autoFocus
            className="flex-1 text-sm bg-[var(--surface-2)] border border-[var(--border-loud)] rounded px-2 py-0.5 outline-none"
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doRename(m.name); if (e.key === "Escape") setRenamingName(null); }}
            onBlur={() => doRename(m.name)}
          />
        ) : (
          <span className="flex-1 truncate text-sm" style={{ color: m.name === current ? "var(--accent-ai)" : "var(--text)" }}>{m.name}</span>
        )}
        <span className="text-[10px] text-[var(--muted)] w-12 text-right">{m.gb}GB</span>
        {m.name === current ? <span className="text-[10px] px-2 py-1 rounded-full border border-[var(--accent-ai)] text-[var(--accent-ai)]">CURRENT</span> : <button className={btn} onClick={() => setCur(m.name)}>Use</button>}
        {m.source === "local" && <button className={btn} title="Rename" onClick={() => isRenaming ? doRename(m.name) : startRename(m.name)}>{isRenaming ? "✓" : "✎"}</button>}
        {m.source === "local" && <a className={btn} href={"/api/download?model=" + encodeURIComponent(m.name)}>⤓</a>}
        <button className={btn} onClick={() => del(m.name, m.source)}>✕</button>
      </div>
    );
  };
  const trained = detail.filter((m) => m.source === "local"), installed = detail.filter((m) => m.source === "ollama");
  return (
    <div className="flex flex-col gap-4">
      <div className={card}>
        <div className={head}><span className="text-[var(--accent-ai)]">◆</span> YOUR TRAINED MODELS</div>
        {trained.length ? trained.map((m) => <Row key={m.name} m={m} />) : <div className="p-6 text-center text-[var(--muted)] text-xs">No trained models yet — make one in Train.</div>}
      </div>
      <div className={card}>
        <div className={head}><span className="text-[var(--accent-ai)]">◆</span> INSTALLED <span className="ml-auto text-[var(--muted)] normal-case tracking-normal">reused, no re-download</span></div>
        {installed.map((m) => <Row key={m.name} m={m} />)}
      </div>
    </div>
  );
}

function Documents() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [dataFiles, setDataFiles] = useState<DataFile[]>([]);
  const [sel, setSel] = useState<string>("__all");
  const [status, setStatus] = useState("");

  const loadDocs = () => {
    fetch("/api/docs").then((r) => r.json()).then(setDocs);
    fetch("/api/folders").then((r) => r.json()).then(setFolders);
  };
  const loadDatasets = () => fetch("/api/train/data").then((r) => r.json()).then((j) => setDataFiles(j.files || [])).catch(() => {});
  useEffect(() => { loadDocs(); loadDatasets(); }, []);

  // ---- dataset folder handlers ----
  async function onDatasetFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files; if (!files?.length) return;
    for (const f of Array.from(files)) {
      setStatus("uploading " + f.name + "…");
      const fd = new FormData(); fd.append("file", f);
      try {
        const j = await fetch("/api/train/data", { method: "POST", body: fd }).then((r) => r.json());
        setStatus(j.ok ? `✓ added ${j.name || f.name}` : "✗ " + (j.error || "upload failed"));
      } catch { setStatus("✗ upload failed"); }
    }
    e.target.value = ""; loadDatasets();
  }
  const delDataset = async (name: string) => {
    await fetch("/api/train/data?file=" + encodeURIComponent(name), { method: "DELETE" });
    setStatus("✓ deleted " + name); loadDatasets();
  };

  // ---- normal doc handlers ----
  const uploadFolder = sel === "__all" ? "" : sel;
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files; if (!files?.length) return;
    for (const f of Array.from(files)) {
      setStatus("uploading " + f.name + "…");
      const fd = new FormData(); fd.append("file", f); fd.append("folder", uploadFolder);
      try { const j = await fetch("/api/docs", { method: "POST", body: fd }).then((r) => r.json()); setStatus(j.error ? "✗ " + j.error : `✓ added ${f.name}`); } catch { setStatus("✗ failed"); }
    }
    e.target.value = ""; loadDocs();
  }
  const del = async (id: string) => { await fetch("/api/docs?id=" + id, { method: "DELETE" }); loadDocs(); };
  const move = async (id: string, folder: string) => { await fetch("/api/docs", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, folder }) }); loadDocs(); };
  const newFolder = async () => { const n = prompt("Folder name:")?.trim(); if (!n) return; await fetch("/api/folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) }); setSel(n); loadDocs(); };
  const delFolder = async (n: string) => { if (!confirm(`Delete folder "${n}"? (documents move to Uncategorized)`)) return; await fetch("/api/folders?name=" + encodeURIComponent(n), { method: "DELETE" }); if (sel === n) setSel("__all"); loadDocs(); };

  const shown = sel === "__all" ? docs : docs.filter((d) => (d.folder || "") === sel);
  const count = (f: string) => docs.filter((d) => (d.folder || "") === f).length;

  const chip = (id: string, label: string, n: number, removable?: boolean) => (
    <span key={id} className="inline-flex items-center">
      <button onClick={() => setSel(id)} className="px-3 py-1.5 text-[11px] tracking-wide rounded-l-[var(--r-md)] border"
        style={{ color: sel === id ? "#05090c" : "var(--text-2)", background: sel === id ? "var(--accent-ai)" : "var(--surface-1)", borderColor: "var(--border)", fontWeight: sel === id ? 700 : 400, borderRight: removable ? 0 : undefined, borderRadius: removable ? undefined : "var(--r-md)" }}>
        {label} <span style={{ opacity: 0.6 }}>{n}</span>
      </button>
      {removable && <button onClick={() => delFolder(id)} title="Delete folder" className="px-2 py-1.5 text-[11px] rounded-r-[var(--r-md)] border border-l-0" style={{ color: "var(--muted)", background: sel === id ? "var(--accent-ai)" : "var(--surface-1)", borderColor: "var(--border)" }}>✕</button>}
    </span>
  );

  const isDatasets = sel === DATASETS;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 flex-wrap items-center">
        {chip("__all", "All", docs.length)}
        {chip("", "Uncategorized", count(""))}
        {folders.map((f) => chip(f, f, count(f), true))}
        {/* permanent training-data folder */}
        <button onClick={() => setSel(DATASETS)} className="px-3 py-1.5 text-[11px] tracking-wide rounded-[var(--r-md)] border"
          style={{ color: isDatasets ? "#05090c" : "var(--accent-ai)", background: isDatasets ? "var(--accent-ai)" : "var(--surface-1)", borderColor: isDatasets ? "var(--accent-ai)" : "var(--accent-ai)", fontWeight: isDatasets ? 700 : 400 }}>
          ◆ Training Data <span style={{ opacity: 0.6 }}>{dataFiles.length}</span>
        </button>
        <button onClick={newFolder} className={btn}>+ Folder</button>
      </div>

      <div className={card}>
        <div className={head}>
          <span className="text-[var(--accent-ai)]">◆</span>
          {isDatasets ? "TRAINING DATA" : sel === "__all" ? "ALL DOCUMENTS" : sel === "" ? "UNCATEGORIZED" : sel.toUpperCase()}
          {isDatasets
            ? <span className="ml-auto text-[var(--muted)] normal-case tracking-normal text-[10px]">synced with Train page</span>
            : null}
          <span className={isDatasets ? "" : "ml-auto"}>
            <label className="text-[10px] tracking-widest uppercase text-[var(--accent-ai)] cursor-pointer border border-[var(--border)] rounded px-2 py-1 hover:border-[var(--border-loud)]">
              ⬆ Upload{!isDatasets && sel !== "__all" && sel !== "" ? " → " + sel : ""}
              <input type="file" multiple accept={isDatasets ? ".txt,.jsonl,.pdf,.md" : ".pdf,.txt,.md,.text"} className="hidden" onChange={isDatasets ? onDatasetFile : onFile} />
            </label>
          </span>
        </div>

        {status && <div className="px-4 py-2 text-[10px] text-[var(--muted)] border-b border-[var(--border-soft)]">{status}</div>}

        {isDatasets ? (
          dataFiles.length ? dataFiles.map((f) => (
            <div key={f.name} className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-soft)] last:border-0">
              <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-widest shrink-0 ${f.kind === "sft" ? "bg-[var(--accent-ai)]/20 text-[var(--accent-ai)]" : "bg-[var(--surface-3)] text-[var(--muted)]"}`}>{f.kind}</span>
              <span className="flex-1 truncate text-sm">{f.name}</span>
              <span className="text-[10px] text-[var(--muted)] hidden sm:inline">{f.chars >= 1000 ? (f.chars / 1000).toFixed(0) + "k" : f.chars} chars</span>
              <button className={btn} onClick={() => delDataset(f.name)}>✕</button>
            </div>
          )) : <div className="p-6 text-center text-[var(--muted)] text-xs">No training datasets yet — upload a .txt or .jsonl file above.</div>
        ) : (
          shown.length ? shown.map((d) => (
            <div key={d.id} className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-soft)] last:border-0">
              <span className="flex-1 truncate text-sm">{d.name}</span>
              <span className="text-[10px] text-[var(--muted)] hidden sm:inline">{(d.chars / 1000).toFixed(0)}k</span>
              <select value={d.folder || ""} onChange={(e) => move(d.id, e.target.value)} className="text-[10px] bg-[var(--surface-2)] border border-[var(--border)] rounded px-1 py-1 text-[var(--text-2)] outline-none">
                <option value="">Uncategorized</option>
                {folders.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <button className={btn} onClick={() => del(d.id)}>✕</button>
            </div>
          )) : <div className="p-6 text-center text-[var(--muted)] text-xs">No documents here — upload above. Then chat with the document (globe-doc) toggle on.</div>
        )}
      </div>
    </div>
  );
}

function relTime(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function Chats() {
  const [convos, setConvos] = useState<ConvoRow[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [filter, setFilter] = useState<"all" | "chat" | "code">("all");

  const load = () => fetch("/api/agent/conversations").then((r) => r.json()).then(setConvos).catch(() => {});
  useEffect(() => { load(); }, []);

  const del = async (id: string) => {
    if (!confirm("Delete this conversation? This can't be undone.")) return;
    await fetch(`/api/agent/conversations/${id}`, { method: "DELETE" });
    load();
  };
  const startRename = (c: ConvoRow) => { setRenamingId(c.id); setRenameVal(c.title); };
  const doRename = async (id: string) => {
    const title = renameVal.trim();
    setRenamingId(null);
    if (!title) return;
    await fetch(`/api/agent/conversations/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    load();
  };

  const shown = filter === "all" ? convos : convos.filter((c) => c.kind === filter);
  const chip = (id: typeof filter, label: string) => (
    <button key={id} onClick={() => setFilter(id)} className="px-3 py-1.5 text-[11px] tracking-wide rounded-[var(--r-md)] border"
      style={{ color: filter === id ? "#05090c" : "var(--text-2)", background: filter === id ? "var(--accent-ai)" : "var(--surface-1)", borderColor: "var(--border)", fontWeight: filter === id ? 700 : 400 }}>
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 flex-wrap">{chip("all", "All")}{chip("chat", "Chat")}{chip("code", "Code")}</div>
      <div className={card}>
        <div className={head}><span className="text-[var(--accent-ai)]">◆</span> CONVERSATIONS <span className="ml-auto text-[var(--muted)] normal-case tracking-normal">{shown.length}</span></div>
        {shown.length === 0 && <div className="p-6 text-center text-[var(--muted)] text-xs">No conversations yet.</div>}
        {shown.map((c) => (
          <div key={c.id} className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-soft)] last:border-0">
            {c.kind === "code" ? <Terminal size={13} className="text-[var(--accent-ai)] shrink-0" /> : <MessageSquare size={13} className="text-[var(--muted)] shrink-0" />}
            {renamingId === c.id ? (
              <input autoFocus className="flex-1 text-sm bg-[var(--surface-2)] border border-[var(--border-loud)] rounded px-2 py-0.5 outline-none"
                value={renameVal} onChange={(e) => setRenameVal(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") doRename(c.id); if (e.key === "Escape") setRenamingId(null); }}
                onBlur={() => doRename(c.id)} />
            ) : (
              <a href={(c.kind === "code" ? "/code" : "/chat") + "?conv=" + encodeURIComponent(c.id)}
                className="flex-1 min-w-0 flex flex-col hover:text-[var(--accent-ai)]">
                <span className="truncate text-sm">{c.title}</span>
                {c.project && <span className="text-[10px] text-[var(--muted)] truncate font-mono">{c.project}</span>}
              </a>
            )}
            <span className="text-[10px] text-[var(--muted)] hidden sm:inline shrink-0">{relTime(c.updatedAt)}</span>
            <a href={(c.kind === "code" ? "/code" : "/chat") + "?conv=" + encodeURIComponent(c.id)} title="Open" className={btn}><ExternalLink size={12} /></a>
            <button className={btn} title="Rename" onClick={() => startRename(c)}><Pencil size={12} /></button>
            <button className={btn} title="Delete" onClick={() => del(c.id)}><Trash2 size={12} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Projects() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fsTick, setFsTick] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = () => fetch("/api/agent/projects").then((r) => r.json()).then((j) => setProjects(j.projects || [])).catch(() => {});
  useEffect(() => { load(); }, []);

  const forget = async (p: string) => {
    if (!confirm("Remove \"" + p + "\" from the library? This does NOT delete any files.")) return;
    await fetch("/api/agent/projects?path=" + encodeURIComponent(p), { method: "DELETE" });
    if (selected === p) { setSelected(null); setOpenFile(null); }
    load();
  };

  // Browse/clone picks aren't registered server-side yet (only /code's chat loop
  // does that on first use) — re-POSTing here registers them immediately, and is a
  // harmless no-op for a "new" pick (already registered by its own create call).
  const onPick = async (p: string) => {
    setPickerOpen(false);
    await fetch("/api/agent/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: p }) }).catch(() => {});
    await load();
    setSelected(p);
    setOpenFile(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className={card}>
        <div className={head}>
          <span className="text-[var(--accent-ai)]">◆</span> PROJECT FOLDERS <span className="text-[var(--muted)] normal-case tracking-normal">{projects.length}</span>
          <button onClick={() => setPickerOpen(true)} className="ml-auto text-[10px] tracking-widest uppercase text-[var(--accent-ai)] border border-[var(--border)] rounded px-2 py-1 hover:border-[var(--border-loud)]">
            + Create / Import
          </button>
        </div>
        {projects.length === 0 && <div className="p-6 text-center text-[var(--muted)] text-xs">No projects yet — create or import one above.</div>}
        {projects.map((p) => (
          <div key={p.path} className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-soft)] last:border-0">
            <FolderOpen size={13} className="text-[var(--muted)] shrink-0" />
            <button onClick={() => { setSelected(p.path); setOpenFile(null); }}
              className="flex-1 min-w-0 truncate text-sm text-left hover:text-[var(--accent-ai)]"
              style={{ color: selected === p.path ? "var(--accent-ai)" : "var(--text)" }}>
              {p.path}
            </button>
            {!p.exists && <span className="text-[10px] text-[var(--accent-danger)] shrink-0">missing</span>}
            <a href={"/code?project=" + encodeURIComponent(p.path)} title="Open in /code" className={btn}><ExternalLink size={12} /></a>
            <button className={btn} title="Forget (doesn't delete files)" onClick={() => forget(p.path)}><Trash2 size={12} /></button>
          </div>
        ))}
      </div>

      {selected && (
        <div className={card + " overflow-hidden"}>
          <div className={head}>
            <span className="text-[var(--accent-ai)]">◆</span> <span className="truncate">{selected}</span>
            <button onClick={() => { setSelected(null); setOpenFile(null); }} className="ml-auto text-[var(--muted)] hover:text-[var(--text)]"><X size={14} /></button>
          </div>
          <div className="flex flex-col md:flex-row" style={{ height: 420 }}>
            <div className="w-full md:w-64 shrink-0 overflow-auto border-b md:border-b-0 md:border-r border-[var(--border-soft)]">
              <FileTree project={selected} refreshTick={fsTick} onOpenFile={setOpenFile} selected={openFile} />
            </div>
            <div className="flex-1 min-w-0 min-h-0">
              {openFile ? (
                <EditorPane project={selected} filePath={openFile} refreshTick={fsTick}
                  rawHref={"/api/agent/file/" + btoa(unescape(encodeURIComponent(selected))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "/" + openFile.split("/").filter(Boolean).map(encodeURIComponent).join("/")}
                  onClose={() => setOpenFile(null)} onSaved={() => setFsTick((t) => t + 1)} />
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-[var(--muted)]">select a file to view/edit it</div>
              )}
            </div>
          </div>
        </div>
      )}

      <DirPicker open={pickerOpen} recents={projects.map((p) => p.path)} onClose={() => setPickerOpen(false)} onPick={onPick} />
    </div>
  );
}

export default function Library() {
  const [tab, setTab] = useState<"models" | "docs" | "chats" | "projects">("models");
  const tabBtn = (id: typeof tab, label: string) => (
    <button onClick={() => setTab(id)} className="px-4 py-2 text-[11px] tracking-widest uppercase rounded-[var(--r-md)] border"
      style={{ color: tab === id ? "#05090c" : "var(--text-2)", background: tab === id ? "var(--accent-ai)" : "var(--surface-1)", borderColor: "var(--border)", fontWeight: tab === id ? 700 : 400 }}>{label}</button>
  );
  return (
    <div className="font-chat min-h-dvh bg-[var(--bg)] text-[var(--text)] p-4 pb-16">
      <div className="max-w-3xl mx-auto flex flex-col gap-4">
        <h1 className="text-[var(--accent-ai)] tracking-widest font-bold">◉ LIBRARY</h1>
        <div className="flex gap-2 flex-wrap">{tabBtn("models", "▤ Models")}{tabBtn("docs", "▦ Documents")}{tabBtn("chats", "▥ Chats")}{tabBtn("projects", "▧ Projects")}</div>
        {tab === "models" ? <Models /> : tab === "docs" ? <Documents /> : tab === "chats" ? <Chats /> : <Projects />}
      </div>
    </div>
  );
}
