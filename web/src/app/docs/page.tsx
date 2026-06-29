"use client";
import { useEffect, useState } from "react";

type Doc = { id: string; name: string; chars: number; ts: number };
const card = "bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)]";
const head = "px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase text-[var(--text-2)] flex items-center gap-2";

export default function DocsPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [status, setStatus] = useState("");

  const load = () => fetch("/api/docs").then((r) => r.json()).then(setDocs);
  useEffect(() => { load(); }, []);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files; if (!files?.length) return;
    for (const f of Array.from(files)) {
      setStatus("uploading " + f.name + "…");
      const fd = new FormData(); fd.append("file", f);
      try { const j = await fetch("/api/docs", { method: "POST", body: fd }).then((r) => r.json()); setStatus(j.error ? "failed: " + j.error : `added ${f.name} (${(j.chars / 1000).toFixed(0)}k chars)`); }
      catch { setStatus("failed: " + f.name); }
    }
    e.target.value = ""; load();
  }
  const del = async (id: string) => { await fetch("/api/docs?id=" + id, { method: "DELETE" }); load(); };

  return (
    <div className="font-chat min-h-dvh bg-[var(--bg)] text-[var(--text)] p-4 pb-16">
      <div className="max-w-3xl mx-auto flex flex-col gap-4">
        <h1 className="text-[var(--accent-ai)] tracking-widest font-bold">◉ DOCUMENTS</h1>
        <div className={card}>
          <div className={head}><span className="text-[var(--accent-ai)]">◆</span> KNOWLEDGE BASE <span className="ml-auto"><label className="text-[10px] tracking-widest uppercase text-[var(--accent-ai)] cursor-pointer border border-[var(--border)] rounded px-2 py-1 hover:border-[var(--border-loud)]">⬆ Upload PDF / book / txt<input type="file" multiple accept=".pdf,.txt,.md,.text" className="hidden" onChange={onFile} /></label></span></div>
          {status && <div className="px-4 py-2 text-[10px] text-[var(--muted)] border-b border-[var(--border-soft)]">{status}</div>}
          {docs.length ? docs.map((d) => (
            <div key={d.id} className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-soft)] last:border-0">
              <span className="flex-1 truncate text-sm">{d.name}</span>
              <span className="text-[10px] text-[var(--muted)]">{(d.chars / 1000).toFixed(0)}k chars</span>
              <button className="text-[11px] border border-[var(--border)] text-[var(--text-2)] rounded px-2 py-1 hover:border-[var(--border-loud)]" onClick={() => del(d.id)}>✕</button>
            </div>
          )) : <div className="p-6 text-center text-[var(--muted)] text-xs">No documents yet — upload one above.</div>}
        </div>
        <div className={card + " p-4 text-xs text-[var(--text-2)] leading-relaxed"}>
          <div className="text-[var(--accent-ai)] tracking-widest uppercase text-[10px] mb-2">How to use</div>
          In <b>Chat</b>, ask your documents by starting a message with <code className="text-[var(--accent-ai)]">/docs</code> — e.g. <code className="text-[var(--accent-ai)]">/docs what does chapter 3 say about X?</code>. The model answers grounded in the most relevant excerpts and cites them. Use <code className="text-[var(--accent-ai)]">/web</code> for live web search.
        </div>
      </div>
    </div>
  );
}
