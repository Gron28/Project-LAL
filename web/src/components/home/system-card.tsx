"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Square, Thermometer } from "lucide-react";
import type { Snapshot } from "@/lib/use-dashboard";
import { Meter } from "@/components/ui/meter";
import { TOKENS } from "@/lib/design-tokens";

// Series identity is fixed (never re-cycled): CPU is always slot 1, GPU slot 2.
const CPU = TOKENS.chart[0];
const GPU = TOKENS.chart[1];
const HISTORY = 60; // one sample per dashboard tick (~2s) → about two minutes

type Series = { name: string; color: string; data: (number | null)[] };

/** Two-minute utilization chart: both series share one 0–100% axis. Crosshair +
 * tooltip on hover; direct labels at the line ends carry identity with the legend. */
function UtilizationChart({ series, height = 96 }: { series: Series[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(160, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = Math.max(2, ...series.map((s) => s.data.length));
  const padR = 34, padT = 6, padB = 6;
  const plotW = w - padR, plotH = height - padT - padB;
  const x = (i: number) => (i / (n - 1)) * plotW;
  const y = (v: number) => padT + plotH - (v / 100) * plotH;
  const path = (d: (number | null)[]) => d.map((v, i) => v == null ? "" : `${i && d[i - 1] != null ? "L" : "M"}${x(i + n - d.length).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / plotW) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };
  const at = (s: Series, i: number) => s.data[i - (n - s.data.length)] ?? null;
  const secondsAgo = (i: number) => Math.round((n - 1 - i) * 2);
  return (
    <div ref={ref} className="relative" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <svg width={w} height={height} role="img" aria-label="CPU and GPU utilization over the last two minutes">
        {[0, 50, 100].map((g) => (
          <g key={g}>
            <line x1={0} x2={plotW} y1={y(g)} y2={y(g)} stroke="var(--border-subtle)" strokeDasharray={g === 0 ? undefined : "2 4"} />
            <text x={w - 2} y={y(g) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">{g}%</text>
          </g>
        ))}
        {series.map((s) => <path key={s.name} d={path(s.data)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} stroke="var(--border-strong)" />}
        {hover != null && series.map((s) => { const v = at(s, hover); return v == null ? null : <circle key={s.name} cx={x(hover)} cy={y(v)} r={4} fill={s.color} stroke="var(--bg-panel)" strokeWidth={2} />; })}
      </svg>
      {hover != null && (
        <div className="pointer-events-none absolute top-0 z-10 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-panel-raised)] px-2.5 py-1.5 text-[12px] shadow-[var(--shadow-panel)]"
          style={{ left: Math.min(Math.max(0, x(hover) - 60), w - 130) }}>
          <div className="text-[var(--text-muted)]">{secondsAgo(hover) === 0 ? "now" : `${secondsAgo(hover)}s ago`}</div>
          {series.map((s) => { const v = at(s, hover); return (
            <div key={s.name} className="flex items-center gap-2"><span className="w-2 h-2 rounded-full" style={{ background: s.color }} /><span className="text-[var(--text-secondary)]">{s.name}</span><span className="ml-auto tabular-nums text-[var(--text-primary)]">{v == null ? "—" : `${Math.round(v)}%`}</span></div>
          ); })}
        </div>
      )}
    </div>
  );
}

/** Tiny single-series trend for a stat tile (no axis — the tile's number is the value). */
function Trend({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return <div className="h-6" />;
  const max = Math.max(...data, 1), w = 100, h = 24;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join(" ");
  return <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-6" aria-hidden="true"><polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" /></svg>;
}

function Stat({ label, value, unit, trend, color }: { label: string; value: number | null; unit: string; trend?: number[]; color?: string }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-[var(--bg-panel-raised)] px-3 py-2 min-w-0">
      <div className="text-[11px] text-[var(--text-muted)] truncate">{label}</div>
      <div className="text-[18px] font-semibold tabular-nums leading-tight">{value == null ? "—" : value >= 100 ? Math.round(value) : value.toFixed(1)}<span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">{value == null ? "" : unit}</span></div>
      {trend && color && <Trend data={trend} color={color} />}
    </div>
  );
}

function Temp({ label, c }: { label: string; c: number | null }) {
  const hot = c != null && c >= 85, warm = c != null && c >= 70;
  return (
    <span className="inline-flex items-center gap-1 text-[12px]" title={hot ? "Hot" : warm ? "Warm" : "Normal"}>
      {hot ? <AlertTriangle size={12} className="text-[var(--status-error)]" /> : <Thermometer size={12} className={warm ? "text-[var(--status-warning)]" : "text-[var(--text-muted)]"} />}
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="tabular-nums text-[var(--text-primary)]">{c == null ? "—" : `${c}°`}</span>
      {(hot || warm) && <span className={hot ? "text-[var(--status-error)]" : "text-[var(--status-warning)]"}>{hot ? "hot" : "warm"}</span>}
    </span>
  );
}

export function SystemCard({ snap, cpuHist, gpuHist, onStopAll }: { snap: Snapshot | null; cpuHist: number[]; gpuHist: number[]; onStopAll: () => void }) {
  const s = snap?.sys;
  const serving = snap?.runtime.serving;
  const tel = snap?.runtime.telemetry;
  const model = serving?.model ?? snap?.serving ?? null;
  // Generation-speed history is kept here: the shared hook only tracks CPU/GPU.
  const [genHist, setGenHist] = useState<number[]>([]);
  useEffect(() => {
    const v = tel?.predictedTokensPerSecond;
    if (v == null) return;
    const t = setTimeout(() => setGenHist((h) => [...h, v].slice(-HISTORY)), 0);
    return () => clearTimeout(t);
  }, [tel?.observedAt, tel?.predictedTokensPerSecond]);

  return (
    <section aria-label="System" className="surface flex min-h-0 flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">System</h2>
        <Link href="/models" className="text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-accent)]">Models →</Link>
      </div>
      <div className="flex items-center gap-2 text-[14px]">
        <span className="w-2 h-2 rounded-full" style={{ background: model ? "var(--status-success)" : "var(--text-muted)" }} />
        <span className="truncate">{model ?? "No model loaded"}</span>
        {serving?.context ? <span className="ml-auto text-[12px] text-[var(--text-muted)]">{Math.round(serving.context / 1024)}K ctx</span> : null}
      </div>

      <div>
        <div className="mb-1 flex items-center gap-3 text-[12px]">
          <span className="text-[var(--text-muted)]">Activity · 2 min</span>
          <span className="ml-auto inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: CPU }} /><span className="text-[var(--text-secondary)]">CPU</span><span className="tabular-nums">{s ? `${s.cpu}%` : "—"}</span></span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: GPU }} /><span className="text-[var(--text-secondary)]">GPU</span><span className="tabular-nums">{s?.gpu != null ? `${s.gpu}%` : "—"}</span></span>
        </div>
        <UtilizationChart series={[{ name: "CPU", color: CPU, data: cpuHist }, { name: "GPU", color: GPU, data: gpuHist }]} />
      </div>

      <div className="flex flex-col gap-3">
        <Meter label="RAM" value={s?.ramPct ?? null} detail={s ? `${s.ramUsedGb} / ${s.ramTotalGb} GB` : undefined} />
        <Meter label="VRAM" value={s?.vramPct ?? null} detail={s?.vramTotalGb ? `${s.vramUsedGb} / ${s.vramTotalGb} GB` : undefined} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat label="Generation" value={tel?.predictedTokensPerSecond ?? null} unit="tok/s" trend={genHist} color={TOKENS.chart[3]} />
        <Stat label="Prompt" value={tel?.promptTokensPerSecond ?? null} unit="tok/s" />
        <Stat label="KV cache" value={tel?.kvCacheUsagePct ?? null} unit="%" />
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2">
        <Temp label="CPU" c={s?.cpuTemp ?? null} />
        <Temp label="GPU" c={s?.gpuTemp ?? null} />
        <Temp label="NVMe" c={s?.nvmeTemp ?? null} />
        {snap?.train.running && <Link href="/train" className="btn btn-secondary px-3 min-h-8 text-xs">Training {snap.train.running}</Link>}
        <button onClick={onStopAll} className="btn btn-danger ml-auto px-3 min-h-8 text-xs"><Square size={12} /> Stop all agents</button>
      </div>
    </section>
  );
}
