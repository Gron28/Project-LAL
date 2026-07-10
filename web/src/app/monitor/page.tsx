"use client";
import { useEffect, useState } from "react";

type Sys = {
  cpu: number; ramUsedGb: number; ramTotalGb: number; ramPct: number;
  gpu: number | null; vramUsedGb: number | null; vramTotalGb: number | null; vramPct: number | null;
  cpuTemp: number | null; gpuTemp: number | null; nvmeTemp: number | null; ollamaLoaded: string | null;
};

const card = "bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)]";

function colour(p: number) { return p >= 90 ? "var(--accent-danger)" : p >= 70 ? "var(--accent-warn)" : "var(--accent-ai)"; }

function Bar({ label, pct, detail }: { label: string; pct: number | null; detail: string }) {
  const p = pct ?? 0;
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-1.5">
        <span className="tracking-widest uppercase text-[var(--text-2)]">{label}</span>
        <span style={{ color: colour(p) }}>{pct == null ? "—" : p + "%"} <span className="text-[var(--muted)]">{detail}</span></span>
      </div>
      <div className="h-2.5 rounded-full bg-[var(--surface-3)] overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: p + "%", background: colour(p) }} />
      </div>
    </div>
  );
}

export default function Monitor() {
  const [s, setS] = useState<Sys | null>(null);
  useEffect(() => {
    let on = true;
    const tick = () => fetch("/api/sysinfo").then((r) => r.json()).then((j) => on && setS(j)).catch(() => {});
    tick(); const t = setInterval(tick, 2000);
    return () => { on = false; clearInterval(t); };
  }, []);

  const temp = (t: number | null) => t == null ? "—" : <span style={{ color: t >= 85 ? "var(--accent-danger)" : t >= 70 ? "var(--accent-warn)" : "var(--text-2)" }}>{t}°C</span>;

  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--text)] px-3 py-4 pb-16">
      <div className="max-w-2xl mx-auto flex flex-col gap-4">
        <h1 className="text-[var(--accent-ai)] tracking-widest font-bold">◉ SYSTEM MONITOR</h1>
        <div className={card + " p-5 flex flex-col gap-5"}>
          {s ? <>
            <Bar label="CPU" pct={s.cpu} detail={`· ${temp(s.cpuTemp) as unknown as string}`} />
            <Bar label="RAM" pct={s.ramPct} detail={`${s.ramUsedGb} / ${s.ramTotalGb} GB`} />
            <Bar label="GPU" pct={s.gpu} detail={`· ${temp(s.gpuTemp) as unknown as string}`} />
            <Bar label="VRAM" pct={s.vramPct} detail={s.vramTotalGb ? `${s.vramUsedGb} / ${s.vramTotalGb} GB` : ""} />
          </> : <div className="text-[var(--muted)] text-xs text-center py-6">reading sensors…</div>}
        </div>
        {s && (
          <div className={card + " p-4 text-xs text-[var(--text-2)] flex flex-col gap-2"}>
            <div className="flex justify-between"><span className="text-[var(--muted)]">CPU temp</span><span>{temp(s.cpuTemp)}</span></div>
            <div className="flex justify-between"><span className="text-[var(--muted)]">GPU temp</span><span>{temp(s.gpuTemp)}</span></div>
            <div className="flex justify-between"><span className="text-[var(--muted)]">NVMe temp</span><span>{temp(s.nvmeTemp)}</span></div>
            <div className="flex justify-between"><span className="text-[var(--muted)]">Ollama (inbox) loaded</span><span style={{ color: s.ollamaLoaded ? "var(--accent-warn)" : "var(--text-2)" }}>{s.ollamaLoaded || "nothing"}</span></div>
          </div>
        )}
        <p className="text-[10px] text-[var(--muted)] leading-relaxed">Live, updates every 2s. Amber ≥70%, red ≥90%. If RAM/VRAM spikes and you didn&apos;t start anything here, it&apos;s usually the inbox&apos;s Ollama loading a big model (shown above) — it unloads when idle.</p>
      </div>
    </div>
  );
}
