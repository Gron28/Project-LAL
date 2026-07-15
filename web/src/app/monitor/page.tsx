"use client";
import { useEffect, useState, type ReactNode } from "react";

type Sys = {
  cpu: number; ramUsedGb: number; ramTotalGb: number; ramPct: number;
  gpu: number | null; vramUsedGb: number | null; vramTotalGb: number | null; vramPct: number | null;
  cpuTemp: number | null; gpuTemp: number | null; nvmeTemp: number | null; ollamaLoaded: string | null;
  runtime?: {
    serving?: { pid: number | null; alive: boolean; model: string | null; context: number | null; logPath: string };
    activeRuns?: { id: string; kind: string; model: string; startedAt: number; updatedAt: number; executionLocation?: "server" | "client"; ownerDeviceId?: string }[];
    processes?: { pid: number; ppid: number; elapsed: string; state: string; rssKb: number; command: string; kind: string; ownership: string }[];
    processEvents?: { ts: number; event: "observed" | "exited"; process: { pid: number; kind: string; ownership: string; command: string } }[];
  };
};

const card = "bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)]";

function colour(p: number) { return p >= 90 ? "var(--accent-danger)" : p >= 70 ? "var(--accent-warn)" : "var(--accent-ai)"; }

function Bar({ label, pct, detail }: { label: string; pct: number | null; detail: ReactNode }) {
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
            <Bar label="CPU" pct={s.cpu} detail={<>· {temp(s.cpuTemp)}</>} />
            <Bar label="RAM" pct={s.ramPct} detail={`${s.ramUsedGb} / ${s.ramTotalGb} GB`} />
            <Bar label="GPU" pct={s.gpu} detail={<>· {temp(s.gpuTemp)}</>} />
            <Bar label="VRAM" pct={s.vramPct} detail={s.vramTotalGb ? `${s.vramUsedGb} / ${s.vramTotalGb} GB` : ""} />
          </> : <div className="text-[var(--muted)] text-xs text-center py-6">reading sensors…</div>}
        </div>
        {s && (
          <div className={card + " p-4 text-xs text-[var(--text-2)] flex flex-col gap-2"}>
            <div className="flex justify-between"><span className="text-[var(--muted)]">CPU temp</span><span>{temp(s.cpuTemp)}</span></div>
            <div className="flex justify-between"><span className="text-[var(--muted)]">GPU temp</span><span>{temp(s.gpuTemp)}</span></div>
            <div className="flex justify-between"><span className="text-[var(--muted)]">NVMe temp</span><span>{temp(s.nvmeTemp)}</span></div>
            <div className="flex justify-between"><span className="text-[var(--muted)]">Other Ollama model loaded</span><span style={{ color: s.ollamaLoaded ? "var(--accent-warn)" : "var(--text-2)" }}>{s.ollamaLoaded || "nothing"}</span></div>
          </div>
        )}
        <div className={card + " overflow-hidden"}>
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
            <div><div className="text-xs font-medium">Active LAL work</div><div className="text-[10px] text-[var(--muted)] mt-0.5">Durable runs are listed separately from processes: a terminal session can be live while its model is idle.</div></div>
            <span className="text-[10px] text-[var(--accent-ai)]">{s?.runtime?.activeRuns?.length ?? 0} active</span>
          </div>
          {s?.runtime?.activeRuns?.length ? <div className="divide-y divide-[var(--border-soft)]">
            {s.runtime.activeRuns.map((run) => {
              const terminal = run.executionLocation === "client";
              return <div key={run.id} className="px-4 py-2.5 grid grid-cols-[auto_1fr_auto] gap-x-3 items-center text-[10px]">
                <span className={terminal ? "text-[var(--accent-warn)]" : "text-[var(--accent-ai)]"}>{terminal ? "terminal" : "host"}</span>
                <span className="min-w-0"><span className="font-medium text-[var(--text-2)]">{run.kind}</span><span className="text-[var(--muted)]"> · {run.model}</span>{terminal && run.ownerDeviceId ? <span className="text-[var(--muted)]"> · {run.ownerDeviceId}</span> : null}</span>
                <span className="text-[var(--muted)] tabular-nums">updated {new Date(run.updatedAt).toLocaleTimeString()}</span>
              </div>;
            })}
          </div> : <div className="px-4 py-6 text-center text-[var(--muted)] text-xs">No LAL run is active.</div>}
          {s?.runtime?.serving?.model && <div className="px-4 py-2 border-t border-[var(--border-soft)] text-[10px] text-[var(--muted)]">Model host: PID {s.runtime.serving.pid ?? "unknown"} · {s.runtime.serving.model} · {s.runtime.serving.context?.toLocaleString() ?? "unknown"} context · <span className="font-mono">{s.runtime.serving.logPath}</span></div>}
        </div>
        <div className={card + " overflow-hidden"}>
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
            <div><div className="text-xs font-medium">Model-capable process inventory</div><div className="text-[10px] text-[var(--muted)] mt-0.5">Known local model hosts, trainers, previews, Ollama, and LAL service processes.</div></div>
            <span className="text-[10px] text-[var(--accent-ai)]">live · 2s</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px] text-left">
              <thead className="text-[var(--muted)] uppercase tracking-wider"><tr><th className="px-4 py-2 font-normal">process</th><th className="px-2 py-2 font-normal">owner</th><th className="px-2 py-2 font-normal">PID</th><th className="px-2 py-2 font-normal">age</th><th className="px-2 py-2 font-normal">memory</th><th className="px-2 py-2 font-normal">command</th></tr></thead>
              <tbody>{s?.runtime?.processes?.length ? s.runtime.processes.map((process) => <tr key={`${process.pid}-${process.command}`} className="border-t border-[var(--border-soft)]"><td className="px-4 py-2 font-medium">{process.kind}</td><td className="px-2 py-2" style={{ color: process.ownership === "managed" ? "var(--accent-ai)" : process.ownership === "external" ? "var(--accent-warn)" : "var(--accent-danger)" }}>{process.ownership}</td><td className="px-2 py-2 tabular-nums">{process.pid}</td><td className="px-2 py-2 tabular-nums">{process.elapsed}</td><td className="px-2 py-2 tabular-nums">{Math.round(process.rssKb / 1024)} MB</td><td className="px-2 py-2 max-w-80 truncate font-mono text-[9px]" title={process.command}>{process.command}</td></tr>) : <tr><td colSpan={6} className="px-4 py-6 text-center text-[var(--muted)]">No known model-capable processes detected.</td></tr>}</tbody>
            </table>
          </div>
        </div>
        <div className={card + " overflow-hidden"}>
          <div className="px-4 py-3 border-b border-[var(--border)]"><div className="text-xs font-medium">Process observation log</div><div className="text-[10px] text-[var(--muted)] mt-0.5">Host observations are retained locally; this is an audit trail, not a claim that every GPU process is detectable.</div></div>
          <div className="max-h-64 overflow-auto divide-y divide-[var(--border-soft)]">{s?.runtime?.processEvents?.length ? s.runtime.processEvents.map((event, index) => <div key={`${event.ts}-${event.process.pid}-${index}`} className="px-4 py-2 text-[10px] grid grid-cols-[auto_auto_1fr] gap-x-2"><span className={event.event === "observed" ? "text-[var(--accent-ai)]" : "text-[var(--muted)]"}>{event.event === "observed" ? "seen" : "exited"}</span><span className="text-[var(--text-2)]">{event.process.kind} · {event.process.pid}</span><span className="truncate font-mono text-[var(--muted)]" title={event.process.command}>{new Date(event.ts).toLocaleString()} · {event.process.command}</span></div>) : <div className="px-4 py-6 text-center text-[var(--muted)] text-xs">No observations recorded yet.</div>}</div>
        </div>
        <p className="text-[10px] text-[var(--muted)] leading-relaxed">Live, updates every 2s. Amber ≥70%, red ≥90%. The inventory recognizes explicitly known executable forms; an unknown process is not proof that no other software is using the GPU.</p>
      </div>
    </div>
  );
}
