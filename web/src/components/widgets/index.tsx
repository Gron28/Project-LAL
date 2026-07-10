"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { RadarChart, MetricPanel, LossChart, Stat, PALETTE, pct, shortName } from "@/components/charts";
import type { Snapshot } from "@/lib/use-dashboard";
import type { GridWidget } from "@/components/grid";

export type Filters = { suite?: string };
export type WidgetCtx = { snap: Snapshot | null; cpuHist: number[]; gpuHist: number[]; filters: Filters };

function colour(p: number) { return p >= 90 ? "var(--accent-danger)" : p >= 70 ? "var(--accent-warn)" : "var(--accent-ai)"; }

function Bar({ label, pct: p, detail }: { label: string; pct: number | null; detail: string }) {
  const v = p ?? 0;
  return (
    <div>
      <div className="flex justify-between text-[10px] mb-1">
        <span className="tracking-widest uppercase text-[var(--text-2)]">{label}</span>
        <span style={{ color: colour(v) }}>{p == null ? "—" : v + "%"} <span className="text-[var(--muted)]">{detail}</span></span>
      </div>
      <div className="h-2 rounded-full bg-[var(--surface-3)] overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: v + "%", background: colour(v) }} />
      </div>
    </div>
  );
}

function Spark({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1), w = 100, h = 24;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-6" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

const empty = <div className="text-[10px] text-[var(--muted)] text-center py-4">connecting…</div>;

export function GpuVramWidget({ ctx }: { ctx: WidgetCtx }) {
  const s = ctx.snap?.sys; if (!s) return empty;
  return (
    <div className="flex flex-col gap-2 h-full justify-center">
      <Bar label="GPU" pct={s.gpu} detail={s.gpuTemp != null ? `${s.gpuTemp}°C` : ""} />
      <Bar label="VRAM" pct={s.vramPct} detail={s.vramTotalGb ? `${s.vramUsedGb}/${s.vramTotalGb}GB` : ""} />
      <Spark data={ctx.gpuHist} color="var(--accent-ai)" />
    </div>
  );
}

export function CpuRamWidget({ ctx }: { ctx: WidgetCtx }) {
  const s = ctx.snap?.sys; if (!s) return empty;
  return (
    <div className="flex flex-col gap-2 h-full justify-center">
      <Bar label="CPU" pct={s.cpu} detail={s.cpuTemp != null ? `${s.cpuTemp}°C` : ""} />
      <Bar label="RAM" pct={s.ramPct} detail={`${s.ramUsedGb}/${s.ramTotalGb}GB`} />
      <Spark data={ctx.cpuHist} color="var(--accent-warn)" />
    </div>
  );
}

export function TempsWidget({ ctx }: { ctx: WidgetCtx }) {
  const s = ctx.snap?.sys; if (!s) return empty;
  const temp = (t: number | null) => t == null ? "—" : <span style={{ color: t >= 85 ? "var(--accent-danger)" : t >= 70 ? "var(--accent-warn)" : "var(--text-2)" }}>{t}°C</span>;
  return (
    <div className="flex flex-col gap-1.5 h-full justify-center text-[11px]">
      <div className="flex justify-between"><span className="text-[var(--muted)]">CPU</span><span>{temp(s.cpuTemp)}</span></div>
      <div className="flex justify-between"><span className="text-[var(--muted)]">GPU</span><span>{temp(s.gpuTemp)}</span></div>
      <div className="flex justify-between"><span className="text-[var(--muted)]">NVMe</span><span>{temp(s.nvmeTemp)}</span></div>
    </div>
  );
}

export function ServingStatusWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap; if (!snap) return empty;
  return (
    <div className="flex flex-col gap-2 h-full justify-center text-[11px]">
      <div className="flex justify-between gap-2"><span className="text-[var(--muted)] shrink-0">llama</span>
        <span className="truncate" style={{ color: snap.serving ? "var(--accent-ai)" : "var(--muted)" }}>{snap.serving ? shortName(snap.serving) : "idle"}</span></div>
      <div className="flex justify-between gap-2"><span className="text-[var(--muted)] shrink-0">ollama</span>
        <span className="truncate" style={{ color: snap.sys.ollamaLoaded ? "var(--accent-warn)" : "var(--muted)" }}>{snap.sys.ollamaLoaded || "idle"}</span></div>
      <div className="flex justify-between gap-2"><span className="text-[var(--muted)] shrink-0">train</span>
        <span className="truncate" style={{ color: snap.train.running ? "var(--accent-warn)" : "var(--muted)" }}>{snap.train.running || "idle"}</span></div>
    </div>
  );
}

