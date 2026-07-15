"use client";
import { useEffect, useState } from "react";
import { ExternalLink, FlaskConical, FolderOpen, History, ListTree, MessageSquare, Pencil, Terminal, Trash2, X } from "lucide-react";
import FileTree from "@/components/code/file-tree";
import EditorPane from "@/components/code/editor-pane";
import DirPicker from "@/components/code/dir-picker";
import { Panel } from "@/components/ui/panel";
import { ICON_SIZE } from "@/components/ui/icon";

type M = { name: string; source: "local" | "ollama"; gb: number };
type Doc = { id: string; name: string; folder: string; chars: number; ts: number };
type DataFile = { name: string; chars: number; kind: "raw" | "sft"; rows?: number | null; sha256?: string };
type ConvoRow = { id: string; title: string; updatedAt: number; kind: "chat" | "code"; project?: string };
type ProjectRow = { path: string; exists: boolean };
type RunRow = { id: string; kind: "chat" | "code" | "deliberate"; conversationId: string; project?: string; model: string; mode?: string; status: string; truncated?: boolean; startedAt: number; updatedAt: number };
type RunTrace = { reasoning: string; output: string; events: { seq: number; ts: number; k: string; detail: string }[] };
type Diagnosis = {
  verdict: "clean" | "flawed" | "failed";
  findings: { code: string; count: number; detail: string }[];
  stats: { durationSec: number; rounds: number; toolCalls: number; toolFailures: number; textChars: number; thinkChars: number; nudges: number; maxGapSec: number; tokPerSec: number | null; avgConf: number | null; minConf: number | null };
};
type ModelReportRow = { model: string; runs: number; clean: number; flawed: number; failed: number; toolCalls: number; toolFailures: number; avgTokPerSec: number | null; avgConf: number | null; topFailures: { code: string; count: number }[] };
const verdictColor = (v: string) => v === "clean" ? "var(--accent-success)" : v === "flawed" ? "var(--accent-warn,#d29922)" : "var(--accent-danger)";
type ExperimentRow = {
  name: string; status: string; updatedAt: number; base: string; mode: string; steps: number; lr: number;
  dataset: { name: string; sha256: string; bytes: number; rows: number | null } | null; model?: string | null;
};

const DATASETS = "__datasets";

const head = "px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase text-[var(--text-2)] flex items-center gap-2";
const btn = "text-[11px] tracking-wide border border-[var(--border)] text-[var(--text-2)] rounded-[var(--r-md)] px-2.5 py-1 hover:border-[var(--border-loud)] hover:text-[var(--text)]";

