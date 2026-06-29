"use client";
import { useEffect, useRef, useState } from "react";

type Row = { event: string; step?: number; steps?: number; loss?: number; elapsed?: number; phase?: string; ok?: boolean; model?: string; trainable_params?: number; msg?: string };

export default function TrainPage() {
  const [name, setName] = useState("mymodel");
  const [base, setBase] = useState("Qwen/Qwen2.5-0.5B-Instruct");
  const [bases, setBases] = useState<string[]>([]);
  const [steps, setSteps] = useState(150);
  const [lr, setLr] = useState(0.0002);
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const cur = useRef<string | null>(null);
  const cv = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    fetch("/api/train?name=").then((r) => r.json()).then((j) => { setBases(j.bases || []); setRunning(j.running); if (j.running) cur.current = j.running; });
  }, []);

  useEffect(() => {
    const t = setInterval(async () => {
      if (!cur.current) return;
      const j = await fetch("/api/train?name=" + cur.current).then((r) => r.json()).catch(() => null);
      if (!j) return;
      setRows(j.rows || []); setRunning(j.running);
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

  async function go() {
    if (!text.trim()) { alert("Paste some training text first."); return; }
    const r = await fetch("/api/train", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, base, steps, lr, text }) }).then((x) => x.json());
    if (r.error) { alert(r.error); return; }
    cur.current = r.name; setRows([]); setRunning(r.name);
  }

  const last = rows[rows.length - 1];
  const phase = last?.event === "done" ? (last.ok ? "✓ done — model ready in Chat" : "✗ failed") : last?.event === "error" ? "✗ " + last.msg : last?.phase || (rows.length ? "training" : "idle");
  const C = { panel: "#0b1318", edge: "#26513f", ink: "#eafff4", dim: "#a7d4c1", faint: "#6f9685", green: "#34ffa6", input: "#0a1512" };
  const inp: React.CSSProperties = { width: "100%", background: C.input, border: `1px solid ${C.edge}`, color: C.ink, fontFamily: "monospace", fontSize: 12, padding: 8, borderRadius: 3 };
  const lbl: React.CSSProperties = { fontSize: 9.5, letterSpacing: ".14em", color: C.faint, textTransform: "uppercase", display: "block", marginBottom: 4 };
  const panel: React.CSSProperties = { flex: 1, background: C.panel, border: `1px solid ${C.edge}`, borderRadius: 3, display: "flex", flexDirection: "column", minHeight: 0 };

  return (
    <div style={{ display: "flex", gap: 8, padding: 8, height: "100vh", fontFamily: "monospace", color: C.ink, background: "#05090c" }}>
      <div style={panel}>
        <div style={{ padding: "6px 10px", borderBottom: `1px solid #173228`, fontSize: 10, letterSpacing: ".14em", color: C.dim }}><span style={{ color: C.green }}>◆</span> TRAINING GROUNDS</div>
        <div style={{ flex: 1, padding: 12, display: "flex", flexDirection: "column", gap: 10, overflow: "auto" }}>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}><label style={lbl}>Model name</label><input style={inp} value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div style={{ flex: 1 }}><label style={lbl}>Base</label><select style={inp} value={base} onChange={(e) => setBase(e.target.value)}>{(bases.length ? bases : [base]).map((b) => <option key={b}>{b}</option>)}</select></div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}><label style={lbl}>Steps</label><input style={inp} type="number" value={steps} onChange={(e) => setSteps(+e.target.value)} /></div>
            <div style={{ flex: 1 }}><label style={lbl}>Learn rate</label><input style={inp} value={lr} onChange={(e) => setLr(+e.target.value)} /></div>
          </div>
          <label style={lbl}>Training text (.txt content)</label>
          <textarea style={{ ...inp, flex: 1, minHeight: 160, resize: "none", lineHeight: 1.5 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the text you want the model to learn…" />
          <button onClick={go} disabled={!!running} style={{ background: running ? C.edge : C.green, color: running ? C.faint : "#05090c", border: 0, padding: 11, borderRadius: 3, fontFamily: "monospace", fontWeight: 700, letterSpacing: ".16em", cursor: running ? "not-allowed" : "pointer", textTransform: "uppercase" }}>{running ? "training " + running + "…" : "⏵ Train on GPU"}</button>
        </div>
      </div>
      <div style={panel}>
        <div style={{ padding: "6px 10px", borderBottom: `1px solid #173228`, fontSize: 10, letterSpacing: ".14em", color: C.dim }}><span style={{ color: C.green }}>◆</span> LIVE PROGRESS <span style={{ float: "right", color: C.faint }}>{phase}</span></div>
        <div style={{ flex: 1, padding: 12, display: "flex", flexDirection: "column", gap: 10, overflow: "hidden" }}>
          <div style={{ height: 200 }}><canvas ref={cv} style={{ width: "100%", height: "100%" }} /></div>
          <div style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.6, overflow: "auto", whiteSpace: "pre-wrap" }}>
            {rows.length ? rows.slice(-16).map((r, i) => <div key={i}>{r.event === "step" ? `step ${r.step}/${r.steps}  loss ${r.loss}  (${r.elapsed}s)` : r.event === "phase" ? `▸ phase: ${r.phase}` : r.event === "done" ? (r.ok ? `✓ DONE → ${r.model} (in Chat)` : "✗ failed") : r.event === "error" ? "✗ " + r.msg : r.event === "model" ? `LoRA params: ${(r.trainable_params! / 1e6).toFixed(1)}M` : JSON.stringify(r)}</div>) : <div style={{ color: C.faint }}>— no run yet —</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
