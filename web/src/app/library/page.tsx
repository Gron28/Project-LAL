"use client";
import { useEffect, useState } from "react";

type M = { name: string; source: "local" | "ollama"; gb: number };
type Doc = { id: string; name: string; chars: number; ts: number };

const card = "bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)]";
const head = "px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase text-[var(--text-2)] flex items-center gap-2";
const btn = "text-[11px] tracking-wide border border-[var(--border)] text-[var(--text-2)] rounded-[var(--r-md)] px-2.5 py-1 hover:border-[var(--border-loud)] hover:text-[var(--text)]";

function Models() {
  const [detail, setDetail] = useState<M[]>([]);
  const [current, setCurrent] = useState("");
  const load = () => fetch("/api/agent/models").then((r) => r.json()).then((j) => { setDetail(j.detail || []); setCurrent(j.current || ""); });
  useEffect(() => { load(); }, []);
  const setCur = async (n: string) => { await fetch("/api/agent/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: n }) }); load(); };
  const del = async (n: string) => { if (!confirm("Delete " + n + "?")) return; await fetch("/api/agent/models?name=" + encodeURIComponent(n), { method: "DELETE" }); load(); };
  const Row = ({ m }: { m: M }) => (
    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-soft)] last:border-0">
      <span className="flex-1 truncate text-sm" style={{ color: m.name === current ? "var(--accent-ai)" : "var(--text)" }}>{m.name}</span>
      <span className="text-[10px] text-[var(--muted)] w-12 text-right">{m.gb}GB</span>
      {m.name === current ? <span className="text-[10px] px-2 py-1 rounded-full border border-[var(--accent-ai)] text-[var(--accent-ai)]">CURRENT</span> : <button className={btn} onClick={() => setCur(m.name)}>Use</button>}
      {m.source === "local" && <a className={btn} href={"/api/download?model=" + encodeURIComponent(m.name)}>⤓</a>}
      {m.source === "local" && <button className={btn} onClick={() => del(m.name)}>✕</button>}
    </div>
  );
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
  const [status, setStatus] = useState("");
  const load = () => fetch("/api/docs").then((r) => r.json()).then(setDocs);
  useEffect(() => { load(); }, []);
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files; if (!files?.length) return;
    for (const f of Array.from(files)) { setStatus("uploading " + f.name + "…"); const fd = new FormData(); fd.append("file", f);
      try { const j = await fetch("/api/docs", { method: "POST", body: fd }).then((r) => r.json()); setStatus(j.error ? "failed: " + j.error : `added ${f.name}`); } catch { setStatus("failed"); } }
    e.target.value = ""; load();
  }
  const del = async (id: string) => { await fetch("/api/docs?id=" + id, { method: "DELETE" }); load(); };
  return (
    <div className="flex flex-col gap-4">
      <div className={card}>
        <div className={head}><span className="text-[var(--accent-ai)]">◆</span> KNOWLEDGE BASE <span className="ml-auto"><label className="text-[10px] tracking-widest uppercase text-[var(--accent-ai)] cursor-pointer border border-[var(--border)] rounded px-2 py-1 hover:border-[var(--border-loud)]">⬆ Upload<input type="file" multiple accept=".pdf,.txt,.md,.text" className="hidden" onChange={onFile} /></label></span></div>
        {status && <div className="px-4 py-2 text-[10px] text-[var(--muted)] border-b border-[var(--border-soft)]">{status}</div>}
        {docs.length ? docs.map((d) => (
          <div key={d.id} className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-soft)] last:border-0">
            <span className="flex-1 truncate text-sm">{d.name}</span><span className="text-[10px] text-[var(--muted)]">{(d.chars / 1000).toFixed(0)}k</span>
            <button className={btn} onClick={() => del(d.id)}>✕</button>
          </div>
        )) : <div className="p-6 text-center text-[var(--muted)] text-xs">No documents — upload PDFs / books / txt. Then chat with the 📄 Docs toggle on.</div>}
      </div>
    </div>
  );
}

export default function Library() {
  const [tab, setTab] = useState<"models" | "docs" | "projects">("models");
  const tabBtn = (id: typeof tab, label: string) => (
    <button onClick={() => id !== "projects" && setTab(id)} disabled={id === "projects"} className="px-4 py-2 text-[11px] tracking-widest uppercase rounded-[var(--r-md)] border"
      style={{ color: tab === id ? "#05090c" : id === "projects" ? "var(--muted)" : "var(--text-2)", background: tab === id ? "var(--accent-ai)" : "var(--surface-1)", borderColor: "var(--border)", fontWeight: tab === id ? 700 : 400, cursor: id === "projects" ? "not-allowed" : "pointer", opacity: id === "projects" ? 0.5 : 1 }}>{label}</button>
  );
  return (
    <div className="font-chat min-h-dvh bg-[var(--bg)] text-[var(--text)] p-4 pb-16">
      <div className="max-w-3xl mx-auto flex flex-col gap-4">
        <h1 className="text-[var(--accent-ai)] tracking-widest font-bold">◉ LIBRARY</h1>
        <div className="flex gap-2 flex-wrap">{tabBtn("models", "▤ Models")}{tabBtn("docs", "▦ Documents")}{tabBtn("projects", "▧ Projects · soon")}</div>
        {tab === "models" ? <Models /> : <Documents />}
      </div>
    </div>
  );
}
