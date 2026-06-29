"use client";
import { useEffect, useRef, useState } from "react";

type Row = { event: string; step?: number; steps?: number; loss?: number; elapsed?: number; phase?: string; ok?: boolean; model?: string; trainable_params?: number; msg?: string };

const card = "bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)] flex flex-col min-h-0";
const head = "px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase text-[var(--text-2)] flex items-center gap-2";
const inp = "w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--border-loud)]";
const lbl = "block text-[10px] tracking-widest uppercase text-[var(--muted)] mb-1.5";

export default function TrainPage() {
  const [name, setName] = useState("mymodel");
  const [base, setBase] = useState("Qwen/Qwen2.5-0.5B-Instruct");
  const [bases, setBases] = useState<string[]>([]);
  const [steps, setSteps] = useState(150);
  const [lr, setLr] = useState(0.0002);
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [extracting, setExtracting] = useState("");
  const cur = useRef<string | null>(null);
  const cv = useRef<HTMLCanvasElement>(null);

  useEffect(() => { fetch("/api/train?name=").then((r) => r.json()).then((j) => { setBases(j.bases || []); setRunning(j.running); if (j.running) cur.current = j.running; }); }, []);
  useEffect(() => {
    const t = setInterval(async () => {
      if (!cur.current) return;
      const j = await fetch("/api/train?name=" + cur.current).then((r) => r.json()).catch(() => null);
      if (!j) return; setRows(j.rows || []); setRunning(j.running);
      const last = j.rows?.[j.rows.length - 1];
      if (last && (last.event === "done" || last.event === "error")) cur.current = null;
    }, 1500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { drawLoss(); }, [rows]);

  function drawLoss() {
    const c = cv.current; if (!c) return;
    const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr; const x = c.getContext("2d")!; x.scale(dpr, dpr); x.clearRect(0, 0, w, h);
    const L = 38, R = w - 8, T = 8, B = h - 18;
    x.strokeStyle = "#1c4136"; for (let i = 0; i <= 4; i++) { const y = T + (B - T) * i / 4; x.beginPath(); x.moveTo(L, y); x.lineTo(R, y); x.stroke(); }
    const st = rows.filter((r) => r.event === "step" && r.loss != null);
    if (!st.length) { x.fillStyle = "#7fa896"; x.font = "10px monospace"; x.textAlign = "center"; x.fillText("AWAITING TRAINING", (L + R) / 2, (T + B) / 2); return; }
    const ys = st.map((s) => s.loss!), xmax = Math.max(...st.map((s) => s.step!), 1), ymin = Math.min(...ys), ymax = Math.max(...ys);
    const X = (v: number) => L + (R - L) * v / xmax, Y = (v: number) => T + (B - T) * (1 - (v - ymin) / ((ymax - ymin) || 1));
    x.fillStyle = "#90c0ac"; x.font = "9px monospace"; x.textAlign = "right"; x.fillText(ymax.toFixed(2), L - 3, T + 8); x.fillText(ymin.toFixed(2), L - 3, B);
    x.strokeStyle = "#34ffa6"; x.lineWidth = 2; x.beginPath(); st.forEach((s, i) => { const px = X(s.step!), py = Y(s.loss!); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    setExtracting("extracting " + f.name + "…");
    const fd = new FormData(); fd.append("file", f);
    try {
      const j = await fetch("/api/extract", { method: "POST", body: fd }).then((r) => r.json());
      if (j.text) { setText((t) => (t ? t + "\n\n" : "") + j.text); setExtracting(`+${(j.chars / 1000).toFixed(0)}k chars from ${j.name}`); }
      else setExtracting("extract failed: " + (j.error || ""));
    } catch { setExtracting("extract failed"); }
    e.target.value = "";
  }

  async function go() {
    if (!text.trim()) { alert("Add training text (paste, or upload a PDF/txt)."); return; }
    const r = await fetch("/api/train", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, base, steps, lr, text }) }).then((x) => x.json());
    if (r.error) { alert(r.error); return; }
    cur.current = r.name; setRows([]); setRunning(r.name);
  }

  const last = rows[rows.length - 1];
  const phase = last?.event === "done" ? (last.ok ? "✓ done — ready in Chat" : "✗ failed") : last?.event === "error" ? "✗ " + last.msg : last?.phase || (rows.length ? "training" : "idle");

  return (
    <div className="font-chat min-h-dvh bg-[var(--bg)] text-[var(--text)] p-4 pb-16">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-[var(--accent-ai)] tracking-widest font-bold mb-4">◉ TRAINING GROUNDS</h1>
        <div className="grid gap-4 md:grid-cols-2">
          <div className={card}>
            <div className={head}><span className="text-[var(--accent-ai)]">◆</span> NEW MODEL</div>
            <div className="p-4 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className={lbl}>Model name</label><input className={inp} value={name} onChange={(e) => setName(e.target.value)} /></div>
                <div><label className={lbl}>Base</label><select className={inp} value={base} onChange={(e) => setBase(e.target.value)}>{(bases.length ? bases : [base]).map((b) => <option key={b}>{b}</option>)}</select></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={lbl}>Steps</label><input className={inp} type="number" value={steps} onChange={(e) => setSteps(+e.target.value)} /></div>
                <div><label className={lbl}>Learn rate</label><input className={inp} value={lr} onChange={(e) => setLr(+e.target.value)} /></div>
              </div>
              <div className="flex items-center justify-between">
                <label className={lbl + " mb-0"}>Training text</label>
                <label className="text-[10px] tracking-widest uppercase text-[var(--accent-ai)] cursor-pointer border border-[var(--border)] rounded px-2 py-1 hover:border-[var(--border-loud)]">
                  ⬆ Upload PDF / book / txt
                  <input type="file" accept=".pdf,.txt,.md,.text" className="hidden" onChange={onFile} />
                </label>
              </div>
              {extracting && <div className="text-[10px] text-[var(--muted)]">{extracting}</div>}
              <textarea className={inp + " min-h-[180px] resize-none leading-relaxed"} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste text, or upload a PDF/book to convert it…" />
              <button onClick={go} disabled={!!running} className="bg-[var(--accent-ai)] disabled:bg-[var(--border)] disabled:text-[var(--muted)] text-[var(--bg)] rounded-[var(--r-md)] py-2.5 text-sm font-bold tracking-widest uppercase disabled:cursor-not-allowed">{running ? "training " + running + "…" : "⏵ Train on GPU"}</button>
            </div>
          </div>
          <div className={card}>
            <div className={head}><span className="text-[var(--accent-ai)]">◆</span> LIVE PROGRESS <span className="ml-auto text-[var(--muted)] normal-case tracking-normal">{phase}</span></div>
            <div className="p-4 flex flex-col gap-3 min-h-0">
              <div className="h-48"><canvas ref={cv} className="w-full h-full" /></div>
              <div className="text-[10.5px] text-[var(--text-2)] leading-relaxed overflow-auto max-h-48 whitespace-pre-wrap font-mono">
                {rows.length ? rows.slice(-18).map((r, i) => <div key={i}>{r.event === "step" ? `step ${r.step}/${r.steps}  loss ${r.loss}  (${r.elapsed}s)` : r.event === "phase" ? `▸ phase: ${r.phase}` : r.event === "done" ? (r.ok ? `✓ DONE → ${r.model} (in Chat)` : "✗ failed") : r.event === "error" ? "✗ " + r.msg : r.event === "model" ? `LoRA params: ${(r.trainable_params! / 1e6).toFixed(1)}M` : JSON.stringify(r)}</div>) : <div className="text-[var(--muted)]">— no run yet —</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
