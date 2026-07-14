"use client";
// Verbatim extraction of the chart components from benchmark/page.tsx and
// train/page.tsx — pure move so both pages and dashboard widgets share one copy.
import { useCallback, useEffect, useRef, useState } from "react";

export type Cats = Record<string, { ok: number; total: number }>;
export type Res = {
  model: string; suite: string; score: number; total: number; cats: Cats;
  tokSec: number | null; sizeGb?: number | null; latencyMs?: number | null; ttftMs?: number | null;
  ts?: number; pinned?: boolean; stale?: boolean; pinnedRev?: number | null;
  // omitted by the dashboard's SSE snapshot (kept slim) — RadarChart/MetricPanel/ScatterPlot never read it.
  results?: { cat: string; q: string; ok: boolean; got: string; detail?: string; shot?: string }[];
};

export const PALETTE = ["#34ffa6", "#7c9cff", "#ffb454", "#ff6b9d", "#5ec8d8", "#c084fc", "#f5d142", "#fb923c"];
export const pct = (ok: number, total: number) => (total ? Math.round((100 * ok) / total) : 0);
export const shortName = (m: string) => (m.split("/").pop() || m).replace(/-f16$/, "").slice(0, 18);

// ---- shared floating tooltip: every chart in this file positions one of these at the
// hovered point's screen coords, inside a `relative` wrapper. Clamped so it doesn't
// run off the right/bottom edge of its own chart. ----
export function HoverBox({ x, y, w, h, children }: { x: number; y: number; w: number; h: number; children: React.ReactNode }) {
  const boxW = 168; // approx — good enough to clamp without measuring the real DOM node
  const left = Math.min(Math.max(x + 10, 4), w - boxW - 4);
  const top = Math.min(Math.max(y + 10, 4), h - 60);
  return (
    <div className="absolute pointer-events-none z-10 text-[10px] font-mono leading-snug bg-[var(--surface-1)] border border-[var(--border-loud)] rounded-[var(--r-md)] px-2 py-1.5 shadow-lg whitespace-nowrap"
      style={{ left, top, maxWidth: boxW }}>
      {children}
    </div>
  );
}