export function TrainLiveWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap; if (!snap) return empty;
  if (!snap.train.running) return <div className="h-full flex items-center justify-center text-[10px] text-[var(--muted)]">no training run active</div>;
  const last = [...snap.train.tail].reverse().find((r) => r.event === "step");
  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="text-[10px] text-[var(--accent-warn)] truncate">▸ {snap.train.running}</div>
      <div className="flex-1 min-h-0"><LossChart rows={snap.train.tail} /></div>
      <div className="grid grid-cols-3 gap-1.5 text-[9px] text-[var(--muted)]">
        <div>loss <span className="text-[var(--text)]">{last?.loss?.toFixed(3) ?? "—"}</span></div>
        <div>step <span className="text-[var(--text)]">{last?.step ?? "—"}</span></div>
        <div>gn <span className="text-[var(--text)]">{last?.grad_norm?.toFixed(2) ?? "—"}</span></div>
      </div>
    </div>
  );
}

function fmtEta(s?: number | null) {
  if (s == null || !isFinite(s)) return "—";
  return s >= 60 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`;
}

export function TrainKpisWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap; if (!snap) return empty;
  if (!snap.train.running) return <div className="h-full flex items-center justify-center text-[10px] text-[var(--muted)]">no training run active</div>;
  const last = [...snap.train.tail].reverse().find((r) => r.event === "step");
  return (
    <div className="grid grid-cols-2 gap-1.5 h-full content-center">
      <Stat label="steps/s" value={last?.steps_s?.toFixed(2) ?? "—"} />
      <Stat label="tok/s" value={last?.tok_s != null ? String(Math.round(last.tok_s)) : "—"} />
      <Stat label="ETA" value={fmtEta(last?.eta)} />
      <Stat label="grad norm" value={last?.grad_norm?.toFixed(2) ?? "—"} />
    </div>
  );
}

export function TrainHistoryWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap; if (!snap) return empty;
  const statusColor = (s: string) => s === "running" ? "var(--accent-warn)" : s === "done" ? "var(--accent-success)" : s === "failed" ? "var(--accent-danger)" : "var(--muted)";
  return (
    <div className="flex flex-col gap-1 text-[10px]">
      {snap.runs.slice(0, 20).map((r) => (
        <div key={r.name} className="flex justify-between gap-2">
          <span className="truncate" title={r.name}>{r.name}</span>
          <span style={{ color: statusColor(r.status) }} className="shrink-0">{r.status}</span>
          <span className="text-[var(--muted)] shrink-0 w-12 text-right">{r.finalLoss != null ? r.finalLoss.toFixed(3) : "—"}</span>
        </div>
      ))}
      {!snap.runs.length && <div className="text-[var(--muted)] text-center py-2">no runs yet</div>}
    </div>
  );
}

export function BenchComparisonTableWidget({ ctx, settings }: { ctx: WidgetCtx; settings?: Record<string, unknown> }) {
  const snap = ctx.snap; if (!snap) return empty;
  const suite = ctx.filters.suite || (settings?.suite as string) || snap.battery.suites[0] || "coding";
  const rows = snap.benchSummaries.filter((r) => r.suite === suite);
  if (!rows.length) return <div className="h-full flex items-center justify-center text-[10px] text-[var(--muted)]">no {suite} results yet</div>;
  const cats = [...new Set(rows.flatMap((r) => Object.keys(r.cats || {})))];
  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-[9px] border-collapse">
        <thead>
          <tr className="text-[var(--muted)] uppercase tracking-wide">
            <th className="text-left font-normal pb-1">model</th>
            {cats.map((c) => <th key={c} className="text-right font-normal pb-1 pl-2">{c}</th>)}
            <th className="text-right font-normal pb-1 pl-2">tot</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.model} className="border-t border-[var(--border-soft)]">
              <td className="py-1 truncate max-w-[80px]" title={r.model}>
                <span className="inline-block w-1.5 h-1.5 rounded-sm mr-1" style={{ background: PALETTE[i % PALETTE.length] }} />
                {shortName(r.model)}
              </td>
              {cats.map((c) => <td key={c} className="text-right pl-2">{pct(r.cats?.[c]?.ok ?? 0, r.cats?.[c]?.total ?? 0)}%</td>)}
              <td className="text-right pl-2 text-[var(--accent-ai)]">{pct(r.score, r.total)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BenchRadarWidget({ ctx, settings }: { ctx: WidgetCtx; settings?: Record<string, unknown> }) {
  const snap = ctx.snap; if (!snap) return empty;
  const suite = ctx.filters.suite || (settings?.suite as string) || snap.battery.suites[0] || "coding";
  const rows = snap.benchSummaries.filter((r) => r.suite === suite);
  const cats = [...new Set(rows.flatMap((r) => Object.keys(r.cats || {})))];
  if (!rows.length || cats.length < 3) return <div className="h-full flex items-center justify-center text-[10px] text-[var(--muted)]">no {suite} results yet</div>;
  return <RadarChart runs={rows} cats={cats} colorOf={(i) => PALETTE[i % PALETTE.length]} />;
}

export function SpeedBarsWidget({ ctx, settings }: { ctx: WidgetCtx; settings?: Record<string, unknown> }) {
  const snap = ctx.snap; if (!snap) return empty;
  const suite = ctx.filters.suite || (settings?.suite as string) || snap.battery.suites[0] || "coding";
  const rows = snap.benchSummaries.filter((r) => r.suite === suite);
  if (!rows.length) return <div className="h-full flex items-center justify-center text-[10px] text-[var(--muted)]">no {suite} results yet</div>;
  return <MetricPanel title={`${suite} · tok/s`} runs={rows} value={(r) => r.tokSec} fmt={(v) => v.toFixed(1)} colorOf={(i) => PALETTE[i % PALETTE.length]} />;
}

export function ModelRegistryWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap; if (!snap) return empty;
  return (
    <div className="flex flex-col gap-1 text-[10px]">
      {snap.models.map((m) => (
        <div key={m.name} className="flex justify-between gap-2">
          <span className="truncate" title={m.name}>{shortName(m.name)}</span>
          <span className="text-[var(--muted)] shrink-0">{m.gb.toFixed(1)}GB · {m.source}</span>
        </div>
      ))}
      {!snap.models.length && <div className="text-[var(--muted)] text-center py-2">no models found</div>}
    </div>
  );
}

export function QuickActionsWidget() {
  const btn = "text-[10px] tracking-widest uppercase text-center border border-[var(--border)] rounded-[var(--r-md)] py-2 hover:border-[var(--border-loud)] hover:text-[var(--accent-ai)] transition-colors";
  return (
    <div className="grid grid-cols-2 gap-2 h-full content-center">
      <Link href="/chat" className={btn}>Chat</Link>
      <Link href="/train" className={btn}>Train</Link>
      <Link href="/benchmark" className={btn}>Bench</Link>
      <Link href="/library" className={btn}>Library</Link>
    </div>
  );
}

// ---- interactive "quick action" widgets: trigger real work without leaving the dashboard ----

type ChatMsg = { role: "user" | "assistant"; content: string };

export function QuickChatWidget({ ctx }: { ctx: WidgetCtx }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages]);
  useEffect(() => {
    fetch("/api/agent/models").then((r) => r.json()).then((j) => setModel(j.current || "")).catch(() => {});
  }, []);

  const changeModel = (m: string) => {
    setModel(m);
    fetch("/api/agent/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: m }) }).catch(() => {});
  };

  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setText(""); setBusy(true);
    const next = [...messages, { role: "user", content: q } as ChatMsg];
    setMessages([...next, { role: "assistant", content: "" }]);
    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text().catch(() => "error"));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", content = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try { const ev = JSON.parse(line) as { k?: string; v?: string }; if (ev.k === "text") content += ev.v ?? ""; } catch {}
        }
        setMessages([...next, { role: "assistant", content }]);
      }
    } catch (e) {
      setMessages([...next, { role: "assistant", content: "error: " + (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full gap-1.5">
      <select value={model} onChange={(e) => changeModel(e.target.value)}
        className="shrink-0 w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-1 text-[9px] text-[var(--text)] outline-none">
        {model && !ctx.snap?.models.some((m) => m.name === model) && <option value={model}>{model}</option>}
        {(ctx.snap?.models || []).map((m) => <option key={m.name} value={m.name}>{shortName(m.name)}</option>)}
      </select>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 text-[10px]">
        {!messages.length && <div className="text-[var(--muted)] text-center py-4">ask something…</div>}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "self-end max-w-[85%] bg-[var(--accent-ai)]/15 rounded px-2 py-1" : "self-start max-w-[85%] bg-[var(--surface-2)] rounded px-2 py-1"}>
            {m.content || (m.role === "assistant" && busy ? "…" : "")}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex gap-1 shrink-0">
        <input value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="quick ask…" disabled={busy}
          className="flex-1 min-w-0 bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[10px] text-[var(--text)] outline-none focus:border-[var(--border-loud)]" />
        <button onClick={send} disabled={busy || !text.trim()}
          className="text-[9px] tracking-widest uppercase border border-[var(--border)] rounded px-2 disabled:opacity-40 hover:border-[var(--border-loud)]">→</button>
      </div>
    </div>
  );
}

type DataFile = { name: string; chars: number; kind: "raw" | "sft" };

export function QuickTrainWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap;
  const [bases, setBases] = useState<string[]>([]);
  const [dataFiles, setDataFiles] = useState<DataFile[]>([]);
  const [base, setBase] = useState("");
  const [dataFile, setDataFile] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch("/api/train?name=").then((r) => r.json()).then((j) => {
      setBases(j.bases || []);
      if (j.bases?.length) setBase((b) => b || j.bases[0]);
    }).catch(() => {});
    fetch("/api/train/data").then((r) => r.json()).then((j) => {
      const files: DataFile[] = (j.files || []).filter((f: DataFile) => f.kind === "sft");
      setDataFiles(files);
      if (files.length) setDataFile((d) => d || files[0].name);
    }).catch(() => {});
  }, []);

  const running = snap?.train.running;
  const last = running ? [...(snap?.train.tail || [])].reverse().find((r) => r.event === "step") : null;

  const start = async () => {
    if (!base || !dataFile || busy) return;
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/train", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "quick-" + Date.now().toString(36), base, mode: "sft", dataFile, steps: 150, lr: 0.0001, targetLoss: 0.1 }),
      }).then((x) => x.json());
      if (r.error) setMsg("✗ " + r.error);
    } catch (e) { setMsg("✗ " + (e as Error).message); }
    setBusy(false);
  };
  const stop = async () => {
    setBusy(true);
    await fetch("/api/train", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }) }).catch(() => {});
    setBusy(false);
  };

  const sel = "flex-1 min-w-0 bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-1 text-[9px] text-[var(--text)] outline-none";

  if (running) {
    return (
      <div className="flex flex-col gap-1.5 h-full justify-center text-[10px]">
        <div className="text-[var(--accent-warn)] truncate">▸ {running}</div>
        <div className="text-[var(--muted)]">step {last?.step ?? "—"} · loss {last?.loss?.toFixed(3) ?? "—"}</div>
        <button onClick={stop} disabled={busy}
          className="text-[9px] tracking-widest uppercase border border-[var(--accent-danger)] text-[var(--accent-danger)] rounded px-2 py-1 disabled:opacity-40">■ stop</button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 h-full justify-center">
      <select value={base} onChange={(e) => setBase(e.target.value)} className={sel}>
        {bases.map((b) => <option key={b} value={b}>{b.split("/").pop()}</option>)}
      </select>
      <select value={dataFile} onChange={(e) => setDataFile(e.target.value)} className={sel}>
        {dataFiles.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
      </select>
      <button onClick={start} disabled={busy || !base || !dataFile}
        className="text-[9px] tracking-widest uppercase border border-[var(--border)] rounded px-2 py-1 hover:border-[var(--border-loud)] disabled:opacity-40">▸ quick start (150 steps)</button>
      {msg && <div className="text-[9px] text-[var(--accent-danger)] truncate">{msg}</div>}
    </div>
  );
}

export function QuickBenchWidget({ ctx }: { ctx: WidgetCtx }) {
  const snap = ctx.snap;
  const [suiteOverride, setSuiteOverride] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ score: number; total: number } | null>(null);
  const [err, setErr] = useState("");

  if (!snap) return empty;
  const suite = suiteOverride || ctx.filters.suite || snap.battery.suites[0] || "";
  const model = modelOverride || snap.models[0]?.name || "";

  const run = async () => {
    if (!suite || !model || busy) return;
    setBusy(true); setErr(""); setResult(null);
    try {
      const r = await fetch("/api/bench", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, suite }),
      }).then((x) => x.json());
      if (r.error) setErr(r.error); else setResult({ score: r.score, total: r.total });
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const sel = "flex-1 min-w-0 bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-1 text-[9px] text-[var(--text)] outline-none";
  return (
    <div className="flex flex-col gap-1.5 h-full justify-center">
      <select value={suite} onChange={(e) => setSuiteOverride(e.target.value)} className={sel}>
        {snap.battery.suites.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <select value={model} onChange={(e) => setModelOverride(e.target.value)} className={sel}>
        {snap.models.map((m) => <option key={m.name} value={m.name}>{shortName(m.name)}</option>)}
      </select>
      <button onClick={run} disabled={busy || !suite || !model}
        className="text-[9px] tracking-widest uppercase border border-[var(--border)] rounded px-2 py-1 hover:border-[var(--border-loud)] disabled:opacity-40">
        {busy ? "running… (can take a while)" : "▸ run bench"}
      </button>
      {result && <div className="text-[9px] text-[var(--accent-ai)]">✓ {result.score}/{result.total}</div>}
      {err && <div className="text-[9px] text-[var(--accent-danger)] truncate">✗ {err}</div>}
    </div>
  );
}

export type WidgetDef = {
  title: string; minW: number; minH: number; defW: number; defH: number;
  component: (p: { ctx: WidgetCtx; settings?: Record<string, unknown> }) => React.ReactNode;
  defaultSettings?: Record<string, unknown>;
};

export const WIDGETS: Record<string, WidgetDef> = {
  "gpu-vram": { title: "GPU / VRAM", minW: 3, minH: 1, defW: 3, defH: 3, component: GpuVramWidget },
  "cpu-ram": { title: "CPU / RAM", minW: 3, minH: 1, defW: 3, defH: 3, component: CpuRamWidget },
  temps: { title: "Temps", minW: 1, minH: 1, defW: 2, defH: 2, component: TempsWidget },
  "serving-status": { title: "Serving", minW: 1, minH: 1, defW: 3, defH: 2, component: ServingStatusWidget },
  "train-live": { title: "Training (live)", minW: 4, minH: 2, defW: 6, defH: 4, component: TrainLiveWidget },
  "train-kpis": { title: "Training KPIs", minW: 2, minH: 1, defW: 3, defH: 2, component: TrainKpisWidget },
  "train-history": { title: "Train history", minW: 3, minH: 2, defW: 4, defH: 4, component: TrainHistoryWidget },
  "bench-radar": { title: "Bench radar", minW: 4, minH: 3, defW: 5, defH: 5, component: BenchRadarWidget, defaultSettings: { suite: "coding" } },
  "bench-comparison-table": { title: "Bench table", minW: 4, minH: 2, defW: 6, defH: 3, component: BenchComparisonTableWidget, defaultSettings: { suite: "coding" } },
  "speed-bars": { title: "Speed (tok/s)", minW: 3, minH: 2, defW: 4, defH: 3, component: SpeedBarsWidget, defaultSettings: { suite: "coding" } },
  "model-registry": { title: "Models", minW: 3, minH: 2, defW: 4, defH: 4, component: ModelRegistryWidget },
  "quick-actions": { title: "Quick actions", minW: 2, minH: 1, defW: 3, defH: 2, component: QuickActionsWidget },
  "quick-chat": { title: "Quick chat", minW: 3, minH: 3, defW: 4, defH: 5, component: QuickChatWidget },
  "quick-train": { title: "Quick train", minW: 3, minH: 2, defW: 3, defH: 3, component: QuickTrainWidget },
  "quick-bench": { title: "Quick bench", minW: 3, minH: 2, defW: 3, defH: 3, component: QuickBenchWidget },
};

export function widgetMinSize(type: string) {
  const w = WIDGETS[type];
  return { minW: w?.minW ?? 2, minH: w?.minH ?? 2 };
}

export function renderWidgetBody(w: GridWidget, ctx: WidgetCtx) {
  const def = WIDGETS[w.type];
  if (!def) return <div className="text-[10px] text-[var(--accent-danger)]">unknown widget: {w.type}</div>;
  const Component = def.component;
  return <Component ctx={ctx} settings={w.settings} />;
}

// pct/shortName re-exported for pages that build widget settings pickers.
export { pct, shortName };
