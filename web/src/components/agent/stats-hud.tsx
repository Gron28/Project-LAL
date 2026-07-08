"use client";
// Live telemetry strip for the agent: context fill, decode speed, and the machine
// itself (GPU load/temp/VRAM, CPU, RAM). Context + tok/s come from the run's SSE
// `usage` events (passed in as props by the page); hardware comes from polling
// /api/sysinfo. Built to sit as a thin bar under the composer/header on desktop and
// inside a collapsible sheet on mobile.
import { useEffect, useRef, useState } from "react";
import { Cpu, Gauge, Thermometer, MemoryStick, Zap, X } from "lucide-react";

export type Usage = { totalTokens: number; ctx: number; tokPerSec: number | null } | null;

type Sys = {
  cpu: number; ramUsedGb: number; ramTotalGb: number; ramPct: number;
  gpu: number | null; vramUsedGb: number | null; vramTotalGb: number | null; vramPct: number | null;
  cpuTemp: number | null; gpuTemp: number | null;
  serving?: { model: string | null; idleSec: number | null };
};

const hot = (t: number | null, warn: number, danger: number) =>
  t == null ? "var(--muted)" : t >= danger ? "var(--accent-danger)" : t >= warn ? "var(--accent-warn)" : "var(--text-2)";
const barColor = (pct: number) =>
  pct >= 90 ? "var(--accent-danger)" : pct >= 70 ? "var(--accent-warn)" : "var(--accent-ai)";

function Meter({ label, pct, detail, color }: { label: string; pct: number; detail: string; color?: string }) {
  const c = color ?? barColor(pct);
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="text-[var(--muted)] uppercase tracking-wider truncate">{label}</span>
        <span className="tabular-nums shrink-0" style={{ color: c }}>{detail}</span>
      </div>
      <div className="h-1 rounded-full bg-[var(--surface-3)] overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: c }} />
      </div>
    </div>
  );
}

function Chip({ icon, value, color, title }: { icon: React.ReactNode; value: string; color?: string; title: string }) {
  return (
    <span title={title} className="flex items-center gap-1.5 text-[11px] tabular-nums shrink-0" style={{ color: color ?? "var(--text-2)" }}>
      {icon}{value}
    </span>
  );
}

export default function StatsHud({ usage, active, onServingChange }: { usage: Usage; active: boolean; onServingChange?: (model: string | null) => void }) {
  const [sys, setSys] = useState<Sys | null>(null);
  const servingRef = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const j = await fetch("/api/sysinfo").then((r) => r.json());
        if (!alive) return;
        setSys(j);
        const sm = j.serving?.model ?? null;
        if (sm !== servingRef.current) { servingRef.current = sm; onServingChange?.(sm); }
      } catch { /* server away — HUD just holds its last reading */ }
    };
    poll();
    // Poll faster while a run is active (the numbers are moving), slower when idle.
    const t = setInterval(poll, active ? 2000 : 6000);
    return () => { alive = false; clearInterval(t); };
  }, [active, onServingChange]);

  const ctxPct = usage && usage.ctx ? (usage.totalTokens / usage.ctx) * 100 : 0;
  const ctxDetail = usage ? `${(usage.totalTokens / 1000).toFixed(1)}k / ${(usage.ctx / 1000).toFixed(0)}k` : "—";

  return (
    <div className="flex items-center gap-3 lg:gap-4 flex-wrap w-full text-[var(--text-2)]">
      {/* Context fill — the headline number: how much of the window is spent. */}
      <div className="flex-1 min-w-[130px] max-w-[280px]">
        <Meter label="context" pct={ctxPct} detail={ctxDetail} />
      </div>
      <Chip icon={<Zap size={12} className="text-[var(--accent-ai)]" />}
        value={usage?.tokPerSec != null ? `${usage.tokPerSec} tok/s` : (active ? "…" : "—")}
        title="decode speed of the local model" />
      <div className="h-4 w-px bg-[var(--border-soft)] hidden sm:block" />
      <Chip icon={<Gauge size={12} />} value={sys?.gpu != null ? `${sys.gpu}%` : "—"} color={sys?.gpu != null ? barColor(sys.gpu) : undefined} title="GPU utilization" />
      <Chip icon={<MemoryStick size={12} />}
        value={sys?.vramUsedGb != null ? `${sys.vramUsedGb}/${sys.vramTotalGb ?? "?"}G` : "—"}
        color={sys?.vramPct != null ? barColor(sys.vramPct) : undefined} title="VRAM used / total" />
      <Chip icon={<Thermometer size={12} />} value={sys?.gpuTemp != null ? `${sys.gpuTemp}°` : "—"} color={hot(sys?.gpuTemp ?? null, 75, 88)} title="GPU temperature" />
      <Chip icon={<Cpu size={12} />} value={sys?.cpu != null ? `${sys.cpu}%` : "—"} title="CPU utilization" />
      <Chip icon={<MemoryStick size={12} className="opacity-60" />}
        value={sys?.ramUsedGb != null ? `${sys.ramUsedGb}/${sys.ramTotalGb}G` : "—"}
        color={sys?.ramPct != null ? barColor(sys.ramPct) : undefined} title="system RAM used / total" />
    </div>
  );
}

// A compact one-line summary for collapsed/mobile: the two numbers that matter most.
export function StatsGlance({ usage }: { usage: Usage }) {
  const ctxPct = usage && usage.ctx ? Math.round((usage.totalTokens / usage.ctx) * 100) : null;
  return (
    <span className="flex items-center gap-2 text-[10px] tabular-nums text-[var(--muted)]">
      <Gauge size={11} />
      <span style={{ color: ctxPct != null ? barColor(ctxPct) : "var(--muted)" }}>{ctxPct != null ? `${ctxPct}% ctx` : "ctx —"}</span>
      {usage?.tokPerSec != null && <span className="text-[var(--accent-ai)]">{usage.tokPerSec} tok/s</span>}
    </span>
  );
}

export { X };
