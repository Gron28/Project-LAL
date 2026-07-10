"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Stat, LossChart, MetricHistoryChart, SourceLossChart, BlockHeatmap, LengthHistogramChart, ProbePanel, DeltaHeatmap, DeltaSurface3D, ConceptGalaxy3D, type AdapterDelta, type AdapterEvolution, type GalaxySnapshot } from "@/components/charts";
import { SignalTrace } from "@/components/ui/signal-trace";

type Row = {
  event: string; step?: number; steps?: number; loss?: number; best?: number;
  grad_norm?: number; steps_s?: number; sec_per_step?: number; tok_s?: number; eta?: number | null; gpu_mb?: number;
  elapsed?: number; phase?: string; ok?: boolean; model?: string; trainable_params?: number;
  total_params?: number; blocks?: number; msg?: string; device?: string; dtype?: string;
  base?: string; lr?: number; bs?: number; block?: number; ema?: number; reason?: string;
  val_loss?: number; best_val?: number; n?: number; val_blocks?: number;
  suite?: string; score?: number; total?: number; tokSec?: number | null; error?: string;
  data?: string;
  // telemetry redesign additions — all optional (older run logs won't have them)
  epoch?: number; layer_gnorm?: number[]; source?: string; repeat_n?: number;
  patience?: number; best_step?: number; dropped_overlength?: number;
  length_hist?: { edges: number[]; kept: number[]; dropped: number[] };
  prompt?: string; target?: string; generated?: string;
  points?: number[][]; labels?: string[]; categories?: string[];
};
type Sys = { gpu: number | null; vramUsedGb: number | null; vramTotalGb: number | null; vramPct: number | null; gpuTemp: number | null };

// no bg/border/rounded below md — on a phone, boxing every section just eats width
// and adds visual noise; the full "card" chrome only earns its keep once there's
// room for it to read as a distinct panel rather than a cramped frame.
const card = "md:bg-[var(--surface-1)] md:border md:border-[var(--border)] md:rounded-[var(--r-lg)] flex flex-col min-h-0";
const head = "px-1 md:px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase text-[var(--text-2)] flex items-center gap-2";
const inp = "w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--border-loud)]";
const lbl = "block text-[10px] tracking-widest uppercase text-[var(--muted)] mb-1.5";
const panel = "py-1.5 md:p-2.5 md:bg-[var(--surface-2)] md:border md:border-[var(--border)] md:rounded-[var(--r-md)]";
const panelLbl = "text-[10px] uppercase tracking-widest text-[var(--muted)] mb-1";

type DataFile = { name: string; chars: number; kind: "raw" | "sft" };

function DatasetManager({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [files, setFiles] = useState<DataFile[]>([]);
  const [newName, setNewName] = useState("");
  const [newExt, setNewExt] = useState<".txt" | ".jsonl">(".txt");
  const [newContent, setNewContent] = useState("");
  const [msg, setMsg] = useState("");
  const minp = "bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--border-loud)]";

  const load = () => fetch("/api/train/data").then((r) => r.json()).then((j) => setFiles(j.files || [])).catch(() => {});
  useEffect(() => { load(); }, []);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3000); };

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f);
    const r = await fetch("/api/train/data", { method: "POST", body: fd }).then((x) => x.json());
    e.target.value = "";
    if (r.ok) { flash("✓ uploaded " + (r.name || f.name)); load(); onSaved(); }
    else flash("✗ " + (r.error || "upload failed"));
  };

  const create = async () => {
    const name = (newName.trim() || "dataset") + newExt;
    if (!newContent.trim()) { flash("✗ content is empty"); return; }
    const r = await fetch("/api/train/data", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, content: newContent }) }).then((x) => x.json());
    if (r.ok) { flash("✓ saved " + name); setNewName(""); setNewContent(""); load(); onSaved(); }
    else flash("✗ " + (r.error || "save failed"));
  };

  const del = async (name: string) => {
    await fetch("/api/train/data?file=" + encodeURIComponent(name), { method: "DELETE" });
    flash("✓ deleted " + name); load(); onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center overflow-auto p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)] my-4">
        <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border-soft)] sticky top-0 bg-[var(--surface-1)]">
          <span className="text-sm font-semibold">Manage datasets</span>
          <span className="ml-auto text-[10px] text-[var(--accent-ai)]">{msg}</span>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-white text-lg leading-none px-1">×</button>
        </div>
        <div className="p-4 space-y-4">
          {/* existing files */}
          <div className="border border-[var(--border-soft)] rounded-[var(--r-md)] divide-y divide-[var(--border-soft)]">
            {files.length === 0 && <div className="p-4 text-center text-xs text-[var(--muted)]">No datasets yet.</div>}
            {files.map((f) => (
              <div key={f.name} className="flex items-center gap-2 px-3 py-2">
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-widest ${f.kind === "sft" ? "bg-[var(--accent-ai)]/20 text-[var(--accent-ai)]" : "bg-[var(--surface-3)] text-[var(--muted)]"}`}>{f.kind}</span>
                <span className="flex-1 text-sm truncate">{f.name}</span>
                <span className="text-[10px] text-[var(--muted)]">{f.chars >= 1000 ? (f.chars / 1000).toFixed(0) + "k" : f.chars} chars</span>
                <button onClick={() => del(f.name)} className="text-[var(--muted)] hover:text-[var(--accent-danger)] text-sm px-1.5" title="Delete">✕</button>
              </div>
            ))}
          </div>

          {/* upload */}
          <div className="border-t border-[var(--border-soft)] pt-3">
            <div className="text-[10px] uppercase tracking-widest text-[var(--muted)] mb-2">Upload file</div>
            <label className="inline-block text-[11px] tracking-widest uppercase text-[var(--accent-ai)] cursor-pointer border border-[var(--border)] rounded px-3 py-1.5 hover:border-[var(--border-loud)]">
              ⬆ Upload .txt / .jsonl / .pdf
              <input type="file" accept=".txt,.jsonl,.pdf,.md" className="hidden" onChange={upload} />
            </label>
            <p className="text-[10px] text-[var(--muted)] mt-1">PDF is auto-extracted to .txt. .jsonl files become SFT instruction datasets.</p>
          </div>

          {/* create from paste */}
          <div className="border-t border-[var(--border-soft)] pt-3 space-y-2">
            <div className="text-[10px] uppercase tracking-widest text-[var(--muted)]">Create from text</div>
            <div className="flex gap-2">
              <input className={minp + " flex-1"} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="dataset-name (no extension)" />
              <select className={minp} value={newExt} onChange={(e) => setNewExt(e.target.value as ".txt" | ".jsonl")}>
                <option value=".txt">.txt  (raw)</option>
                <option value=".jsonl">.jsonl  (SFT)</option>
              </select>
            </div>
            <textarea className={minp + " w-full resize-y min-h-[100px] font-mono text-[11px]"} value={newContent} onChange={(e) => setNewContent(e.target.value)}
              placeholder={newExt === ".jsonl" ? '{"instruction":"…","output":"…"}\n{"instruction":"…","output":"…"}' : "Paste raw training text here…"} />
            <button onClick={create} disabled={!newContent.trim()} className="text-xs font-semibold bg-[var(--accent-ai)] text-[var(--bg)] rounded px-4 py-1.5 disabled:opacity-40">Save dataset</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtTime(s: number | null | undefined) {
  if (s == null || !isFinite(s)) return "—";
  s = Math.round(s);
  const m = Math.floor(s / 60), sec = s % 60;
  return m ? `${m}m ${sec}s` : `${sec}s`;
}

// Tailwind's md:[grid-template-columns:...] arbitrary-property variant measured as
// still active below the 768px breakpoint on this box (matchMedia itself correctly
// reports false, but the computed grid still showed the auto-fit value) — rather than
// keep chasing that through Tailwind v4's @layer nesting, decide the column count in
// JS, where there's no ambiguity about which rule actually wins.
function useIsWide(breakpoint = 768) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${breakpoint}px)`);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [breakpoint]);
  return wide;
}