// ---- intelligence-by-dimension radar (bigger + labeled rings) ----
export function RadarChart({ runs, cats, colorOf }: { runs: Res[]; cats: string[]; colorOf: (i: number) => string }) {
  const size = 460, cx = size / 2, cy = size / 2, R = 168;
  const M = cats.length;
  if (M < 3) return null;
  const ang = (i: number) => ((-90 + (360 * i) / M) * Math.PI) / 180;
  const pt = (val: number, i: number): [number, number] => [cx + (val / 100) * R * Math.cos(ang(i)), cy + (val / 100) * R * Math.sin(ang(i))];
  const poly = (vals: number[]) => vals.map((v, i) => { const [x, y] = pt(v, i); return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`; }).join(" ") + "Z";
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[460px] mx-auto">
      {/* rings with % labels */}
      {[20, 40, 60, 80, 100].map((f) => (
        <g key={f}>
          <path d={poly(cats.map(() => f))} fill="none" stroke="var(--border)" strokeWidth={f === 100 ? 1.2 : 0.8} />
          <text x={cx + 3} y={cy - (f / 100) * R} fontSize={9} fill="var(--muted)" dominantBaseline="middle">{f}</text>
        </g>
      ))}
      {/* spokes + dimension labels */}
      {cats.map((c, i) => {
        const [x, y] = pt(100, i); const [lx, ly] = pt(116, i);
        return (
          <g key={c}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke="var(--border)" strokeWidth={0.8} />
            <text x={lx} y={ly} fontSize={12} fontWeight={700} fill="var(--text-2)" textAnchor={Math.abs(lx - cx) < 12 ? "middle" : lx > cx ? "start" : "end"} dominantBaseline="middle">{c.toUpperCase()}</text>
          </g>
        );
      })}
      {/* one polygon per model, with vertex dots */}
      {runs.map((r, ri) => {
        const vals = cats.map((c) => pct(r.cats[c]?.ok ?? 0, r.cats[c]?.total ?? 0));
        return (
          <g key={r.model}>
            <path d={poly(vals)} fill={colorOf(ri)} fillOpacity={0.1} stroke={colorOf(ri)} strokeWidth={2.5} />
            {vals.map((v, i) => { const [x, y] = pt(v, i); return <circle key={i} cx={x} cy={y} r={3} fill={colorOf(ri)} />; })}
          </g>
        );
      })}
    </svg>
  );
}

// ---- one metric, horizontal bars per model ----
export function MetricPanel({ title, runs, value, fmt, colorOf }: {
  title: string; runs: Res[]; value: (r: Res) => number | null; fmt: (v: number) => string; colorOf: (i: number) => string;
}) {
  const vals = runs.map(value).filter((v): v is number => v != null);
  const max = Math.max(...vals, 0.0001);
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-[var(--muted)] mb-2">{title}</div>
      <div className="flex flex-col gap-1.5">
        {runs.map((r, i) => {
          const v = value(r);
          const w = v != null ? Math.max(3, (v / max) * 100) : 0;
          return (
            <div key={r.model} className="flex items-center gap-2">
              <span className="w-16 text-[9px] truncate text-[var(--text-2)]" title={r.model}>{shortName(r.model)}</span>
              <div className="flex-1 h-3 bg-[var(--surface-2)] rounded overflow-hidden"><div className="h-full rounded" style={{ width: w + "%", background: colorOf(i) }} /></div>
              <span className="w-12 text-right text-[9px] text-[var(--muted)]">{v != null ? fmt(v) : "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- efficiency scatter: speed (x) vs intelligence (y), bubble = weight ----
export function ScatterPlot({ runs, colorOf }: { runs: Res[]; colorOf: (i: number) => string }) {
  const W = 380, H = 240, padL = 34, padB = 26, padT = 12, padR = 12;
  const xmax = Math.max(...runs.map((r) => r.tokSec ?? 0), 1) * 1.15;
  const wmax = Math.max(...runs.map((r) => r.sizeGb ?? 1), 1);
  const X = (v: number) => padL + (W - padL - padR) * (v / xmax);
  const Y = (v: number) => H - padB - (H - padB - padT) * (v / 100);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {[0, 25, 50, 75, 100].map((g) => (
        <g key={g}>
          <line x1={padL} y1={Y(g)} x2={W - padR} y2={Y(g)} stroke="var(--border)" strokeWidth={0.5} />
          <text x={padL - 4} y={Y(g)} fontSize={8} fill="var(--muted)" textAnchor="end" dominantBaseline="middle">{g}</text>
        </g>
      ))}
      <text x={(padL + W - padR) / 2} y={H - 3} fontSize={9} fill="var(--text-2)" textAnchor="middle">speed (tok/s) →</text>
      <text x={4} y={padT} fontSize={9} fill="var(--text-2)">intelligence %</text>
      {runs.map((r, i) => {
        const x = X(r.tokSec ?? 0), y = Y(pct(r.score, r.total));
        const rad = 4 + 11 * Math.sqrt((r.sizeGb ?? 1) / wmax);
        return (
          <g key={r.model}>
            <circle cx={x} cy={y} r={rad} fill={colorOf(i)} fillOpacity={0.3} stroke={colorOf(i)} strokeWidth={1.5} />
            <text x={x} y={y - rad - 2} fontSize={8} fill="var(--text-2)" textAnchor="middle">{shortName(r.model)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ---- small labeled stat tile — hover for the exact reading (title = native tooltip,
// zero extra markup, works everywhere incl. touch-and-hold on most mobile browsers) ----
export function Stat({ label, value, sub, color, detail }: { label: string; value: string; sub?: string; color?: string; detail?: string }) {
  return (
    <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] px-3 py-2.5"
      title={[label, value, sub, detail].filter(Boolean).join(" · ")}>
      <div className="text-[9px] tracking-widest uppercase text-[var(--muted)]">{label}</div>
      <div className="text-base font-bold leading-tight mt-0.5 truncate" style={{ color: color || "var(--text)" }}>{value}</div>
      {sub && <div className="text-[10px] text-[var(--muted)] truncate">{sub}</div>}
    </div>
  );
}

export type LossRow = {
  event: string; step?: number; loss?: number; val_loss?: number;
  // added for the telemetry redesign — all optional, so older log lines
  // (pre-redesign runs) and narrower callers (dashboard tail) still typecheck.
  epoch?: number; grad_norm?: number; layer_gnorm?: number[]; source?: string;
  repeat_n?: number; steps_s?: number; tok_s?: number; gpu_mb?: number;
  patience?: number; best_step?: number;
  length_hist?: { edges: number[]; kept: number[]; dropped: number[] };
  prompt?: string; target?: string; generated?: string; error?: string;
  // per-token certitude of the probe generation — chosen-token softmax prob and
  // full-distribution entropy (nats), straight from the trainer's logits
  tokens?: string[]; probs?: number[]; entropy?: number[];
};

// ---- training loss canvas: raw (faint) + EMA (bold) + val (amber) + best marker ----
export function LossChart({ rows }: { rows: LossRow[] }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const hit = useRef<{ X: (v: number) => number; xmin: number; xmax: number; pts: { step: number; loss: number; ema: number; source?: string; repeat_n?: number }[] } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; w: number; h: number; p: NonNullable<typeof hit.current>["pts"][number] } | null>(null);
  const draw = useCallback(() => {
    const c = cv.current; if (!c) return;
    const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr; const x = c.getContext("2d")!; x.scale(dpr, dpr); x.clearRect(0, 0, w, h);
    const L = 38, R = w - 8, T = 10, B = h - 18;
    x.strokeStyle = "#1c4136"; for (let i = 0; i <= 4; i++) { const y = T + (B - T) * i / 4; x.beginPath(); x.moveTo(L, y); x.lineTo(R, y); x.stroke(); }
    const st = rows.filter((r) => r.event === "step" && r.loss != null);
    if (!st.length) { x.fillStyle = "#7fa896"; x.font = "10px monospace"; x.textAlign = "center"; x.fillText("AWAITING TRAINING", (L + R) / 2, (T + B) / 2); return; }
    const vl = rows.filter((r) => r.event === "val" && r.val_loss != null);
    const ys = st.map((s) => s.loss!).concat(vl.map((v) => v.val_loss!));
    // x-domain from the DATA's span, not 0..max: the dashboard stream sends a sliding
    // tail of the log, and anchoring the axis at 0 squeezes long runs into the right edge.
    const xs = st.map((s) => s.step!).concat(vl.filter((v) => v.step != null).map((v) => v.step!));
    const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
    const X = (v: number) => L + (R - L) * (v - xmin) / ((xmax - xmin) || 1), Y = (v: number) => T + (B - T) * (1 - (v - ymin) / ((ymax - ymin) || 1));
    x.fillStyle = "#90c0ac"; x.font = "9px monospace"; x.textAlign = "right"; x.fillText(ymax.toFixed(2), L - 3, T + 8); x.fillText(ymin.toFixed(2), L - 3, B);
    x.textAlign = "left"; x.fillText(String(xmin), L, h - 5); x.textAlign = "right"; x.fillText(String(xmax), R, h - 5);
    // epoch boundaries — faint vertical rule where the epoch counter increments
    let lastEpoch = st[0].epoch;
    x.strokeStyle = "rgba(255,255,255,0.12)"; x.lineWidth = 1;
    st.forEach((s) => {
      if (s.epoch != null && s.epoch !== lastEpoch) {
        const px = X(s.step!);
        x.beginPath(); x.moveTo(px, T); x.lineTo(px, B); x.stroke();
        lastEpoch = s.epoch;
      }
    });
    // raw loss (faint)
    x.strokeStyle = "rgba(52,255,166,0.28)"; x.lineWidth = 1; x.beginPath(); st.forEach((s, i) => { const px = X(s.step!), py = Y(s.loss!); if (i) x.lineTo(px, py); else x.moveTo(px, py); }); x.stroke();
    // EMA smoothed loss (bold) — the trend through the noise
    let ema = st[0].loss!; const a = 0.3;
    const emaArr: number[] = [];
    x.strokeStyle = "#34ffa6"; x.lineWidth = 2; x.beginPath();
    st.forEach((s, i) => { ema = a * s.loss! + (1 - a) * ema; emaArr.push(ema); const px = X(s.step!), py = Y(ema); if (i) x.lineTo(px, py); else x.moveTo(px, py); }); x.stroke();
    hit.current = { X, xmin, xmax, pts: st.map((s, i) => ({ step: s.step!, loss: s.loss!, ema: emaArr[i], source: s.source, repeat_n: s.repeat_n })) };
    // held-out val loss (amber line + dots) — divergence from train = overfitting
    if (vl.length) {
      x.strokeStyle = "#ffb454"; x.lineWidth = 1.5; x.beginPath();
      vl.forEach((v, i) => { const px = X(v.step!), py = Y(v.val_loss!); if (i) x.lineTo(px, py); else x.moveTo(px, py); }); x.stroke();
      x.fillStyle = "#ffb454";
      vl.forEach((v) => { x.beginPath(); x.arc(X(v.step!), Y(v.val_loss!), 2.5, 0, 7); x.fill(); });
    }
    // memorization tell: a repeat-seen example that posts a new best-ever loss —
    // exactly the victory4 signature (EMA hits new lows from memorizing repeats
    // while val quietly gets worse). Flag it so it's visible live, not postmortem.
    const tys = st.map((s) => s.loss!); let running = Infinity;
    st.forEach((s) => {
      const isNewBest = s.loss! < running - 1e-4; if (isNewBest) running = s.loss!;
      if (isNewBest && (s.repeat_n ?? 1) > 1) {
        const px = X(s.step!), py = Y(s.loss!);
        x.strokeStyle = "#ff6b9d"; x.lineWidth = 1.3;
        x.beginPath(); x.arc(px, py, 5, 0, 7); x.stroke();
      }
    });
    // best-train-loss marker
    const tmin = Math.min(...tys);
    const bi = tys.indexOf(tmin); const bx = X(st[bi].step!), by = Y(tmin);
    x.fillStyle = "#eafff5"; x.beginPath(); x.arc(bx, by, 3, 0, 7); x.fill();
  }, [rows]);
  useEffect(() => { draw(); }, [draw]);
  return (
    <div className="relative w-full h-full"
      onMouseMove={(e) => {
        const c = cv.current; if (!c || !hit.current) return;
        const r = c.getBoundingClientRect(); const mx = e.clientX - r.left;
        let best = null, bestDist = Infinity;
        for (const p of hit.current.pts) { const d = Math.abs(hit.current.X(p.step) - mx); if (d < bestDist) { bestDist = d; best = p; } }
        if (best) setHover({ x: mx, y: e.clientY - r.top, w: r.width, h: r.height, p: best });
      }}
      onMouseLeave={() => setHover(null)}>
      <canvas ref={cv} className="w-full h-full" />
      {hover && (
        <HoverBox x={hover.x} y={hover.y} w={hover.w} h={hover.h}>
          <div>step <b className="text-[var(--text)]">{hover.p.step}</b></div>
          <div>loss {hover.p.loss.toFixed(4)} · ema {hover.p.ema.toFixed(4)}</div>
          {hover.p.source && <div>source: {hover.p.source}</div>}
          {(hover.p.repeat_n ?? 1) > 1 && <div className="text-[#ff6b9d]">seen {hover.p.repeat_n}× this run</div>}
        </HoverBox>
      )}
    </div>
  );
}

// ---- generic single-metric history line (grad norm, throughput, …) ----
export function MetricHistoryChart({ rows, field, color, fmt, threshold }: {
  rows: LossRow[]; field: keyof LossRow; color: string; fmt?: (v: number) => string; threshold?: number;
}) {
  const cv = useRef<HTMLCanvasElement>(null);
  const hit = useRef<{ X: (v: number) => number; pts: { step: number; v: number }[] } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; w: number; h: number; p: { step: number; v: number } } | null>(null);
  const draw = useCallback(() => {
    const c = cv.current; if (!c) return;
    const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr; const x = c.getContext("2d")!; x.scale(dpr, dpr); x.clearRect(0, 0, w, h);
    const L = 34, R = w - 6, T = 8, B = h - 16;
    x.strokeStyle = "#1c4136"; for (let i = 0; i <= 3; i++) { const y = T + (B - T) * i / 3; x.beginPath(); x.moveTo(L, y); x.lineTo(R, y); x.stroke(); }
    const st = rows.filter((r) => r.event === "step" && r[field] != null) as (LossRow & Record<string, number>)[];
    if (!st.length) { x.fillStyle = "#7fa896"; x.font = "9px monospace"; x.textAlign = "center"; x.fillText("—", (L + R) / 2, (T + B) / 2); return; }
    const ys = st.map((s) => s[field] as number);
    const xs = st.map((s) => s.step!);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ymin = Math.min(0, ...ys), ymax = Math.max(...ys, threshold ?? -Infinity) * 1.05 || 1;
    const X = (v: number) => L + (R - L) * (v - xmin) / ((xmax - xmin) || 1);
    const Y = (v: number) => T + (B - T) * (1 - (v - ymin) / ((ymax - ymin) || 1));
    x.fillStyle = "#90c0ac"; x.font = "9px monospace"; x.textAlign = "right";
    x.fillText(fmt ? fmt(ymax) : ymax.toFixed(1), L - 3, T + 8);
    x.fillText(fmt ? fmt(ymin) : ymin.toFixed(1), L - 3, B);
    if (threshold != null) {
      x.strokeStyle = "rgba(255,180,84,0.5)"; x.setLineDash([3, 3]); x.lineWidth = 1;
      x.beginPath(); x.moveTo(L, Y(threshold)); x.lineTo(R, Y(threshold)); x.stroke(); x.setLineDash([]);
    }
    x.strokeStyle = color; x.lineWidth = 1.5; x.beginPath();
    st.forEach((s, i) => { const px = X(s.step!), py = Y(s[field] as number); if (i) x.lineTo(px, py); else x.moveTo(px, py); });
    x.stroke();
    // filled area under the curve, faint
    x.lineTo(X(xs[xs.length - 1]), B); x.lineTo(X(xs[0]), B); x.closePath();
    x.globalAlpha = 0.08; x.fillStyle = color; x.fill(); x.globalAlpha = 1;
    hit.current = { X, pts: st.map((s) => ({ step: s.step!, v: s[field] as number })) };
  }, [rows, field, color, fmt, threshold]);
  useEffect(() => { draw(); }, [draw]);
  return (
    <div className="relative w-full h-full"
      onMouseMove={(e) => {
        const c = cv.current; if (!c || !hit.current) return;
        const r = c.getBoundingClientRect(); const mx = e.clientX - r.left;
        let best = null, bestDist = Infinity;
        for (const p of hit.current.pts) { const d = Math.abs(hit.current.X(p.step) - mx); if (d < bestDist) { bestDist = d; best = p; } }
        if (best) setHover({ x: mx, y: e.clientY - r.top, w: r.width, h: r.height, p: best });
      }}
      onMouseLeave={() => setHover(null)}>
      <canvas ref={cv} className="w-full h-full" />
      {hover && (
        <HoverBox x={hover.x} y={hover.y} w={hover.w} h={hover.h}>
          <div>step <b className="text-[var(--text)]">{hover.p.step}</b></div>
          <div>{fmt ? fmt(hover.p.v) : hover.p.v.toFixed(3)}</div>
        </HoverBox>
      )}
    </div>
  );
}

// ---- loss grouped by data-source tag — "does coding cluster differently" as a
// real chart, not an invented shape. One faint line + endpoint dot per source. ----
export function SourceLossChart({ rows }: { rows: LossRow[] }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const hit = useRef<{ sx: number; sy: number; step: number; source: string; ema: number; color: string }[]>([]);
  const [hover, setHover] = useState<{ x: number; y: number; w: number; h: number; p: (typeof hit.current)[number] } | null>(null);
  const draw = useCallback(() => {
    const c = cv.current; if (!c) return;
    const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr; const x = c.getContext("2d")!; x.scale(dpr, dpr); x.clearRect(0, 0, w, h);
    const L = 34, R = w - 6, T = 8, B = h - 16;
    const st = rows.filter((r) => r.event === "step" && r.loss != null && r.source);
    if (!st.length) { x.fillStyle = "#7fa896"; x.font = "9px monospace"; x.textAlign = "center"; x.fillText("no source-tagged steps yet", (L + R) / 2, (T + B) / 2); return; }
    const bySource = new Map<string, { step: number; loss: number }[]>();
    st.forEach((s) => { const arr = bySource.get(s.source!) || []; arr.push({ step: s.step!, loss: s.loss! }); bySource.set(s.source!, arr); });
    const xs = st.map((s) => s.step!), ys = st.map((s) => s.loss!);
    const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
    const X = (v: number) => L + (R - L) * (v - xmin) / ((xmax - xmin) || 1);
    const Y = (v: number) => T + (B - T) * (1 - (v - ymin) / ((ymax - ymin) || 1));
    const sources = Array.from(bySource.keys()).sort();
    const hitPts: typeof hit.current = [];
    sources.forEach((src, i) => {
      const color = PALETTE[i % PALETTE.length];
      const pts = bySource.get(src)!;
      // rolling EMA per source so a single noisy point doesn't dominate its line
      let ema = pts[0].loss; const a = 0.35;
      x.strokeStyle = color; x.lineWidth = 1.4; x.globalAlpha = 0.85; x.beginPath();
      pts.forEach((p, j) => {
        ema = a * p.loss + (1 - a) * ema;
        const px = X(p.step), py = Y(ema);
        if (j) x.lineTo(px, py); else x.moveTo(px, py);
        hitPts.push({ sx: px, sy: py, step: p.step, source: src, ema, color });
      });
      x.stroke(); x.globalAlpha = 1;
    });
    hit.current = hitPts;
    // legend
    let lx = L;
    x.font = "9px monospace"; x.textAlign = "left";
    sources.forEach((src, i) => {
      const color = PALETTE[i % PALETTE.length];
      x.fillStyle = color; x.fillRect(lx, 2, 6, 6);
      x.fillStyle = "#c8ddd2"; x.fillText(src, lx + 9, 8);
      lx += 9 + x.measureText(src).width + 12;
    });
  }, [rows]);
  useEffect(() => { draw(); }, [draw]);
  return (
    <div className="relative w-full h-full"
      onMouseMove={(e) => {
        const c = cv.current; if (!c || !hit.current.length) return;
        const r = c.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
        let best = null, bestDist = Infinity;
        for (const p of hit.current) { const d = (p.sx - mx) ** 2 + (p.sy - my) ** 2; if (d < bestDist) { bestDist = d; best = p; } }
        if (best) setHover({ x: mx, y: my, w: r.width, h: r.height, p: best });
      }}
      onMouseLeave={() => setHover(null)}>
      <canvas ref={cv} className="w-full h-full" />
      {hover && (
        <HoverBox x={hover.x} y={hover.y} w={hover.w} h={hover.h}>
          <div style={{ color: hover.p.color }}><b>{hover.p.source}</b></div>
          <div>step {hover.p.step} · loss {hover.p.ema.toFixed(4)}</div>
        </HoverBox>
      )}
    </div>
  );
}

// ---- per-block gradient-norm heatmap: block (row) x step (col) ----
export function BlockHeatmap({ rows, maxCols = 120 }: { rows: LossRow[]; maxCols?: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const hit = useRef<{ L: number; T: number; cw: number; ch: number; nBlocks: number; cols: LossRow[] } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; w: number; h: number; step: number; block: number; v: number } | null>(null);
  const draw = useCallback(() => {
    const c = cv.current; if (!c) return;
    const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr; const x = c.getContext("2d")!; x.scale(dpr, dpr); x.clearRect(0, 0, w, h);
    const st = rows.filter((r) => r.event === "step" && Array.isArray(r.layer_gnorm) && r.layer_gnorm!.length);
    if (!st.length) { x.fillStyle = "#7fa896"; x.font = "9px monospace"; x.textAlign = "center"; x.fillText("awaiting per-block gradients", w / 2, h / 2); return; }
    const cols = st.slice(-maxCols);
    const nBlocks = cols[0].layer_gnorm!.length;
    const L = 4, T = 4, R = w - 4, B = h - 4;
    const cw = (R - L) / cols.length, ch = (B - T) / nBlocks;
    let vmax = 0;
    cols.forEach((s) => s.layer_gnorm!.forEach((v) => { if (v > vmax) vmax = v; }));
    vmax = vmax || 1;
    cols.forEach((s, ci) => {
      s.layer_gnorm!.forEach((v, bi) => {
        const t = Math.min(1, v / vmax);
        // dark surface -> phosphor green ramp
        const rr = Math.round(16 + t * (52 - 16)), gg = Math.round(35 + t * (255 - 35)), bb = Math.round(30 + t * (166 - 30));
        x.fillStyle = `rgb(${rr},${gg},${bb})`;
        x.fillRect(L + ci * cw, T + bi * ch, Math.ceil(cw) + 0.5, Math.ceil(ch) + 0.5);
      });
    });
    hit.current = { L, T, cw, ch, nBlocks, cols };
  }, [rows, maxCols]);
  useEffect(() => { draw(); }, [draw]);
  return (
    <div className="relative w-full h-full"
      onMouseMove={(e) => {
        const c = cv.current; if (!c || !hit.current) return;
        const { L, T, cw, ch, nBlocks, cols } = hit.current;
        const r = c.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
        const ci = Math.floor((mx - L) / cw), bi = Math.floor((my - T) / ch);
        if (ci < 0 || ci >= cols.length || bi < 0 || bi >= nBlocks) { setHover(null); return; }
        const v = cols[ci].layer_gnorm?.[bi];
        if (v == null) { setHover(null); return; }
        setHover({ x: mx, y: my, w: r.width, h: r.height, step: cols[ci].step!, block: bi, v });
      }}
      onMouseLeave={() => setHover(null)}>
      <canvas ref={cv} className="w-full h-full" />
      {hover && (
        <HoverBox x={hover.x} y={hover.y} w={hover.w} h={hover.h}>
          <div>step {hover.step} · block {hover.block}</div>
          <div>grad norm {hover.v.toFixed(4)}</div>
        </HoverBox>
      )}
    </div>
  );
}

// ---- token-length distribution of the loaded mix: kept vs dropped-overlength ----
export function LengthHistogramChart({ hist }: { hist?: { edges: number[]; kept: number[]; dropped: number[] } }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const hit = useRef<{ L: number; bw: number; n: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; w: number; h: number; i: number } | null>(null);
  const draw = useCallback(() => {
    const c = cv.current; if (!c) return;
    const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr; const x = c.getContext("2d")!; x.scale(dpr, dpr); x.clearRect(0, 0, w, h);
    const L = 30, R = w - 6, T = 8, B = h - 16;
    if (!hist || !hist.kept.length) { x.fillStyle = "#7fa896"; x.font = "9px monospace"; x.textAlign = "center"; x.fillText("—", (L + R) / 2, (T + B) / 2); return; }
    const n = hist.kept.length;
    const maxV = Math.max(1, ...hist.kept.map((v, i) => v + hist.dropped[i]));
    const bw = (R - L) / n;
    for (let i = 0; i < n; i++) {
      const kept = hist.kept[i], drop = hist.dropped[i];
      const keptH = (B - T) * (kept / maxV), dropH = (B - T) * (drop / maxV);
      x.fillStyle = "#34ffa6"; x.fillRect(L + i * bw + 1, B - keptH, bw - 2, keptH);
      x.fillStyle = "#e2726b"; x.globalAlpha = 0.8; x.fillRect(L + i * bw + 1, B - keptH - dropH, bw - 2, dropH); x.globalAlpha = 1;
    }
    x.fillStyle = "#90c0ac"; x.font = "9px monospace"; x.textAlign = "left";
    x.fillText("0", L, h - 5); x.textAlign = "right"; x.fillText(String(hist.edges[hist.edges.length - 1]), R, h - 5);
    hit.current = { L, bw, n };
  }, [hist]);
  useEffect(() => { draw(); }, [draw]);
  return (
    <div className="relative w-full h-full"
      onMouseMove={(e) => {
        const c = cv.current; if (!c || !hit.current || !hist) return;
        const { L, bw, n } = hit.current;
        const r = c.getBoundingClientRect(); const mx = e.clientX - r.left;
        const i = Math.floor((mx - L) / bw);
        if (i < 0 || i >= n) { setHover(null); return; }
        setHover({ x: mx, y: e.clientY - r.top, w: r.width, h: r.height, i });
      }}
      onMouseLeave={() => setHover(null)}>
      <canvas ref={cv} className="w-full h-full" />
      {hover && hist && (
        <HoverBox x={hover.x} y={hover.y} w={hover.w} h={hover.h}>
          <div>{hist.edges[hover.i]}–{hist.edges[hover.i + 1]} tok</div>
          <div><span className="text-[#34ffa6]">kept {hist.kept[hover.i]}</span> · <span className="text-[#e2726b]">dropped {hist.dropped[hover.i]}</span></div>
        </HoverBox>
      )}
    </div>
  );
}

// ---- model-vs-model delta fingerprint: what a run actually changed, per (layer,
// module) — B@A*(alpha/r), the real weight delta the trainer merges into the base.
// Not a raw-weight visualization (no natural "shape" to a weight matrix) — this is
// a genuine, physically-meaningful, cheap-to-compute comparison across runs. ----
export type AdapterDelta = { name: string; modules: string[]; matrix: number[][] };

export function DeltaHeatmap({ data, vmax }: { data: AdapterDelta; vmax: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const hit = useRef<{ L: number; T: number; cw: number; ch: number; nRows: number; nCols: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; w: number; h: number; layer: number; mod: number } | null>(null);
  const draw = useCallback(() => {
    const c = cv.current; if (!c) return;
    const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr; const x = c.getContext("2d")!; x.scale(dpr, dpr); x.clearRect(0, 0, w, h);
    const L = 4, T = 14, R = w - 4, B = h - 4;
    const nRows = data.matrix.length, nCols = data.modules.length;
    const cw = (R - L) / nCols, ch = (B - T) / nRows;
    data.matrix.forEach((row, ri) => {
      row.forEach((v, ci) => {
        const t = vmax > 0 ? Math.min(1, v / vmax) : 0;
        const rr = Math.round(16 + t * (52 - 16)), gg = Math.round(35 + t * (255 - 35)), bb = Math.round(30 + t * (166 - 30));
        x.fillStyle = `rgb(${rr},${gg},${bb})`;
        x.fillRect(L + ci * cw, T + ri * ch, Math.ceil(cw) + 0.5, Math.ceil(ch) + 0.5);
      });
    });
    x.fillStyle = "#90c0ac"; x.font = "8px monospace"; x.textAlign = "center";
    data.modules.forEach((m, ci) => x.fillText(m.replace("_proj", ""), L + (ci + 0.5) * cw, 10));
    hit.current = { L, T, cw, ch, nRows, nCols };
  }, [data, vmax]);
  useEffect(() => { draw(); }, [draw]);
  return (
    <div className="relative w-full h-full"
      onMouseMove={(e) => {
        const c = cv.current; if (!c || !hit.current) return;
        const { L, T, cw, ch, nRows, nCols } = hit.current;
        const r = c.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
        const ci = Math.floor((mx - L) / cw), ri = Math.floor((my - T) / ch);
        if (ci < 0 || ci >= nCols || ri < 0 || ri >= nRows) { setHover(null); return; }
        setHover({ x: mx, y: my, w: r.width, h: r.height, layer: ri, mod: ci });
      }}
      onMouseLeave={() => setHover(null)}>
      <canvas ref={cv} className="w-full h-full" />
      {hover && (
        <HoverBox x={hover.x} y={hover.y} w={hover.w} h={hover.h}>
          <div>{data.name} · layer {hover.layer}</div>
          <div>{data.modules[hover.mod]}: {data.matrix[hover.layer][hover.mod].toFixed(4)}</div>
        </HoverBox>
      )}
    </div>
  );
}

// ---- delta evolution over training: layer x step x magnitude, a REAL third axis
// (not the same snapshot data redrawn taller — height already fully encodes what a
// heatmap's color does). Hand-rolled wireframe surface (no 3D lib in this project);
// drag to orbit, since a static 3D projection is close to unreadable without it. ----
export type AdapterEvolution = { name: string; modules: string[]; steps: number[]; series: number[][][] };

export function DeltaSurface3D({ data, module }: { data: AdapterEvolution; module: string | "all" }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [yaw, setYaw] = useState(0.6);
  const [pitch, setPitch] = useState(0.55);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const hit = useRef<{ sx: number; sy: number; layer: number; step: number; v: number }[]>([]);
  const [hover, setHover] = useState<{ x: number; y: number; w: number; h: number; p: (typeof hit.current)[number] } | null>(null);

  const grid = (() => {
    const modIdx = module === "all" ? -1 : data.modules.indexOf(module);
    const nLayers = data.series[0]?.length ?? 0;
    const nSteps = data.steps.length;
    const g: number[][] = [];
    for (let l = 0; l < nLayers; l++) {
      const row: number[] = [];
      for (let s = 0; s < nSteps; s++) {
        const cells = data.series[s]?.[l] ?? [];
        row.push(modIdx >= 0 ? (cells[modIdx] ?? 0) : cells.reduce((a, b) => a + b, 0));
      }
      g.push(row);
    }
    return { g, nLayers, nSteps };
  })();

  const draw = useCallback(() => {
    const c = cv.current; if (!c) return;
    const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr; const x = c.getContext("2d")!; x.scale(dpr, dpr); x.clearRect(0, 0, w, h);
    const { g, nLayers, nSteps } = grid;
    if (!nLayers || nSteps < 2) {
      x.fillStyle = "#7fa896"; x.font = "10px monospace"; x.textAlign = "center";
      x.fillText(nSteps < 2 ? "needs 2+ snapshots — enable snapshots on the next run" : "no data", w / 2, h / 2);
      return;
    }
    let vmax = 1e-6; g.forEach((row) => row.forEach((v) => { if (v > vmax) vmax = v; }));

    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // both horizontal axes normalized to the SAME footprint regardless of point count —
    // without this, a run with few snapshots (say 5) plotted against 36 layers comes out
    // ~7x longer on one axis than the other: a thin sliver, not a landscape.
    const FOOTPRINT = 11;
    const scale = Math.min(w, h) / (FOOTPRINT * 2.6);
    const project = (lx: number, sz: number, val: number) => {
      const px = (nLayers > 1 ? lx / (nLayers - 1) - 0.5 : 0) * FOOTPRINT * 2;
      const pz = (nSteps > 1 ? sz / (nSteps - 1) - 0.5 : 0) * FOOTPRINT * 2;
      const py = -(val / vmax) * FOOTPRINT * 0.7;
      // yaw around vertical axis, then pitch around horizontal axis
      const x1 = px * cy - pz * sy, z1 = px * sy + pz * cy;
      const y2 = py * cp - z1 * sp, z2 = py * sp + z1 * cp;
      const depth = z2;
      const persp = 1 + depth * 0.02;
      return { sx: w / 2 + x1 * scale * persp, sy: h / 2 + y2 * scale * persp * 1.3, depth };
    };

    type Quad = { pts: { sx: number; sy: number }[]; depth: number; v: number };
    const quads: Quad[] = [];
    for (let l = 0; l < nLayers - 1; l++) {
      for (let s = 0; s < nSteps - 1; s++) {
        const p00 = project(l, s, g[l][s]), p10 = project(l + 1, s, g[l + 1][s]);
        const p11 = project(l + 1, s + 1, g[l + 1][s + 1]), p01 = project(l, s + 1, g[l][s + 1]);
        const avgV = (g[l][s] + g[l + 1][s] + g[l + 1][s + 1] + g[l][s + 1]) / 4;
        const avgDepth = (p00.depth + p10.depth + p11.depth + p01.depth) / 4;
        quads.push({ pts: [p00, p10, p11, p01], depth: avgDepth, v: avgV });
      }
    }
    quads.sort((a, b) => a.depth - b.depth); // painter's algorithm: far first, near last

    quads.forEach((q) => {
      const t = Math.min(1, q.v / vmax);
      const rr = Math.round(16 + t * (52 - 16)), gg = Math.round(35 + t * (255 - 35)), bb = Math.round(30 + t * (166 - 30));
      x.beginPath();
      q.pts.forEach((p, i) => (i ? x.lineTo(p.sx, p.sy) : x.moveTo(p.sx, p.sy)));
      x.closePath();
      x.fillStyle = `rgb(${rr},${gg},${bb})`; x.fill();
      x.strokeStyle = "rgba(6,14,11,0.35)"; x.lineWidth = 0.5; x.stroke();
    });

    // axis captions (approximate, since axes tilt with the drag)
    x.fillStyle = "#90c0ac"; x.font = "9px monospace"; x.textAlign = "left";
    x.fillText("layer 0 -> " + (nLayers - 1), 6, h - 8);
    x.textAlign = "right";
    x.fillText(`step ${data.steps[0]} -> ${data.steps[nSteps - 1]}`, w - 6, h - 8);

    const pts: typeof hit.current = [];
    for (let l = 0; l < nLayers; l++) for (let s = 0; s < nSteps; s++) {
      const p = project(l, s, g[l][s]);
      pts.push({ sx: p.sx, sy: p.sy, layer: l, step: data.steps[s], v: g[l][s] });
    }
    hit.current = pts;
  }, [grid, yaw, pitch, data.steps]);

  useEffect(() => { draw(); }, [draw]);

  return (
    <div className="relative w-full h-full">
      <canvas ref={cv} className="w-full h-full cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; }}
        onMouseMove={(e) => {
          const c = cv.current; if (!c) return;
          const r = c.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
          if (drag.current) {
            const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
            drag.current = { x: e.clientX, y: e.clientY };
            setYaw((v) => v + dx * 0.01);
            setPitch((v) => Math.max(0.05, Math.min(1.5, v + dy * 0.01)));
            setHover(null);
            return;
          }
          let best = null, bestDist = Infinity;
          for (const p of hit.current) { const d = (p.sx - mx) ** 2 + (p.sy - my) ** 2; if (d < bestDist) { bestDist = d; best = p; } }
          if (best && bestDist < 400) setHover({ x: mx, y: my, w: r.width, h: r.height, p: best }); else setHover(null);
        }}
        onMouseUp={() => { drag.current = null; }}
        onMouseLeave={() => { drag.current = null; setHover(null); }}
      />
      {hover && (
        <HoverBox x={hover.x} y={hover.y} w={hover.w} h={hover.h}>
          <div>layer {hover.p.layer} · step {hover.p.step}</div>
          <div>{module === "all" ? "sum" : module}: {hover.p.v.toFixed(4)}</div>
        </HoverBox>
      )}
    </div>
  );
}

// ---- concept galaxy: real hidden-state embeddings of a fixed prompt set, projected
// through a FIXED PCA basis (fit once, pre-training) so movement across snapshots
// means something — not a per-frame UMAP refit's artifact, and not fabricated
// coordinates. Trails show each point's path up to the currently-viewed step. ----
export type GalaxySnapshot = { step: number; points: number[][] };

export function ConceptGalaxy3D({ snapshots, categories, labels, upToIndex }: {
  snapshots: GalaxySnapshot[]; categories: string[]; labels: string[]; upToIndex: number;
}) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [yaw, setYaw] = useState(0.7);
  const [pitch, setPitch] = useState(0.5);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const uniqueCats = Array.from(new Set(categories));
  const hit = useRef<{ sx: number; sy: number; p: number }[]>([]);
  const [hover, setHover] = useState<{ x: number; y: number; w: number; h: number; p: number } | null>(null);

  const draw = useCallback(() => {
    const c = cv.current; if (!c) return;
    const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr; const x = c.getContext("2d")!; x.scale(dpr, dpr); x.clearRect(0, 0, w, h);
    const idx = Math.min(upToIndex, snapshots.length - 1);
    if (idx < 0) { x.fillStyle = "#7fa896"; x.font = "10px monospace"; x.textAlign = "center"; x.fillText("no embedding snapshots yet", w / 2, h / 2); return; }

    const all = snapshots.slice(0, idx + 1).flatMap((s) => s.points.flat());
    const span = Math.max(1e-6, ...all.map(Math.abs));
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const scale = (Math.min(w, h) / 2.4) / span;
    const project = (p: number[]) => {
      const [px, py0, pz] = p;
      const x1 = px * cy - pz * sy, z1 = px * sy + pz * cy;
      const y2 = py0 * cp - z1 * sp, z2 = py0 * sp + z1 * cp;
      const persp = 1 + z2 * 0.15 / span;
      return { sx: w / 2 + x1 * scale * persp, sy: h / 2 + y2 * scale * persp, depth: z2 };
    };

    const nPoints = snapshots[0]?.points.length ?? 0;
    const hitPts: typeof hit.current = [];
    for (let p = 0; p < nPoints; p++) {
      const color = PALETTE[uniqueCats.indexOf(categories[p]) % PALETTE.length];
      // trail: faint line through this point's history up to the viewed step
      x.strokeStyle = color; x.globalAlpha = 0.35; x.lineWidth = 1; x.beginPath();
      for (let s = 0; s <= idx; s++) {
        const pt = project(snapshots[s].points[p]);
        if (s) x.lineTo(pt.sx, pt.sy); else x.moveTo(pt.sx, pt.sy);
      }
      x.stroke(); x.globalAlpha = 1;
      // current position
      const cur = project(snapshots[idx].points[p]);
      x.fillStyle = color;
      x.beginPath(); x.arc(cur.sx, cur.sy, 4, 0, 7); x.fill();
      x.strokeStyle = "rgba(255,255,255,0.4)"; x.lineWidth = 1; x.stroke();
      hitPts.push({ sx: cur.sx, sy: cur.sy, p });
    }
    hit.current = hitPts;

    // legend
    let lx = 6; x.font = "9px monospace"; x.textAlign = "left";
    uniqueCats.forEach((cat, i) => {
      const color = PALETTE[i % PALETTE.length];
      x.fillStyle = color; x.fillRect(lx, 6, 6, 6);
      x.fillStyle = "#c8ddd2"; x.fillText(cat, lx + 9, 12);
      lx += 9 + x.measureText(cat).width + 12;
    });
    x.fillStyle = "#90c0ac"; x.textAlign = "right";
    x.fillText(`step ${snapshots[idx].step}`, w - 6, h - 6);
  }, [snapshots, categories, uniqueCats, upToIndex, yaw, pitch]);

  useEffect(() => { draw(); }, [draw]);
  // idle drift — the same slow view rotation as the gradient terrain; data is fixed
  useEffect(() => {
    let raf = 0;
    const tick = () => { if (!drag.current && !hover) setYaw((v) => v + 0.0022); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hover]);
  const idxSafe = Math.min(upToIndex, snapshots.length - 1);

  return (
    <div className="relative w-full h-full">
      <canvas ref={cv} className="w-full h-full cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; }}
        onMouseMove={(e) => {
          const c = cv.current; if (!c) return;
          const r = c.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
          if (drag.current) {
            const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
            drag.current = { x: e.clientX, y: e.clientY };
            setYaw((v) => v + dx * 0.01);
            setPitch((v) => Math.max(0.05, Math.min(1.5, v + dy * 0.01)));
            setHover(null);
            return;
          }
          let best = null, bestDist = Infinity;
          for (const p of hit.current) { const d = (p.sx - mx) ** 2 + (p.sy - my) ** 2; if (d < bestDist) { bestDist = d; best = p; } }
          if (best && bestDist < 100) setHover({ x: mx, y: my, w: r.width, h: r.height, p: best.p }); else setHover(null);
        }}
        onMouseUp={() => { drag.current = null; }}
        onMouseLeave={() => { drag.current = null; setHover(null); }}
      />
      {hover && idxSafe >= 0 && (
        <HoverBox x={hover.x} y={hover.y} w={hover.w} h={hover.h}>
          <div style={{ color: PALETTE[uniqueCats.indexOf(categories[hover.p]) % PALETTE.length] }}><b>{categories[hover.p]}</b></div>
          <div className="whitespace-normal">{labels[hover.p]}</div>
          <div>step {snapshots[idxSafe].step}</div>
        </HoverBox>
      )}
    </div>
  );
}

// ---- live sample-vs-target diff: what the model actually says, periodically ----
// When per-token certitude is present, each generated token is tinted by its
// UNCERTAINTY (1 − chosen-token probability) — confident text reads plain, shaky
// text glows. Hover a token for its exact p and entropy. Real logits, no theatre.
export function ProbePanel({ row }: { row?: LossRow }) {
  if (!row) return <div className="text-[11px] text-[var(--muted)]">— no probe yet —</div>;
  if (row.error) return <div className="text-[11px] text-[var(--accent-danger)]">probe failed: {row.error}</div>;
  const hasCert = Array.isArray(row.tokens) && Array.isArray(row.probs) && row.tokens.length === row.probs.length && row.tokens.length > 0;
  const meanP = hasCert ? row.probs!.reduce((a, b) => a + b, 0) / row.probs!.length : null;
  return (
    <div className="text-[11px] leading-relaxed space-y-2">
      <div><span className="uppercase tracking-widest text-[9px] text-[var(--muted)]">prompt</span>
        <div className="text-[var(--text-2)] font-mono whitespace-pre-wrap">{row.prompt}</div></div>
      <div className="grid grid-cols-2 gap-3">
        <div><span className="uppercase tracking-widest text-[9px] text-[var(--muted)]">target</span>
          <div className="text-[var(--text-2)] font-mono whitespace-pre-wrap">{row.target}</div></div>
        <div>
          <span className="uppercase tracking-widest text-[9px] text-[var(--accent-ai)]">model @ step {row.step}</span>
          {meanP != null && <span className="ml-2 text-[9px] text-[var(--muted)]">certitude {Math.round(meanP * 100)}% · tint = uncertainty</span>}
          {hasCert ? (
            <div className="text-[var(--text)] font-mono whitespace-pre-wrap">
              {row.tokens!.map((t, i) => (
                <span key={i}
                  title={`p=${row.probs![i]}${row.entropy?.[i] != null ? ` · H=${row.entropy[i]} nats` : ""}`}
                  style={{ backgroundColor: `rgba(255,107,157,${(0.55 * (1 - row.probs![i])).toFixed(3)})`, borderRadius: 2 }}>
                  {t}
                </span>
              ))}
            </div>
          ) : (
            <div className="text-[var(--text)] font-mono whitespace-pre-wrap">{row.generated}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- gradient terrain: layer_gnorm as a 3D ridge surface, step (x) × layer (z),
// height ∝ √(‖g‖/max) — sqrt is a display transform so spikes don't flatten the
// floor; the hover tooltip reports the exact raw value. Slow idle auto-rotation,
// drag to steer. Same fixed data → same terrain: nothing is animated but the view. ----
export function GradientTerrain3D({ rows, maxCols = 90 }: { rows: LossRow[]; maxCols?: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const yawRef = useRef(0.65);
  const [pitch, setPitch] = useState(0.42);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; w: number; h: number; step: number; layer: number; v: number } | null>(null);
  const hit = useRef<{ sx: number; sy: number; step: number; layer: number; v: number }[]>([]);

  const draw = useCallback(() => {
    const c = cv.current; if (!c) return;
    const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr; const x = c.getContext("2d")!; x.scale(dpr, dpr); x.clearRect(0, 0, w, h);
    const st = rows.filter((r) => r.event === "step" && Array.isArray(r.layer_gnorm) && r.layer_gnorm!.length);
    if (!st.length) { x.fillStyle = "#7fa896"; x.font = "10px monospace"; x.textAlign = "center"; x.fillText("awaiting per-layer gradients", w / 2, h / 2); return; }
    const cols = st.slice(-maxCols);
    const nLayers = cols[0].layer_gnorm!.length;
    let vmax = 0;
    cols.forEach((s) => s.layer_gnorm!.forEach((v) => { if (v > vmax) vmax = v; }));
    vmax = vmax || 1;

    const yaw = yawRef.current;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const span = 1.15;
    const scale = Math.min(w, h) / (2.6 * span);
    const project = (gx: number, gy: number, gz: number) => {
      const x1 = gx * cy - gz * sy, z1 = gx * sy + gz * cy;
      const y2 = gy * cp - z1 * sp, z2 = gy * sp + z1 * cp;
      const persp = 1 + z2 * 0.18 / span;
      return { sx: w / 2 + x1 * scale * persp, sy: h / 2 + 14 + y2 * scale * persp, depth: z2 };
    };
    // grid coords in [-1,1]; height sqrt-normalized into [0, 0.85]
    const gx = (ci: number) => (cols.length < 2 ? 0 : (ci / (cols.length - 1)) * 2 - 1);
    const gz = (li: number) => (nLayers < 2 ? 0 : (li / (nLayers - 1)) * 2 - 1);
    const gy = (v: number) => -Math.sqrt(Math.min(1, v / vmax)) * 0.85;

    // painter's algorithm over layers: draw the ridge furthest from camera first
    const order = Array.from({ length: nLayers }, (_, i) => i)
      .sort((a, b) => project(0, 0, gz(a)).depth - project(0, 0, gz(b)).depth);
    const hitPts: typeof hit.current = [];
    for (const li of order) {
      const base = cols.map((s, ci) => project(gx(ci), 0, gz(li)));
      const crest = cols.map((s, ci) => project(gx(ci), gy(s.layer_gnorm![li]), gz(li)));
      // fill under the ridge — translucent so rear layers glow through
      x.beginPath();
      crest.forEach((p, i) => (i ? x.lineTo(p.sx, p.sy) : x.moveTo(p.sx, p.sy)));
      for (let i = base.length - 1; i >= 0; i--) x.lineTo(base[i].sx, base[i].sy);
      x.closePath();
      const depth01 = (order.indexOf(li) + 1) / nLayers; // nearer → brighter
      x.fillStyle = `rgba(52,255,166,${(0.05 + depth01 * 0.10).toFixed(3)})`;
      x.fill();
      // crest line, phosphor ramp by that layer's own peak (identity = position, magnitude = color)
      const peak = Math.max(...cols.map((s) => s.layer_gnorm![li])) / vmax;
      const t = Math.sqrt(Math.min(1, peak));
      x.strokeStyle = `rgb(${Math.round(16 + t * 36)},${Math.round(90 + t * 165)},${Math.round(70 + t * 96)})`;
      x.lineWidth = 1.2; x.globalAlpha = 0.5 + depth01 * 0.5;
      x.beginPath();
      crest.forEach((p, i) => (i ? x.lineTo(p.sx, p.sy) : x.moveTo(p.sx, p.sy)));
      x.stroke(); x.globalAlpha = 1;
      crest.forEach((p, ci) => hitPts.push({ sx: p.sx, sy: p.sy, step: cols[ci].step!, layer: li, v: cols[ci].layer_gnorm![li] }));
    }
    hit.current = hitPts;
    x.fillStyle = "#90c0ac"; x.font = "9px monospace"; x.textAlign = "left";
    x.fillText(`${nLayers} layers × last ${cols.length} steps · height ∝ √‖g‖ · max ${vmax.toFixed(3)}`, 6, 12);
  }, [rows, maxCols, pitch]);

  // slow idle rotation — pure view motion over fixed real data; pauses while dragging
  useEffect(() => {
    let raf = 0;
    const tick = () => { if (!drag.current && !hover) { yawRef.current += 0.0022; draw(); } raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [draw, hover]);
  useEffect(() => { draw(); }, [draw]);

  return (
    <div className="relative w-full h-full">
      <canvas ref={cv} className="w-full h-full cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; }}
        onMouseMove={(e) => {
          const c = cv.current; if (!c) return;
          const r = c.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
          if (drag.current) {
            const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
            drag.current = { x: e.clientX, y: e.clientY };
            yawRef.current += dx * 0.01;
            setPitch((v) => Math.max(0.08, Math.min(1.35, v + dy * 0.01)));
            setHover(null); draw();
            return;
          }
          let best = null, bestDist = Infinity;
          for (const p of hit.current) { const d = (p.sx - mx) ** 2 + (p.sy - my) ** 2; if (d < bestDist) { bestDist = d; best = p; } }
          if (best && bestDist < 90) setHover({ x: mx, y: my, w: r.width, h: r.height, step: best.step, layer: best.layer, v: best.v }); else setHover(null);
        }}
        onMouseUp={() => { drag.current = null; }}
        onMouseLeave={() => { drag.current = null; setHover(null); }}
      />
      {hover && (
        <HoverBox x={hover.x} y={hover.y} w={hover.w} h={hover.h}>
          <div><b>layer {hover.layer}</b> · step {hover.step}</div>
          <div>‖g‖ = {hover.v}</div>
        </HoverBox>
      )}
    </div>
  );
}