function Models() {
  const [detail, setDetail] = useState<M[]>([]);
  const [current, setCurrent] = useState("");
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const load = () => fetch("/api/agent/models").then((r) => r.json()).then((j) => {
    setDetail(j.modelInfos || j.detail || []);
    setCurrent(j.current || "");
  });
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
      <Panel padding="none">
        <div className={head}><span className="text-[var(--accent-ai)]">◆</span> YOUR TRAINED MODELS</div>
        {trained.length ? trained.map((m) => <Row key={m.name} m={m} />) : <div className="p-6 text-center text-[var(--muted)] text-xs">No trained models yet — make one in Train.</div>}
      </Panel>
      <Panel padding="none">
        <div className={head}><span className="text-[var(--accent-ai)]">◆</span> INSTALLED <span className="ml-auto text-[var(--muted)] normal-case tracking-normal">reused, no re-download</span></div>
        {installed.map((m) => <Row key={m.name} m={m} />)}
      </Panel>
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

      <Panel padding="none">
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
              <span className="text-[10px] text-[var(--muted)] hidden sm:inline">{f.rows != null ? f.rows + " rows · " : ""}{f.chars >= 1000 ? (f.chars / 1000).toFixed(0) + "k" : f.chars} chars</span>
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
      </Panel>
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
      <Panel padding="none">
        <div className={head}><span className="text-[var(--accent-ai)]">◆</span> CONVERSATIONS <span className="ml-auto text-[var(--muted)] normal-case tracking-normal">{shown.length}</span></div>
        {shown.length === 0 && <div className="p-6 text-center text-[var(--muted)] text-xs">No conversations yet.</div>}
        {shown.map((c) => (
          <div key={c.id} className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-soft)] last:border-0">
            {c.kind === "code" ? <Terminal size={ICON_SIZE.sm} className="text-[var(--accent-ai)] shrink-0" /> : <MessageSquare size={ICON_SIZE.sm} className="text-[var(--muted)] shrink-0" />}
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
            <a href={(c.kind === "code" ? "/code" : "/chat") + "?conv=" + encodeURIComponent(c.id)} title="Open" className={btn}><ExternalLink size={ICON_SIZE.sm} /></a>
            <button className={btn} title="Rename" onClick={() => startRename(c)}><Pencil size={ICON_SIZE.sm} /></button>
            <button className={btn} title="Delete" onClick={() => del(c.id)}><Trash2 size={ICON_SIZE.sm} /></button>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function Runs() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<RunRow | null>(null);
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [report, setReport] = useState<ModelReportRow[]>([]);
  const load = () => {
    fetch("/api/agent/runs?limit=100").then((r) => r.json()).then(setRuns).catch(() => setStatus("Couldn't load run history."));
    fetch("/api/agent/runs/report").then((r) => r.json()).then(setReport).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  const remove = async (run: RunRow) => {
    if (!confirm(`Delete the ${run.kind} run record? Its conversation and workspace files will remain.`)) return;
    const r = await fetch(`/api/agent/runs/${encodeURIComponent(run.id)}`, { method: "DELETE" }).then((x) => x.json()).catch(() => ({ error: "request failed" }));
    setStatus(r.ok ? "Run record deleted." : r.error || "Couldn't delete run.");
    if (r.ok) {
      if (selected?.id === run.id) { setSelected(null); setTrace(null); }
      load();
    }
  };
  const inspect = async (run: RunRow) => {
    setSelected(run); setTrace(null); setDiag(null);
    const j = await fetch(`/api/agent/runs/${encodeURIComponent(run.id)}?trace=1`).then((r) => r.json()).catch(() => ({ error: "request failed" }));
    if (j.error) setStatus(j.error);
    else { setTrace(j.trace || { reasoning: "", output: "", events: [] }); setDiag(j.diagnosis || null); }
  };
  const href = (run: RunRow) => run.kind === "chat" ? `/chat?conv=${encodeURIComponent(run.conversationId)}` : `/code?conv=${encodeURIComponent(run.conversationId)}`;
  const removeAll = async () => {
    if (!confirm(`Delete ALL ${runs.length} run records? Conversations and workspace files remain; live runs are skipped.`)) return;
    const r = await fetch("/api/agent/runs", { method: "DELETE" }).then((x) => x.json()).catch(() => null);
    if (!r) { setStatus("Couldn't delete runs."); return; }
    setStatus(`Deleted ${r.deleted} run record${r.deleted === 1 ? "" : "s"}.` + (r.skippedLive ? ` ${r.skippedLive} still running — stop them first.` : ""));
    setSelected(null); setTrace(null);
    load();
  };
  return (
    <div className="flex flex-col gap-3">
      {report.length > 0 && (
        <Panel padding="none" className="overflow-x-auto">
          <div className={head}><FlaskConical size={ICON_SIZE.sm} className="text-[var(--accent-ai)]" /> MODEL REPORT CARD <span className="ml-auto text-[var(--muted)] normal-case tracking-normal">from every stored run — measure what works</span></div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
                <th className="text-left px-4 py-2 font-normal">model</th>
                <th className="text-right px-2 py-2 font-normal">runs</th>
                <th className="text-right px-2 py-2 font-normal" title="no findings">clean</th>
                <th className="text-right px-2 py-2 font-normal" title="finished but with defects">flawed</th>
                <th className="text-right px-2 py-2 font-normal" title="no output / error / stuck loop">failed</th>
                <th className="text-right px-2 py-2 font-normal" title="failed tool calls / total">tool fails</th>
                <th className="text-right px-2 py-2 font-normal">tok/s</th>
                <th className="text-right px-2 py-2 font-normal" title="avg token confidence where captured">conf</th>
                <th className="text-left px-4 py-2 font-normal">top failure modes</th>
              </tr>
            </thead>
            <tbody>
              {report.map((m) => (
                <tr key={m.model} className="border-t border-[var(--border-soft)]">
                  <td className="px-4 py-2 font-mono truncate max-w-[160px]">{m.model}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{m.runs}</td>
                  <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--accent-success)" }}>{m.clean}</td>
                  <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--accent-warn,#d29922)" }}>{m.flawed}</td>
                  <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--accent-danger)" }}>{m.failed}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--muted)]">{m.toolFailures}/{m.toolCalls}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--muted)]">{m.avgTokPerSec ?? "—"}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--muted)]">{m.avgConf != null ? Math.round(m.avgConf * 100) + "%" : "—"}</td>
                  <td className="px-4 py-2 text-[var(--muted)] truncate max-w-[220px]">{m.topFailures.map((f) => `${f.code}×${f.count}`).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <Panel padding="none">
        <div className={head}>
          <History size={ICON_SIZE.sm} className="text-[var(--accent-ai)]" /> AGENT RUNS
          <span className="ml-auto text-[var(--muted)] normal-case tracking-normal">{runs.length}</span>
          {runs.length > 0 && <button onClick={removeAll} title="Delete every run record" className={btn + " normal-case tracking-normal"}>Delete all</button>}
        </div>
        {status && <div className="px-4 py-2 text-[10px] text-[var(--muted)] border-b border-[var(--border-soft)]">{status}</div>}
        {!runs.length && <div className="p-6 text-center text-[var(--muted)] text-xs">No agent or chat runs yet.</div>}
        {runs.map((run) => (
          <div key={run.id} className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-soft)] last:border-0">
            <Terminal size={ICON_SIZE.sm} className="text-[var(--accent-ai)] shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-sm"><span className="truncate">{run.kind}{run.mode ? " · " + run.mode : ""}</span><span className="text-[10px] uppercase tracking-wide text-[var(--muted)] shrink-0">{run.status}</span></div>
              <div className="text-[10px] text-[var(--muted)] truncate">{run.model}{run.project ? " · " + run.project : ""}{run.truncated ? " · truncated" : ""}</div>
            </div>
            <span className="text-[10px] text-[var(--muted)] hidden sm:inline shrink-0">{relTime(run.updatedAt)}</span>
            <a href={href(run)} title="Open conversation" className={btn}><ExternalLink size={12} /></a>
            <button onClick={() => inspect(run)} title="Inspect run trace" className={btn}><ListTree size={12} /></button>
            <button onClick={() => remove(run)} title="Delete run record" className={btn}><Trash2 size={ICON_SIZE.sm} /></button>
          </div>
        ))}
      </Panel>
      {selected && (
        <Panel padding="none" className="overflow-hidden">
          <div className={head}>
            <ListTree size={ICON_SIZE.sm} className="text-[var(--accent-ai)]" /> RUN TRACE <span className="normal-case tracking-normal text-[var(--muted)] truncate">{selected.id}</span>
            {diag && <span className="text-[10px] px-2 py-0.5 rounded-full border normal-case tracking-normal" style={{ color: verdictColor(diag.verdict), borderColor: verdictColor(diag.verdict) }}>{diag.verdict}</span>}
            <button onClick={() => { setSelected(null); setTrace(null); setDiag(null); }} className="ml-auto text-[var(--muted)] hover:text-[var(--text)]" title="Close trace"><X size={ICON_SIZE.sm} /></button>
          </div>
          {!trace && <div className="p-4 text-xs text-[var(--muted)]">Loading trace...</div>}
          {trace && <div className="divide-y divide-[var(--border-soft)]">
            {diag && (
              <section className="p-4">
                <h2 className="text-[10px] tracking-widest uppercase text-[var(--accent-ai)] mb-2">Diagnosis</h2>
                <div className="text-[11px] text-[var(--muted)] mb-2 flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                  <span>{diag.stats.durationSec}s</span>
                  <span>{diag.stats.rounds} rounds</span>
                  <span>{diag.stats.toolFailures}/{diag.stats.toolCalls} tool calls failed</span>
                  {diag.stats.nudges > 0 && <span>{diag.stats.nudges} nudges</span>}
                  {diag.stats.maxGapSec > 10 && <span>{diag.stats.maxGapSec}s longest silence</span>}
                  {diag.stats.tokPerSec != null && <span>{diag.stats.tokPerSec} tok/s</span>}
                  {diag.stats.avgConf != null && <span>certainty {Math.round(diag.stats.avgConf * 100)}% (min {Math.round((diag.stats.minConf ?? 0) * 100)}%)</span>}
                </div>
                {diag.findings.length === 0
                  ? <div className="text-xs" style={{ color: "var(--accent-success)" }}>No defects found.</div>
                  : diag.findings.map((f) => (
                      <div key={f.code} className="text-xs mb-1">
                        <span className="font-mono" style={{ color: verdictColor(diag.verdict) }}>{f.code}{f.count > 1 ? ` ×${f.count}` : ""}</span>
                        <span className="text-[var(--muted)]"> — {f.detail}</span>
                      </div>
                    ))}
              </section>
            )}
            {trace.reasoning && <section className="p-4"><h2 className="text-[10px] tracking-widest uppercase text-[var(--accent-ai)] mb-2">Model-emitted reasoning</h2><pre className="whitespace-pre-wrap break-words text-xs leading-5 text-[var(--text-2)] max-h-72 overflow-auto">{trace.reasoning}</pre></section>}
            {trace.events.length > 0 && <section className="p-4"><h2 className="text-[10px] tracking-widest uppercase text-[var(--accent-ai)] mb-2">Process events</h2><div className="flex flex-col gap-2 max-h-72 overflow-auto">{trace.events.map((event) => <div key={event.seq + event.k} className="text-xs"><span className="text-[var(--accent-ai)] font-mono">{event.k}</span>{event.detail && <pre className="mt-1 whitespace-pre-wrap break-words text-[var(--muted)]">{event.detail}</pre>}</div>)}</div></section>}
            {trace.output && <section className="p-4"><h2 className="text-[10px] tracking-widest uppercase text-[var(--accent-ai)] mb-2">Model output</h2><pre className="whitespace-pre-wrap break-words text-xs leading-5 text-[var(--text)] max-h-72 overflow-auto">{trace.output}</pre></section>}
            {!trace.reasoning && !trace.events.length && !trace.output && <div className="p-4 text-xs text-[var(--muted)]">This run has no retained events.</div>}
          </div>}
        </Panel>
      )}
    </div>
  );
}

function Experiments() {
  const [experiments, setExperiments] = useState<ExperimentRow[]>([]);
  const [status, setStatus] = useState("");
  const load = () => fetch("/api/train?name=").then((r) => r.json()).then((j) => setExperiments(j.experiments || [])).catch(() => setStatus("Couldn't load experiments."));
  useEffect(() => { load(); }, []);
  const remove = async (name: string) => {
    if (!confirm(`Delete experiment "${name}"? This removes its run log and Library record, but keeps derived models and checkpoints.`)) return;
    const r = await fetch(`/api/train?name=${encodeURIComponent(name)}`, { method: "DELETE" }).then((x) => x.json()).catch(() => ({ error: "request failed" }));
    setStatus(r.ok ? "Experiment record deleted." : r.error || "Couldn't delete experiment.");
    if (r.ok) load();
  };
  return (
    <div className="flex flex-col gap-3">
      <Panel padding="none">
        <div className={head}><FlaskConical size={ICON_SIZE.sm} className="text-[var(--accent-ai)]" /> TRAINING EXPERIMENTS <span className="ml-auto text-[var(--muted)] normal-case tracking-normal">{experiments.length}</span></div>
        {status && <div className="px-4 py-2 text-[10px] text-[var(--muted)] border-b border-[var(--border-soft)]">{status}</div>}
        {!experiments.length && <div className="p-6 text-center text-[var(--muted)] text-xs">No training experiments yet.</div>}
        {experiments.map((experiment) => (
          <div key={experiment.name} className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-soft)] last:border-0">
            <FlaskConical size={ICON_SIZE.sm} className="text-[var(--accent-ai)] shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-sm"><span className="truncate">{experiment.name}</span><span className="text-[10px] uppercase tracking-wide text-[var(--muted)] shrink-0">{experiment.status}</span></div>
              <div className="text-[10px] text-[var(--muted)] truncate">{experiment.base} · {experiment.mode} · {experiment.steps} steps · lr {experiment.lr}{experiment.dataset ? ` · ${experiment.dataset.name}${experiment.dataset.rows != null ? ` (${experiment.dataset.rows} rows)` : ""}` : ""}</div>
              {experiment.dataset?.sha256 && <div className="text-[10px] text-[var(--muted)] font-mono truncate">data {experiment.dataset.sha256.slice(0, 12)}</div>}
            </div>
            <a href={`/train?run=${encodeURIComponent(experiment.name)}`} title="Open in Train" className={btn}><ExternalLink size={ICON_SIZE.sm} /></a>
            <button onClick={() => remove(experiment.name)} title="Delete experiment record" className={btn}><Trash2 size={ICON_SIZE.sm} /></button>
          </div>
        ))}
      </Panel>
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
      <Panel padding="none">
        <div className={head}>
          <span className="text-[var(--accent-ai)]">◆</span> PROJECT FOLDERS <span className="text-[var(--muted)] normal-case tracking-normal">{projects.length}</span>
          <button onClick={() => setPickerOpen(true)} className="ml-auto text-[10px] tracking-widest uppercase text-[var(--accent-ai)] border border-[var(--border)] rounded px-2 py-1 hover:border-[var(--border-loud)]">
            + Create / Import
          </button>
        </div>
        {projects.length === 0 && <div className="p-6 text-center text-[var(--muted)] text-xs">No projects yet — create or import one above.</div>}
        {projects.map((p) => (
          <div key={p.path} className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-soft)] last:border-0">
            <FolderOpen size={ICON_SIZE.sm} className="text-[var(--muted)] shrink-0" />
            <button onClick={() => { setSelected(p.path); setOpenFile(null); }}
              className="flex-1 min-w-0 truncate text-sm text-left hover:text-[var(--accent-ai)]"
              style={{ color: selected === p.path ? "var(--accent-ai)" : "var(--text)" }}>
              {p.path}
            </button>
            {!p.exists && <span className="text-[10px] text-[var(--accent-danger)] shrink-0">missing</span>}
            <a href={"/code?project=" + encodeURIComponent(p.path)} title="Open in /code" className={btn}><ExternalLink size={ICON_SIZE.sm} /></a>
            <button className={btn} title="Forget (doesn't delete files)" onClick={() => forget(p.path)}><Trash2 size={ICON_SIZE.sm} /></button>
          </div>
        ))}
      </Panel>

      {selected && (
        <Panel padding="none" className="overflow-hidden">
          <div className={head}>
            <span className="text-[var(--accent-ai)]">◆</span> <span className="truncate">{selected}</span>
            <button onClick={() => { setSelected(null); setOpenFile(null); }} className="ml-auto text-[var(--muted)] hover:text-[var(--text)]"><X size={ICON_SIZE.sm} /></button>
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
        </Panel>
      )}

      <DirPicker open={pickerOpen} recents={projects.map((p) => p.path)} onClose={() => setPickerOpen(false)} onPick={onPick} />
    </div>
  );
}

