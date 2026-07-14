"use client";

import { Activity } from "lucide-react";
import { useEffect, useRef } from "react";

export type TokenAlternatives = { token: string; p: number; alts: [string, number][] };

const colorFor = (p: number) => p >= .85 ? "#52d273" : p >= .6 ? "#f1b64d" : "#ff7670";

// Displays only chosen-token probabilities returned by the serving backend.
export default function CertaintyWave({ wave, alts = [], active, height = 48 }: { wave: number[]; alts?: TokenAlternatives[]; active?: boolean; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const width = canvas.clientWidth || 300, dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, width, height);
    const shown = wave.slice(-Math.max(72, Math.floor(width / 3)));
    if (!shown.length) return;
    const step = width / Math.max(72, shown.length);
    // Soft vertical grid makes the trace easier to scan without becoming a chart.
    ctx.strokeStyle = "rgba(148, 163, 184, .12)"; ctx.lineWidth = 1;
    [0.25, .5, .75].forEach((ratio) => { ctx.beginPath(); ctx.moveTo(0, Math.round(height * ratio) + .5); ctx.lineTo(width, Math.round(height * ratio) + .5); ctx.stroke(); });
    const points: { x: number; y: number; p: number }[] = [];
    shown.forEach((p, i) => {
      const x = i * step + step / 2, y = height - 4 - Math.max(2, p * (height - 9));
      points.push({ x, y, p });
      ctx.fillStyle = colorFor(p); ctx.globalAlpha = .58;
      ctx.fillRect(x - Math.max(.65, step * .18), y, Math.max(1.3, step * .36), height - y - 4);
    });
    ctx.globalAlpha = 1;
    // Every segment is coloured from the probability it represents. There is no
    // left-to-right colour gradient, which would falsely suggest a confidence trend.
    ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1], point = points[i];
      ctx.strokeStyle = colorFor((previous.p + point.p) / 2);
      ctx.beginPath(); ctx.moveTo(previous.x, previous.y); ctx.lineTo(point.x, point.y); ctx.stroke();
    }
  }, [wave, height]);
  const avg = wave.length ? wave.reduce((sum, p) => sum + p, 0) / wave.length : null;
  const uncertain = wave.filter((p) => p < .5).length;
  const recent = alts.slice(-3).reverse();
  return <section className="mt-3 max-w-xl">
    <div className="mb-1.5 flex items-center gap-2 text-[9px] tabular-nums">
      <Activity size={12} className="text-[var(--muted)]" />
      {avg != null ? <><span className="font-medium" style={{ color: colorFor(avg) }}>{Math.round(avg * 100)}%</span><span className="text-[var(--muted)]">{wave.length} tokens · {uncertain} low</span>{active && <i className="size-1 rounded-full bg-[var(--accent-ai)] animate-pulse" />}</> : <span className="text-[var(--muted)]">{active ? "reading certainty…" : "certainty unavailable"}</span>}
    </div>
    {wave.length > 0 ? <canvas ref={ref} style={{ width: "100%", height }} className="block border-y border-[var(--border-soft)] bg-[var(--surface-1)]" aria-label="Live token certainty trace" /> : <div className="border-y border-dashed border-[var(--border-soft)] py-2 text-[9px] text-[var(--muted)]">{active ? "Waiting for token probabilities…" : "No token probabilities returned."}</div>}
    {recent.length > 0 && <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-[var(--muted)]">{recent.map((item, i) => { const runnerUp = item.alts[0]; const margin = runnerUp ? item.p - runnerUp[1] : null; return <span key={i}><b className="font-medium text-[var(--text-2)]">{JSON.stringify(item.token).slice(1, -1) || "space"}</b> <span style={{ color: colorFor(item.p) }}>{Math.round(item.p * 100)}%</span>{runnerUp && <> <span className="opacity-50">/</span> {JSON.stringify(runnerUp[0]).slice(1, -1)} <span className="opacity-50">Δ</span> {Math.round(margin! * 100)}%</>}</span>; })}</div>}
  </section>;
}
