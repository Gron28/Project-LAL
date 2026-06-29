"use client";
import { useEffect, useState } from "react";

type Res = { model: string; score: number; total: number; cats: Record<string, { ok: number; total: number }>; tokSec: number | null; results: { cat: string; q: string; ok: boolean; got: string }[] };
const card = "bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)]";
const head = "px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase text-[var(--text-2)] flex items-center gap-2";

export default function Benchmark() {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [running, setRunning] = useState(false);
  const [res, setRes] = useState<Res | null>(null);
  useEffect(() => { fetch("/api/agent/models").then((r) => r.json()).then((j) => { setModels(j.models || []); setModel(j.current || j.models?.[0] || ""); }); }, []);
  const run = async () => {
    setRunning(true); setRes(null);
    try { setRes(await fetch("/api/bench", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) }).then((r) => r.json())); } catch {}
    setRunning(false);
  };
  return (
    <div className="font-chat min-h-dvh bg-[var(--bg)] text-[var(--text)] p-4 pb-16">
      <div className="max-w-2xl mx-auto flex flex-col gap-4">
        <h1 className="text-[var(--accent-ai)] tracking-widest font-bold">◉ BENCHMARK</h1>
        <div className={card + " p-4 flex flex-wrap items-end gap-3"}>
          <div className="flex-1 min-w-[200px]"><label className="block text-[10px] tracking-widest uppercase text-[var(--muted)] mb-1.5">Model</label>
            <select className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] px-3 py-2 text-sm text-[var(--text)]" value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m}>{m}</option>)}</select></div>
          <button onClick={run} disabled={running || !model} className="bg-[var(--accent-ai)] disabled:bg-[var(--border)] disabled:text-[var(--muted)] text-[var(--bg)] rounded-[var(--r-md)] px-5 py-2.5 text-sm font-bold tracking-widest uppercase">{running ? "running…" : "▶ Run"}</button>
        </div>
        {res && !("error" in res) && (
          <div className={card}>
            <div className={head}><span className="text-[var(--accent-ai)]">◆</span> {res.model} <span className="ml-auto text-[var(--accent-ai)]">{res.score}/{res.total} · {res.tokSec} tok/s</span></div>
            <div className="px-4 py-3 flex gap-4 border-b border-[var(--border-soft)] text-xs">
              {Object.entries(res.cats).map(([c, v]) => <span key={c} className="text-[var(--text-2)]"><b className="text-[var(--accent-ai)]">{c}</b> {v.ok}/{v.total}</span>)}
            </div>
            <div className="max-h-[50vh] overflow-auto text-xs">
              {res.results.map((r, i) => (
                <div key={i} className="px-4 py-2 border-b border-[var(--border-soft)] last:border-0 flex gap-2">
                  <span style={{ color: r.ok ? "var(--accent-ai)" : "var(--accent-danger)" }}>{r.ok ? "✓" : "✗"}</span>
                  <span className="flex-1"><span className="text-[var(--text-2)]">{r.q}</span><br /><span className="text-[var(--muted)]">→ {r.got || "(empty)"}</span></span>
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="text-[10px] text-[var(--muted)] leading-relaxed">Auto-graded: <b>math</b> = general capability, <b>lore</b> = a fictional domain the base can&apos;t know. Train a model on the domain (Train) and re-run to see the lore score jump while math holds — that&apos;s the qualify→improve→re-qualify loop.</p>
      </div>
    </div>
  );
}