type PromptRow = { id: string; name: string; scope: string; source: string; prompt: string; inherited: boolean; activation: string };

function Prompts() {
  const [prompts, setPrompts] = useState<PromptRow[]>([]);
  const [selected, setSelected] = useState<PromptRow | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  const load = () => fetch("/api/lal/prompts").then((r) => r.json()).then((j) => {
    const rows = (j.prompts || []) as PromptRow[];
    setPrompts(rows);
    setSelected((current) => rows.find((row) => row.id === current?.id) ?? rows[0] ?? null);
    setDraft((current) => current || rows[0]?.prompt || "");
  }).catch(() => setStatus("Could not load prompt registry."));
  useEffect(() => { load(); }, []);
  const save = async () => {
    if (!selected) return;
    setStatus("saving…");
    const result = await fetch("/api/lal/prompts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: selected.id, prompt: draft }) }).then((r) => r.json()).catch(() => ({ error: "request failed" }));
    setStatus(result.ok ? "Saved. Run lal update on each terminal, then start a new session." : result.error || "Save failed.");
    if (result.ok) load();
  };
  const reset = async () => {
    if (!selected || !confirm("Restore the LAL-managed base prompt? Your saved override will be removed.")) return;
    const result = await fetch(`/api/lal/prompts?id=${encodeURIComponent(selected.id)}`, { method: "DELETE" }).then((r) => r.json()).catch(() => ({ error: "request failed" }));
    setStatus(result.ok ? "Restored the managed base prompt." : result.error || "Restore failed.");
    if (result.ok) load();
  };
  return <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
    <Panel padding="none">
      <div className={head}><Terminal size={ICON_SIZE.sm} className="text-[var(--accent-ai)]" /> PROMPT REGISTRY</div>
      {prompts.map((prompt) => <button key={prompt.id} onClick={() => { setSelected(prompt); setDraft(prompt.prompt); }} className="w-full text-left px-4 py-3 border-b border-[var(--border-soft)] hover:bg-[var(--surface-2)]" style={{ background: selected?.id === prompt.id ? "var(--surface-2)" : undefined }}>
        <div className="text-sm">{prompt.name}</div><div className="mt-1 text-[10px] text-[var(--muted)]">{prompt.inherited ? "managed base" : "owner override"}</div>
      </button>)}
    </Panel>
    <Panel padding="none">
      {selected ? <>
        <div className={head}><span className="text-[var(--accent-ai)]">◆</span> {selected.name.toUpperCase()} <span className="ml-auto normal-case tracking-normal text-[var(--muted)]">{selected.scope}</span></div>
        <div className="px-4 py-2 text-[11px] text-[var(--muted)] border-b border-[var(--border-soft)]">{selected.source}. {selected.activation}</div>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} className="w-full min-h-[420px] p-4 bg-[var(--surface-1)] text-[12px] leading-5 font-mono text-[var(--text)] outline-none resize-y" />
        <div className="flex gap-2 items-center px-4 py-3 border-t border-[var(--border-soft)]"><button className={btn} onClick={save}>Save prompt</button><button className={btn} onClick={reset}>Restore base</button>{status && <span className="text-[11px] text-[var(--muted)]">{status}</span>}</div>
      </> : <div className="p-6 text-xs text-[var(--muted)]">No prompts registered.</div>}
    </Panel>
  </div>;
}