export default function TrainPage() {
  const [mode, setMode] = useState<"raw" | "sft" | "hqq">("sft");
  const [name, setName] = useState("sovereign");
  const [base, setBase] = useState("Qwen/Qwen2.5-1.5B-Instruct");
  const [bases, setBases] = useState<string[]>([]);
  const [steps, setSteps] = useState(150);
  const [lr, setLr] = useState(0.0001);
  const [targetLoss, setTargetLoss] = useState(0.1);
  const [noPlateauStop, setNoPlateauStop] = useState(false);
  const [valSplit, setValSplit] = useState(true);        // 10% held-out; best-val adapter is merged
  const [autoBench, setAutoBench] = useState(false);     // run the battery suites right after training
  const [text, setText] = useState("");
  const [dataFile, setDataFile] = useState("sovereign_sft.jsonl");   // selected .jsonl for SFT
  const [dataFiles, setDataFiles] = useState<DataFile[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [runs, setRuns] = useState<{ name: string; status: string; finalLoss: number | null; lastStep: number }[]>([]);
  const [viewName, setViewName] = useState<string | null>(null);
  const [extracting, setExtracting] = useState("");
  const [datasetOpen, setDatasetOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(true);
  // Four sections used to be one long vertical stack — every graph, always
  // rendered, regardless of whether you came here to watch a live run or dig
  // into a past checkpoint's internals. Tabs make each its own focused screen.
  const [viewTab, setViewTab] = useState<"live" | "compare" | "evolution" | "galaxy">("live");
  const [checkpoints, setCheckpoints] = useState<string[]>([]);
  const [compareSel, setCompareSel] = useState<string[]>([]);
  const [compareResults, setCompareResults] = useState<AdapterDelta[] | null>(null);
  const [compareBusy, setCompareBusy] = useState(false);
  const [compareErr, setCompareErr] = useState("");
  const [snapshotEvery, setSnapshotEvery] = useState(0);
  const [evoName, setEvoName] = useState("");
  const [evoModule, setEvoModule] = useState<string>("all");
  const [evoData, setEvoData] = useState<AdapterEvolution | null>(null);
  const [evoBusy, setEvoBusy] = useState(false);
  const [evoErr, setEvoErr] = useState("");
  const [galaxyIdx, setGalaxyIdx] = useState<number | null>(null); // null = follow latest
  const isWide = useIsWide();
  const [sys, setSys] = useState<Sys | null>(null);
  const cur = useRef<string | null>(null);

  const loadCorpus = useCallback(async (file: string) => {
    try {
      const j = await fetch("/api/train/data?file=" + encodeURIComponent(file)).then((r) => r.json());
      if (j.content != null) { setText(j.content); setName(file.replace(/\.txt$/, "")); }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetch("/api/train?name=").then((r) => r.json()).then((j) => {
      setBases(j.bases || []); setRunning(j.running); setRuns(j.runs || []);
      if (j.running) { cur.current = j.running; setViewName(j.running); setConfigOpen(false); }
    });
    fetch("/api/train/data").then((r) => r.json()).then((j) => {
      const files: DataFile[] = j.files || [];
      setDataFiles(files);
      // default SFT dataset = sovereign, else first .jsonl
      const sft = files.find((f) => f.name === "sovereign_sft.jsonl") || files.find((f) => f.kind === "sft");
      if (sft) setDataFile(sft.name);
    }).catch(() => {});
    fetch("/api/compare").then((r) => r.json()).then((j) => setCheckpoints(j.checkpoints || [])).catch(() => {});
  }, [loadCorpus]);
  useEffect(() => {
    const t = setInterval(async () => {
      const meta = await fetch("/api/train?name=").then((r) => r.json()).catch(() => null);
      if (meta) { setRunning(meta.running); setRuns(meta.runs || []); }
      if (cur.current) {
        const j = await fetch("/api/train?name=" + cur.current).then((r) => r.json()).catch(() => null);
        if (j) { setRows(j.rows || []); const last = j.rows?.[j.rows.length - 1]; if (last && (last.event === "done" || last.event === "error")) cur.current = null; }
      }
    }, 1500);
    return () => clearInterval(t);
  }, []);

  // live GPU/VRAM — only poll while a run is active, so you can SEE it's on the GPU.
  // (no setState in the effect body; the panel is gated on isRunningView so stale
  // readings never show after a run ends.)
  useEffect(() => {
    if (!running) return;
    let on = true;
    const tick = () => fetch("/api/sysinfo").then((r) => r.json()).then((j) => on && setSys(j)).catch(() => {});
    tick(); const t = setInterval(tick, 2000);
    return () => { on = false; clearInterval(t); };
  }, [running]);

  const viewRun = async (n: string) => {
    setViewName(n); cur.current = null;
    const j = await fetch("/api/train?name=" + n).then((r) => r.json()).catch(() => null);
    if (j) setRows(j.rows || []);
  };

  const deleteRun = async (n: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Remove record "${n}"?`)) return;
    await fetch("/api/train?name=" + encodeURIComponent(n), { method: "DELETE" }).catch(() => {});
    setRuns((prev) => prev.filter((r) => r.name !== n));
    if (viewName === n) { setViewName(null); setRows([]); }
  };

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
    const patience = noPlateauStop ? 0 : undefined;
    const extras = { valFrac: mode === "sft" && valSplit ? 0.1 : undefined, autoBench: autoBench || undefined, snapshotEvery: mode === "hqq" && snapshotEvery > 0 ? snapshotEvery : undefined };
    const body = mode !== "raw"
      ? { name, base, steps, lr, targetLoss, patience, mode, dataFile, ...extras }
      : { name, base, steps, lr, targetLoss, patience, mode, text, ...extras };
    if (mode !== "raw" && !dataFile) { alert("Pick a .jsonl instruction dataset."); return; }
    if (mode === "raw" && !text.trim()) { alert("Add training text (paste, or upload a PDF/txt)."); return; }
    const r = await fetch("/api/train", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
    if (r.error) { alert(r.error); return; }
    cur.current = r.name; setRows([]); setRunning(r.name); setViewName(r.name);
    setConfigOpen(false);
  }

  async function stopTraining() {
    if (!running) return;
    if (!confirm(`Stop training "${running}"? The partial run is discarded.`)) return;
    await fetch("/api/train", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }) }).catch(() => {});
    setRunning(null); cur.current = null;
  }

  function toggleCompare(name: string) {
    setCompareSel((prev) => prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]);
  }

  async function runCompare() {
    if (compareSel.length < 2) { setCompareErr("pick at least 2 checkpoints"); return; }
    setCompareBusy(true); setCompareErr(""); setCompareResults(null);
    const r = await fetch("/api/compare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ names: compareSel }) }).then((x) => x.json()).catch(() => ({ error: "request failed" }));
    setCompareBusy(false);
    if (r.error) { setCompareErr(r.error); return; }
    setCompareResults(r.results || []);
  }

  async function runEvolution() {
    if (!evoName) { setEvoErr("pick a run"); return; }
    setEvoBusy(true); setEvoErr(""); setEvoData(null);
    const r = await fetch("/api/compare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evolution: evoName }) }).then((x) => x.json()).catch(() => ({ error: "request failed" }));
    setEvoBusy(false);
    if (r.error) { setEvoErr(r.error); return; }
    setEvoData(r.result);
  }

  // ---- derive KPIs from the row stream ----
  const start = rows.find((r) => r.event === "start");
  const modelRow = rows.find((r) => r.event === "model");
  const stepRows = rows.filter((r) => r.event === "step" && r.loss != null);
  const lastStep = stepRows[stepRows.length - 1];
  const prevStep = stepRows[stepRows.length - 2];
  const last = rows[rows.length - 1];
  const done = last?.event === "done";
  const errored = last?.event === "error";
  const isRunningView = running && running === viewName;

  const totalSteps = lastStep?.steps || start?.steps || steps;
  const progress = lastStep ? Math.min(100, Math.round((100 * lastStep.step!) / totalSteps)) : 0;
  const firstLoss = stepRows[0]?.loss;
  const bestLoss = lastStep?.best ?? (stepRows.length ? Math.min(...stepRows.map((s) => s.loss!)) : undefined);
  const improvePct = firstLoss && bestLoss != null ? Math.round((100 * (firstLoss - bestLoss)) / firstLoss) : null;
  const lossTrend = lastStep?.loss != null && prevStep?.loss != null ? lastStep.loss - prevStep.loss : null;
  const onGpu = !!start?.device?.startsWith("cuda");
  const valRows = rows.filter((r) => r.event === "val");
  const lastVal = valRows[valRows.length - 1];
  const lastProbe = rows.filter((r) => r.event === "probe").slice(-1)[0];
  const galaxyMeta = rows.find((r) => r.event === "embed_meta");
  const galaxySnapshots: GalaxySnapshot[] = rows
    .filter((r) => r.event === "embed" && Array.isArray(r.points))
    .map((r) => ({ step: r.step!, points: r.points! }));
  const stepsSinceBest = lastStep ? lastStep.step! - (lastStep.best_step ?? 0) : null;
  // ETA from a single instantaneous sec/step is noisy: every val_every-th step's
  // printed rate includes that step's validation-loop time, spiking sec/step ~3-4x
  // and swinging ETA from ~200min to ~600min and back. Median of the last 9 printed
  // steps shrugs off that periodic outlier without needing a trainer-side fix.
  const recentSecPerStep = stepRows.slice(-9).map((s) => s.sec_per_step).filter((v): v is number => v != null).sort((a, b) => a - b);
  const medianSecPerStep = recentSecPerStep.length ? recentSecPerStep[Math.floor(recentSecPerStep.length / 2)] : null;
  const smoothEta = lastStep && medianSecPerStep ? (totalSteps - lastStep.step!) * medianSecPerStep : lastStep?.eta;
  const generalizationGap = lastVal?.val_loss != null && lastStep?.loss != null ? lastVal.val_loss - lastStep.loss : null;
  const retainedRows = modelRow?.blocks != null && modelRow.dropped_overlength != null
    ? Math.round((100 * modelRow.blocks) / Math.max(1, modelRow.blocks + modelRow.dropped_overlength))
    : null;

  const phase = done ? (last.ok ? "✓ done — ready in Chat" : "✗ failed") : errored ? "✗ " + last.msg : last?.phase || (rows.length ? "training" : "idle");

  // pb-20 clears the fixed mobile bottom tab bar (h-14 + safe-area inset) — pb-10
  // wasn't enough and the raw log / concept galaxy panels were rendering underneath it
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--text)] px-3 py-4 pb-20 md:pb-10">
      <div className="max-w-[1760px] mx-auto">
        <div className="flex items-center gap-1 mb-2 overflow-x-auto pb-0.5">
          {([["live", "Live"], ["compare", "Model deltas"], ["evolution", "Evolution"], ["galaxy", "Concept space"]] as const).map(([id, label]) => (
            <button key={id} onClick={() => setViewTab(id)} className="h-8 px-3 rounded-[var(--r-md)] border text-[10px] whitespace-nowrap"
              style={{ color: viewTab === id ? "var(--bg)" : "var(--text-2)", background: viewTab === id ? "var(--accent-ai)" : "var(--surface-1)", borderColor: viewTab === id ? "var(--accent-ai)" : "var(--border)", fontWeight: viewTab === id ? 700 : 400 }}>
              {label}
            </button>
          ))}
          <Link href="/benchmark" className="ml-auto h-8 px-3 inline-flex items-center rounded-[var(--r-md)] border border-[var(--border)] text-[10px] whitespace-nowrap text-[var(--text-2)] hover:border-[var(--border-loud)] hover:text-[var(--accent-ai)]">Open bench</Link>
        </div>
        <div className="flex flex-col gap-4">
          {/* ---- monitor: one full-width panel; config lives as a dropdown off the header
              instead of a permanent second column, so it never pushes live data off screen ---- */}
          <div className={card + " min-w-0"} style={{ display: viewTab === "live" ? undefined : "none" }}>
            <div className={head + " relative"}>
              <button onClick={() => setConfigOpen((v) => !v)}
                className="flex items-center gap-1 normal-case tracking-normal text-[11px] px-2 py-1 -my-1 rounded-[var(--r-md)] border border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-loud)]">
                ⚙ New model {configOpen ? "▴" : "▾"}
              </button>
              <span className="text-[var(--accent-ai)]">◆</span> {viewName ? viewName.toUpperCase() : "LIVE PROGRESS"}
              {start && (
                <span className="normal-case tracking-normal text-[10px] text-[var(--muted)] truncate max-w-[38%]" title={`${start.base ?? ""}${start.data ? " · " + start.data : ""}`}>
                  {start.base}{start.data ? ` · ${start.data}` : ""}
                </span>
              )}
              <span className="ml-auto flex items-center gap-2">
                {isRunningView && (
                  <button onClick={stopTraining}
                    className="normal-case tracking-normal text-[10px] font-bold uppercase tracking-widest bg-[var(--accent-danger)] text-white rounded-[var(--r-md)] px-3 py-1 hover:opacity-90">
                    ■ Stop
                  </button>
                )}
                {isRunningView && !done && !errored && <SignalTrace size="sm" />}
                <span className="normal-case tracking-normal" style={{ color: done && last.ok ? "var(--accent-success)" : errored || (done && !last.ok) ? "var(--accent-danger)" : "var(--accent-warn)" }}>{phase}</span>
              </span>

              {configOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setConfigOpen(false)} />
                  <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-30 w-[680px] max-w-[92vw] max-h-[90vh] overflow-y-auto bg-[var(--surface-1)] border border-[var(--border-loud)] rounded-[var(--r-lg)] shadow-2xl p-4 flex flex-col gap-3 normal-case tracking-normal">
                    <div className="grid grid-cols-2 gap-3">
                      <div><label className={lbl}>Model name</label><input className={inp} value={name} onChange={(e) => setName(e.target.value)} /></div>
                      <div><label className={lbl}>Base</label><select className={inp} value={base} onChange={(e) => setBase(e.target.value)}>{(bases.length ? bases : [base]).map((b) => <option key={b}>{b}</option>)}</select></div>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div><label className={lbl}>Max steps</label><input className={inp} type="number" value={steps} onChange={(e) => setSteps(+e.target.value)} /></div>
                      <div><label className={lbl}>Learn rate</label><input className={inp} value={lr} onChange={(e) => setLr(+e.target.value)} /></div>
                      <div><label className={lbl} title="Stops early when smoothed loss reaches this — prevents overtraining">Target loss</label><input className={inp} type="number" step="0.01" value={targetLoss} onChange={(e) => setTargetLoss(+e.target.value)} /></div>
                    </div>
                    <div className="flex items-center gap-4 flex-wrap">
                      <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]" title="The 'no improvement in 100 steps' early-stop can trigger too eagerly on noisy losses. Check to run to Max steps / Target loss only.">
                        <input type="checkbox" checked={noPlateauStop} onChange={(e) => setNoPlateauStop(e.target.checked)} />
                        Disable plateau early-stop
                      </label>
                      {mode === "sft" && (
                        <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]" title="Hold out 10% of the data; val loss shows on the chart (amber) and the best-val checkpoint is what gets merged — guards against overfitting.">
                          <input type="checkbox" checked={valSplit} onChange={(e) => setValSplit(e.target.checked)} />
                          10% val split
                        </label>
                      )}
                      <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]" title="After the GGUF is built, run every battery suite on the new model automatically and save the scores.">
                        <input type="checkbox" checked={autoBench} onChange={(e) => setAutoBench(e.target.checked)} />
                        Auto-bench after
                      </label>
                      {mode === "hqq" && (
                        <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]" title="Save a named adapter snapshot every N steps (~180MB each) so Compare Model Deltas can show how the change evolved over the run, not just its final state.">
                          <input type="checkbox" checked={snapshotEvery > 0} onChange={(e) => setSnapshotEvery(e.target.checked ? 300 : 0)} />
                          Snapshot every
                          {snapshotEvery > 0 && (
                            <input type="number" className="w-16 bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[10px]" value={snapshotEvery} onChange={(e) => setSnapshotEvery(+e.target.value)} />
                          )}
                          steps
                        </label>
                      )}
                    </div>
                    {/* training mode */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <label className={lbl + " mb-0"}>Mode</label>
                      <div className="flex rounded-[var(--r-md)] overflow-hidden border border-[var(--border)] text-[11px]">
                        <button onClick={() => setMode("sft")} className="px-3 py-1.5" style={{ background: mode === "sft" ? "var(--accent-ai)" : "transparent", color: mode === "sft" ? "var(--bg)" : "var(--text-2)" }}>Instruction SFT</button>
                        <button onClick={() => setMode("hqq")} className="px-3 py-1.5" style={{ background: mode === "hqq" ? "var(--accent-ai)" : "transparent", color: mode === "hqq" ? "var(--bg)" : "var(--text-2)" }}>HQQ 4-bit (4–8B)</button>
                        <button onClick={() => setMode("raw")} className="px-3 py-1.5" style={{ background: mode === "raw" ? "var(--accent-ai)" : "transparent", color: mode === "raw" ? "var(--bg)" : "var(--text-2)" }}>Raw text</button>
                      </div>
                      <span className="text-[10px] text-[var(--muted)]">{mode === "sft" ? "fp16 LoRA, loss-masked (≤2B)" : mode === "hqq" ? "4-bit LoRA — fits 3–7B on 8GB (slower)" : "next-token on plain text"}</span>
                    </div>
                    {mode === "hqq" && <div className="text-[10px] text-[var(--accent-warn)] -mt-1">HQQ 4-bit: pick a bigger Base (Qwen 3B/7B). Slower per step; merges to GGUF when done. 7B may be RAM-tight to load.</div>}

                    {datasetOpen && <DatasetManager onClose={() => setDatasetOpen(false)} onSaved={() => fetch("/api/train/data").then((r) => r.json()).then((j) => { const files = j.files || []; setDataFiles(files); })} />}
                    {mode !== "raw" ? (
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label className={lbl + " mb-0"}>Instruction dataset (.jsonl)</label>
                          <button onClick={() => setDatasetOpen(true)} className="text-[10px] tracking-widest uppercase text-[var(--accent-ai)] border border-[var(--border)] rounded px-2 py-0.5 hover:border-[var(--border-loud)]">⚙ Manage</button>
                        </div>
                        <select className={inp} value={dataFile} onChange={(e) => { setDataFile(e.target.value); setName(e.target.value.replace(/\.jsonl$/, "")); }}>
                          {dataFiles.filter((f) => f.kind === "sft").length === 0 && <option value="">(no .jsonl datasets in data/)</option>}
                          {dataFiles.filter((f) => f.kind === "sft").map((f) => <option key={f.name} value={f.name}>{f.name} ({(f.chars / 1000).toFixed(0)}k)</option>)}
                        </select>
                        <p className="text-[10px] text-[var(--muted)] mt-1 leading-snug">Trains on instruction → answer with the loss masked to the answer only (the method that worked). Keys: instruction / thought_process / output.</p>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <label className={lbl + " mb-0"}>Training text</label>
                          <div className="flex items-center gap-2">
                            {dataFiles.filter((f) => f.kind === "raw").length > 0 && (
                              <select
                                value={name + ".txt"}
                                onChange={(e) => loadCorpus(e.target.value)}
                                className="text-[10px] bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-1 text-[var(--text-2)] outline-none"
                                title="Load an existing corpus from data/"
                              >
                                {!dataFiles.some((f) => f.name === name + ".txt") && <option value={name + ".txt"}>{name}</option>}
                                {dataFiles.filter((f) => f.kind === "raw").map((f) => <option key={f.name} value={f.name}>{f.name.replace(/\.txt$/, "")} ({(f.chars / 1000).toFixed(0)}k)</option>)}
                              </select>
                            )}
                            <button onClick={() => setDatasetOpen(true)} className="text-[10px] tracking-widest uppercase text-[var(--accent-ai)] border border-[var(--border)] rounded px-2 py-1 hover:border-[var(--border-loud)]">⚙ Manage</button>
                            <label className="text-[10px] tracking-widest uppercase text-[var(--accent-ai)] cursor-pointer border border-[var(--border)] rounded px-2 py-1 hover:border-[var(--border-loud)]">
                              ⬆ Upload
                              <input type="file" accept=".pdf,.txt,.md,.text" className="hidden" onChange={onFile} />
                            </label>
                          </div>
                        </div>
                        {extracting && <div className="text-[10px] text-[var(--muted)]">{extracting}</div>}
                        <textarea className={inp + " min-h-[140px] resize-none leading-relaxed"} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste text, or upload a PDF/book to convert it…" />
                      </>
                    )}
                    {running ? (
                      <div className="flex gap-2">
                        <div className="flex-1 bg-[var(--border)] text-[var(--muted)] rounded-[var(--r-md)] py-2.5 text-sm font-bold tracking-widest uppercase text-center">training {running}…</div>
                        <button onClick={stopTraining} className="bg-[var(--accent-danger)] text-white rounded-[var(--r-md)] px-4 py-2.5 text-sm font-bold tracking-widest uppercase hover:opacity-90">■ Stop</button>
                      </div>
                    ) : (
                      <button onClick={go} className="bg-[var(--accent-ai)] text-[var(--bg)] rounded-[var(--r-md)] py-2.5 text-sm font-bold tracking-widest uppercase">⏵ Train on GPU</button>
                    )}
                    {text && <div className="text-[10px] text-[var(--muted)]">{(text.length / 1000).toFixed(1)}k chars · ~{Math.round(text.length / 4 / 1000)}k tokens</div>}
                  </div>
                </>
              )}
            </div>

            {/* min-w-0 matters here: this content (the auto-fit chart grid below) is
                wider than its 1fr track's available space, and grid items default to
                min-width:auto (content-sized) — without this the track overflows the
                viewport instead of shrinking, which is exactly what happened before this fix */}
            <div className="p-1.5 md:p-4 flex flex-col gap-3 min-h-0 min-w-0">
              {runs.length > 0 && (
                <div className="flex gap-1.5 overflow-x-auto pb-0.5" style={{ scrollbarWidth: "thin" }}>
                  {runs.map((r) => (
                    <span key={r.name} className="inline-flex items-center rounded-[var(--r-md)] border overflow-hidden shrink-0"
                      style={{ borderColor: "var(--border)", background: viewName === r.name ? "var(--surface-3)" : "var(--surface-1)" }}>
                      <button onClick={() => viewRun(r.name)} title={`${r.status}${r.finalLoss != null ? " · final loss " + r.finalLoss : ""}`}
                        className="text-[10px] px-2 py-1 whitespace-nowrap"
                        style={{ color: r.status === "running" ? "var(--accent-warn)" : r.status === "failed" ? "var(--accent-danger)" : viewName === r.name ? "var(--accent-ai)" : "var(--text-2)" }}>
                        {r.status === "running" ? "● " : r.status === "failed" ? "✗ " : "✓ "}{r.name}
                      </button>
                      {r.status !== "running" && (
                        <button onClick={(e) => deleteRun(r.name, e)} title="Remove record"
                          className="text-[10px] px-1.5 py-1 text-[var(--muted)] hover:text-[var(--accent-danger)] border-l border-[var(--border)]">×</button>
                      )}
                    </span>
                  ))}
                </div>
              )}

              {/* device + progress bar */}
              {start && (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="px-2 py-0.5 rounded-full font-bold tracking-widest uppercase text-[9px]" style={{ background: onGpu ? "var(--accent-success)" : "var(--accent-danger)", color: "var(--bg)" }}>
                    {onGpu ? "GPU" : "CPU"}{start.dtype ? " · " + start.dtype : ""}
                  </span>
                  {lastStep && <span className="text-[var(--text-2)]">step {lastStep.step}/{totalSteps}</span>}
                  {isRunningView && sys && (
                    <span className="text-[var(--muted)]">gpu {sys.gpu ?? "—"}%{sys.gpuTemp ? ` · ${sys.gpuTemp}°C` : ""} · vram {sys.vramTotalGb ? `${sys.vramUsedGb}/${sys.vramTotalGb}GB` : "—"}</span>
                  )}
                  <span className="ml-auto text-[var(--muted)]">{progress}%</span>
                </div>
              )}
              <div className="h-2 rounded-full bg-[var(--surface-3)] overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: progress + "%", background: onGpu ? "var(--accent-success)" : "var(--accent-danger)" }} />
              </div>

              {/* KPI strip — compact chips, wrap freely instead of a fixed 3-col grid */}
              <div className="flex flex-wrap gap-2">
                <Stat label="Loss" value={lastStep?.loss != null ? lastStep.loss.toFixed(3) : "—"}
                  color={lossTrend == null ? undefined : lossTrend < 0 ? "var(--accent-ai)" : "var(--accent-warn)"}
                  sub={lossTrend == null ? undefined : (lossTrend < 0 ? "▼ " : "▲ ") + Math.abs(lossTrend).toFixed(3)} />
                <Stat label="Best loss" value={bestLoss != null ? bestLoss.toFixed(3) : "—"} color="var(--accent-ai)" />
                {lastVal && <Stat label="Val loss" value={lastVal.val_loss != null ? lastVal.val_loss.toFixed(3) : "—"} color="var(--accent-warn)" sub={lastVal.best_val != null ? `best ${lastVal.best_val.toFixed(3)}` : undefined} />}
                <Stat label="Improved" value={improvePct != null ? improvePct + "%" : "—"} sub={firstLoss ? `from ${firstLoss.toFixed(2)}` : undefined} />
                <Stat label="Throughput" value={lastStep?.tok_s ? lastStep.tok_s.toLocaleString() + " tok/s" : lastStep?.steps_s ? lastStep.steps_s.toFixed(2) + " steps/s" : "—"} />
                <Stat label="ETA" value={isRunningView ? fmtTime(smoothEta) : done ? "done" : "—"} sub={"elapsed " + fmtTime(lastStep?.elapsed)} />
                <Stat label="Grad norm" value={lastStep?.grad_norm != null ? lastStep.grad_norm.toFixed(2) : "—"}
                  color={lastStep?.grad_norm != null && lastStep.grad_norm > 5 ? "var(--accent-warn)" : undefined}
                  sub={lastStep?.grad_norm != null && lastStep.grad_norm > 5 ? "high — unstable" : "stable"} />
                {modelRow?.dropped_overlength != null && (
                  <Stat label="Dropped" value={String(modelRow.dropped_overlength)}
                    color={modelRow.dropped_overlength > 0 ? "var(--accent-warn)" : undefined}
                    sub={modelRow.blocks ? `of ${modelRow.blocks + modelRow.dropped_overlength} rows` : undefined} />
                )}
                {lastStep && start?.patience != null && (
                  <Stat label="Plateau" value={`${stepsSinceBest}/${start.patience}`}
                    color={(stepsSinceBest ?? 0) / start.patience > 0.7 ? "var(--accent-warn)" : undefined}
                    sub="steps since best" />
                )}
              </div>

              {/* charts — auto-fit tracks sized off the ACTUAL column width (this lives
                  inside a narrower content column, not the viewport, so xl:/md: breakpoints
                  would size against the wrong box and overflow off-screen); every panel gets
                  a bordered/surfaced frame so an empty one reads as "an empty gauge", not a hole */}
              {/* single column below md: auto-fit/minmax degenerates into a 0px track on
                  narrow phones (measured: "230px 0px 103.5px") rather than just stacking */}
              <div className="grid gap-3 mt-1" style={{ gridTemplateColumns: isWide ? "repeat(12, minmax(0, 1fr))" : "1fr" }}>
                <div className="xl:col-span-12 flex items-end justify-between gap-3 pt-1">
                  <div><div className="text-[9px] uppercase tracking-[0.18em] text-[var(--accent-ai)]">Learning signal</div><div className="text-sm font-semibold mt-1">Is the model learning cleanly?</div></div>
                  <div className="text-[9px] text-[var(--muted)]">train / validation loss · stability · convergence</div>
                </div>
                <div className={panel + " xl:col-span-8"}>
                  <div className="flex items-center justify-between mb-1"><div className={panelLbl + " mb-0"}>Loss trajectory</div><div className="text-[9px] text-[var(--muted)]">raw · EMA · held-out validation</div></div>
                  <div className="h-56"><LossChart rows={rows} /></div>
                </div>
                <div className={panel + " xl:col-span-4"}>
                  <div className={panelLbl}>Run diagnosis</div>
                  <div className="grid grid-cols-2 gap-px bg-[var(--border-soft)] border border-[var(--border-soft)] rounded-[var(--r-md)] overflow-hidden mt-2">
                    <Diagnostic label="Convergence" value={improvePct != null ? `${improvePct}%` : "—"} note={bestLoss != null ? `best ${bestLoss.toFixed(3)}` : "awaiting signal"} tone={improvePct != null && improvePct > 0 ? "good" : "neutral"} />
                    <Diagnostic label="Generalization gap" value={generalizationGap != null ? `${generalizationGap >= 0 ? "+" : ""}${generalizationGap.toFixed(3)}` : "—"} note={generalizationGap == null ? "needs validation" : Math.abs(generalizationGap) < 0.2 ? "train and val aligned" : "watch for overfit"} tone={generalizationGap != null && Math.abs(generalizationGap) >= 0.2 ? "warn" : generalizationGap != null ? "good" : "neutral"} />
                    <Diagnostic label="Data retained" value={retainedRows != null ? `${retainedRows}%` : "—"} note={modelRow?.dropped_overlength != null ? `${modelRow.dropped_overlength} overlength rows` : "awaiting dataset scan"} tone={retainedRows != null && retainedRows < 95 ? "warn" : retainedRows != null ? "good" : "neutral"} />
                    <Diagnostic label="Plateau budget" value={start?.patience ? `${stepsSinceBest ?? 0}/${start.patience}` : "off"} note={start?.patience ? "steps since best" : "no patience stop"} tone={start?.patience && (stepsSinceBest ?? 0) / start.patience > 0.7 ? "warn" : "neutral"} />
                  </div>
                  <div className="mt-3 text-[10px] leading-relaxed text-[var(--muted)]">{generalizationGap != null && generalizationGap > 0.25 ? "Validation is separating from training loss. The adapter may be starting to overfit this mix." : lastStep?.grad_norm != null && lastStep.grad_norm > 5 ? "Gradient norm is elevated. Watch for spikes or a rising loss curve before trusting the checkpoint." : stepRows.length ? "No major instability is visible in the latest telemetry." : "Diagnostics populate from the run event stream."}</div>
                </div>
                <div className={panel + " xl:col-span-6"}>
                  <div className={panelLbl}>Gradient norm</div>
                  <div className="h-40"><MetricHistoryChart rows={rows} field="grad_norm" color="#ffb454" threshold={5} /></div>
                </div>
                <div className={panel + " xl:col-span-6"}>
                  <div className={panelLbl}>Throughput (steps/s)</div>
                  <div className="h-40"><MetricHistoryChart rows={rows} field="steps_s" color="#7c9cff" fmt={(v) => v.toFixed(2)} /></div>
                </div>

                <div className="xl:col-span-12 flex items-end justify-between gap-3 pt-3 border-t border-[var(--border-soft)]">
                  <div><div className="text-[9px] uppercase tracking-[0.18em] text-[var(--accent-ai)]">Data health</div><div className="text-sm font-semibold mt-1">What is shaping the gradient?</div></div>
                  <div className="text-[9px] text-[var(--muted)]">source balance · sequence length · layer activity</div>
                </div>
                <div className={panel + " xl:col-span-8"}>
                  <div className={panelLbl}>Loss by data source</div>
                  <div className="h-40"><SourceLossChart rows={rows} /></div>
                </div>
                <div className={panel + " xl:col-span-4"}>
                  <div className={panelLbl}>Sequence length distribution</div>
                  <div className="h-40"><LengthHistogramChart hist={modelRow?.length_hist} /></div>
                  <div className="text-[9px] text-[var(--muted)] mt-1 flex gap-3">
                    <span><span className="inline-block w-2 h-2 rounded-sm mr-1 align-middle" style={{ background: "#34ffa6" }} />kept</span>
                    <span><span className="inline-block w-2 h-2 rounded-sm mr-1 align-middle" style={{ background: "#e2726b" }} />dropped</span>
                  </div>
                </div>
                <div className={panel + " xl:col-span-12"}>
                  <div className="flex items-center justify-between mb-1">
                    <div className={panelLbl + " mb-0"}>Per-block gradient heatmap</div>
                    <div className="text-[9px] text-[var(--muted)]">block × step, brighter = larger gradient</div>
                  </div>
                  <div className="h-40"><BlockHeatmap rows={rows} /></div>
                </div>

                <div className="xl:col-span-12 flex items-end justify-between gap-3 pt-3 border-t border-[var(--border-soft)]">
                  <div><div className="text-[9px] uppercase tracking-[0.18em] text-[var(--accent-ai)]">Output evidence</div><div className="text-sm font-semibold mt-1">Is behavior moving toward the target?</div></div>
                  <div className="text-[9px] text-[var(--muted)]">latest held-out generation, shown in full</div>
                </div>
                <div className={panel + " xl:col-span-12"}>
                  <div className={panelLbl}>Live sample vs. target</div>
                  <div className="min-h-32 max-h-64 overflow-auto"><ProbePanel row={lastProbe} /></div>
                </div>
              </div>

              {modelRow && (
                <div className="text-[10px] text-[var(--muted)] flex flex-wrap gap-x-3">
                  <span>LoRA params: <b className="text-[var(--text-2)]">{((modelRow.trainable_params ?? 0) / 1e6).toFixed(1)}M</b>{modelRow.total_params ? ` / ${(modelRow.total_params / 1e6).toFixed(0)}M total` : ""}</span>
                  {modelRow.blocks != null && <span>{modelRow.blocks} text blocks</span>}
                  {start?.lr && <span>lr {start.lr}</span>}
                  {(modelRow?.block ?? start?.block) && <span>block {modelRow?.block ?? start?.block}</span>}
                  {modelRow?.bs && <span>bs {modelRow.bs}</span>}
                </div>
              )}

              {/* log tail — always visible, not collapsed; compact height keeps it from
                  pushing the charts off screen */}
              <div className={panel}>
                <div className={panelLbl}>Raw log ({rows.length})</div>
                <div className="text-[10.5px] text-[var(--text-2)] leading-relaxed overflow-auto h-24 whitespace-pre-wrap font-mono">
                  {rows.length ? rows.slice(-18).map((r, i) => <div key={i}>{r.event === "step" ? `step ${r.step}/${r.steps}  loss ${r.loss}  ema ${r.ema ?? "—"}  gn ${r.grad_norm ?? "—"}  (${r.elapsed}s)` : r.event === "val" ? `◈ val @ ${r.step}: ${r.val_loss}  (best ${r.best_val})` : r.event === "epoch" ? `↻ epoch ${r.n}` : r.event === "bench" ? (r.error ? `✗ bench ${r.suite}: ${r.error}` : `★ bench ${r.suite}: ${r.score}/${r.total}${r.tokSec ? `  ${r.tokSec} tok/s` : ""}`) : r.event === "phase" ? `▸ ${r.phase}` : r.event === "start" ? `▸ start on ${r.device} (${r.dtype})  base ${r.base}` : r.event === "early_stop" ? `■ early stop @ step ${r.step}: ${r.reason}` : r.event === "done" ? (r.ok ? `✓ DONE → ${r.model} (in Chat)` : "✗ failed") : r.event === "error" ? "✗ " + r.msg : r.event === "model" ? `LoRA params: ${((r.trainable_params ?? 0) / 1e6).toFixed(1)}M${r.val_blocks ? `  ·  ${r.blocks} train / ${r.val_blocks} val` : ""}` : JSON.stringify(r)}</div>) : <div className="text-[var(--muted)]">— no run yet —</div>}
                </div>
              </div>
            </div>
          </div>

          {/* ---- compare model deltas: not raw weights (no natural "shape" to a weight
              matrix) but the actual B@A*(alpha/r) delta each run learned per (layer,
              module) — a real, physically-meaningful "how different are these models"
              fingerprint, computed CPU-only from the saved best-val LoRA checkpoints ---- */}
          <div className={card + " min-w-0"} style={{ display: viewTab === "compare" ? undefined : "none" }}>
            <div className={head}><span className="text-[var(--accent-ai)]">◆</span> COMPARE MODEL DELTAS</div>
            <div className="p-1.5 md:p-4 flex flex-col gap-3 min-w-0">
              <div className="flex flex-wrap gap-2">
                {checkpoints.length === 0 && <span className="text-[11px] text-[var(--muted)]">no checkpoints found</span>}
                {checkpoints.map((n) => (
                  <button key={n} onClick={() => toggleCompare(n)}
                    className="text-[10px] px-2 py-1 rounded-[var(--r-md)] border"
                    style={{ borderColor: compareSel.includes(n) ? "var(--accent-ai)" : "var(--border)", color: compareSel.includes(n) ? "var(--accent-ai)" : "var(--text-2)", background: compareSel.includes(n) ? "color-mix(in srgb, var(--accent-ai) 12%, transparent)" : "var(--surface-2)" }}>
                    {compareSel.includes(n) ? "✓ " : ""}{n}
                  </button>
                ))}
                <button onClick={runCompare} disabled={compareBusy || compareSel.length < 2}
                  className="text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-[var(--r-md)] bg-[var(--accent-ai)] text-[var(--bg)] disabled:opacity-40">
                  {compareBusy ? "comparing…" : "Compare"}
                </button>
              </div>
              {compareErr && <div className="text-[11px] text-[var(--accent-danger)]">{compareErr}</div>}
              <p className="text-[10px] text-[var(--muted)]">Per (layer, module) magnitude of the LoRA delta each run actually learned — same color scale across all selected models, so brighter really does mean &quot;changed more,&quot; not just &quot;different run.&quot;</p>
              {compareResults && compareResults.length > 0 && (() => {
                const vmax = Math.max(1e-6, ...compareResults.flatMap((r) => r.matrix.flat()));
                return (
                  <div className="grid gap-3" style={{ gridTemplateColumns: isWide ? "repeat(auto-fit, minmax(260px, 1fr))" : "1fr" }}>
                    {compareResults.map((r) => (
                      <div key={r.name} className={panel}>
                        <div className={panelLbl}>{r.name}</div>
                        <div className="h-56"><DeltaHeatmap data={r} vmax={vmax} /></div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* ---- delta evolution: a REAL third axis (layer x step x magnitude), not the
              same snapshot redrawn taller — only populated for runs trained with
              "Snapshot every" enabled above, since it needs more than one point in time ---- */}
          <div className={card + " min-w-0"} style={{ display: viewTab === "evolution" ? undefined : "none" }}>
            <div className={head}><span className="text-[var(--accent-ai)]">◆</span> DELTA EVOLUTION (3D)</div>
            <div className="p-1.5 md:p-4 flex flex-col gap-3 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <select className="text-[11px] bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1" value={evoName} onChange={(e) => setEvoName(e.target.value)}>
                  <option value="">pick a run…</option>
                  {checkpoints.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <select className="text-[11px] bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1" value={evoModule} onChange={(e) => setEvoModule(e.target.value)}>
                  <option value="all">all modules (summed)</option>
                  {["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <button onClick={runEvolution} disabled={evoBusy || !evoName}
                  className="text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-[var(--r-md)] bg-[var(--accent-ai)] text-[var(--bg)] disabled:opacity-40">
                  {evoBusy ? "loading…" : "Load"}
                </button>
                <span className="text-[10px] text-[var(--muted)]">drag to orbit</span>
              </div>
              {evoErr && <div className="text-[11px] text-[var(--accent-danger)]">{evoErr}</div>}
              <p className="text-[10px] text-[var(--muted)]">Only works for runs trained with &quot;Snapshot every&quot; enabled in New model — most existing runs (incl. victory8-8b) don&apos;t have the intermediate snapshots this needs.</p>
              {evoData && (
                <div className={panel}>
                  <div className={panelLbl}>{evoData.name} — {evoModule === "all" ? "all modules summed" : evoModule}</div>
                  <div className="h-80"><DeltaSurface3D data={evoData} module={evoModule} /></div>
                </div>
              )}
            </div>
          </div>

          {/* ---- concept galaxy: real hidden-state embeddings of a fixed, held-out
              prompt set, projected through a fixed PCA basis fit once pre-training —
              does fine-tuning actually pull same-topic prompts closer together over
              the run? A real, checkable claim, not an animation. ---- */}
          <div className={card + " min-w-0"} style={{ display: viewTab === "galaxy" ? undefined : "none" }}>
            <div className={head}><span className="text-[var(--accent-ai)]">◆</span> CONCEPT GALAXY</div>
            <div className="p-1.5 md:p-4 flex flex-col gap-3 min-w-0">
              <p className="text-[10px] text-[var(--muted)]">16 fixed, held-out prompts across 7 topics, embedded (mean-pooled last-hidden-state) every val check and projected into the SAME fixed 3D basis each time — so trails show real movement, not a per-frame refit. Populates automatically for any run in progress; no extra config needed.</p>
              {galaxySnapshots.length === 0 ? (
                <div className="text-[11px] text-[var(--muted)]">— no embedding snapshots yet for this run —</div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <input type="range" min={0} max={galaxySnapshots.length - 1}
                      value={galaxyIdx ?? galaxySnapshots.length - 1}
                      onChange={(e) => setGalaxyIdx(+e.target.value)}
                      className="flex-1" />
                    <button onClick={() => setGalaxyIdx(null)}
                      className="text-[10px] px-2 py-1 rounded border border-[var(--border)]"
                      style={{ color: galaxyIdx == null ? "var(--accent-ai)" : "var(--text-2)" }}>
                      follow latest
                    </button>
                    <span className="text-[10px] text-[var(--muted)] w-20 text-right">step {galaxySnapshots[Math.min(galaxyIdx ?? galaxySnapshots.length - 1, galaxySnapshots.length - 1)]?.step}</span>
                  </div>
                  <div className={panel}>
                    <div className="h-80">
                      <ConceptGalaxy3D snapshots={galaxySnapshots}
                        categories={galaxyMeta?.categories ?? []}
                        labels={galaxyMeta?.labels ?? []}
                        upToIndex={galaxyIdx ?? galaxySnapshots.length - 1} />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Diagnostic({ label, value, note, tone }: { label: string; value: string; note: string; tone: "good" | "warn" | "neutral" }) {
  const color = tone === "good" ? "var(--accent-success)" : tone === "warn" ? "var(--accent-warn)" : "var(--text)";
  return (
    <div className="bg-[var(--surface-1)] p-3 min-w-0">
      <div className="text-[8px] uppercase tracking-[0.14em] text-[var(--muted)] truncate">{label}</div>
      <div className="text-lg font-semibold mt-1" style={{ color }}>{value}</div>
      <div className="text-[8px] text-[var(--muted)] truncate">{note}</div>
    </div>
  );
}