export default function Library() {
  const [tab, setTab] = useState<"models" | "docs" | "chats" | "runs" | "experiments" | "projects" | "prompts">("models");
  const tabBtn = (id: typeof tab, label: string) => (
    <button onClick={() => setTab(id)} className="px-4 py-2 text-[11px] tracking-widest uppercase rounded-[var(--r-md)] border"
      style={{ color: tab === id ? "#05090c" : "var(--text-2)", background: tab === id ? "var(--accent-ai)" : "var(--surface-1)", borderColor: "var(--border)", fontWeight: tab === id ? 700 : 400 }}>{label}</button>
  );
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--text)] px-3 py-4 pb-16">
      <div className="max-w-7xl mx-auto flex flex-col gap-4">
        <div className="flex gap-2 flex-wrap">{tabBtn("models", "▤ Models")}{tabBtn("docs", "▦ Documents")}{tabBtn("chats", "▥ Chats")}{tabBtn("runs", "Runs")}{tabBtn("experiments", "Experiments")}{tabBtn("projects", "▧ Projects")}{tabBtn("prompts", "Prompts")}</div>
        {tab === "models" ? <Models /> : tab === "docs" ? <Documents /> : tab === "chats" ? <Chats /> : tab === "runs" ? <Runs /> : tab === "experiments" ? <Experiments /> : tab === "projects" ? <Projects /> : <Prompts />}
      </div>
    </div>
  );
}
