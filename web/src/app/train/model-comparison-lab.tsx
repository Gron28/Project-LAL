"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type QueueItem = { model: string; suite: string; status: "queued" | "running" | "completed" | "failed"; error?: string };
type State = {
  status: "ready" | "running" | "completed" | "failed";
  models: string[];
  missingModels: string[];
  acquisitionBudgetGb: number;
  suites: string[];
  queue: QueueItem[];
  startedAt?: number;
  completedAt?: number;
  analysis?: { model: string; passed: number; total: number; qualityPct: number; tokSec: number | null; latencyMs: number | null; note: string }[];
};

const card = "bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)]";
const button = "inline-flex items-center justify-center gap-1.5 border border-[var(--border)] rounded-[var(--r-md)] px-3 py-2 text-[11px] text-[var(--text-2)] hover:border-[var(--border-loud)] disabled:opacity-40";

function colour(status: QueueItem["status"]) {
  return status === "completed" ? "var(--accent-success)" : status === "running" ? "var(--accent-ai)" : status === "failed" ? "var(--accent-danger)" : "var(--text-2)";
}

export default function ModelComparisonLab() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    try { setState(await fetch("/api/train/comparison", { cache: "no-store" }).then((response) => response.json()) as State); }
    catch { setMessage("Could not load the comparison queue."); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (state?.status !== "running") return;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [state?.status, load]);

  const progress = useMemo(() => {
    const rows = state?.queue ?? [];
    return { total: rows.length, done: rows.filter((item) => item.status === "completed" || item.status === "failed").length };
  }, [state]);
  const mutate = async (action: "prepare" | "start") => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/train/comparison", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const body = await response.json() as State & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error || "request failed");
      setState(body);
      setMessage(action === "prepare" ? "Queue rebuilt from the selected installed models." : "Comparison started. Models run one at a time; results will be compiled automatically.");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const missing = state?.missingModels ?? [];
  return <div className="flex flex-col gap-4">
    <section className={card + " p-4"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="text-[10px] uppercase tracking-[0.16em] text-[var(--accent-ai)]">Tomorrow-ready evaluation</div><h2 className="mt-1 text-base font-semibold">Local model comparison queue</h2><p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-[var(--muted)]">Every model receives the same coding, planning, research-synthesis, agentic tool-use, instruction-following, and browser-verified HTML tasks. The runner unloads and activates one backend at a time, persists each suite result, then ranks the completed matrix by quality and runtime telemetry.</p></div>
        <div className="flex gap-2"><button className={button} disabled={busy || state?.status === "running"} onClick={() => void mutate("prepare")}>Refresh queue</button><button className="inline-flex items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-ai)] px-3 py-2 text-[11px] font-bold text-[var(--bg)] disabled:opacity-40" disabled={busy || state?.status === "running" || !state?.models.length} onClick={() => void mutate("start")}>{state?.status === "running" ? "Comparison running…" : "Start comparison"}</button></div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-3 text-[11px]"><div className="rounded border border-[var(--border-soft)] p-2"><span className="text-[var(--muted)]">Models</span><div className="mt-1 text-lg font-semibold">{state?.models.length ?? "—"}</div></div><div className="rounded border border-[var(--border-soft)] p-2"><span className="text-[var(--muted)]">Queue progress</span><div className="mt-1 text-lg font-semibold">{progress.done}/{progress.total}</div></div><div className="rounded border border-[var(--border-soft)] p-2"><span className="text-[var(--muted)]">Benchmark families</span><div className="mt-1 text-lg font-semibold">{state?.suites.length ?? "—"}</div></div></div>
      <p className="mt-3 text-[11px] text-[var(--muted)]">Model-acquisition budget: {state?.acquisitionBudgetGb ?? 30} GB total. This queue never downloads models; only installed models are runnable.</p>
      {missing.length > 0 && <p className="mt-1 text-[11px] text-[var(--accent-warn)]">Not installed and not queued: {missing.join(", ")}.</p>}
      {message && <p className="mt-3 text-[11px] text-[var(--text-2)]">{message}</p>}
    </section>

    <section className={card + " overflow-hidden"}><div className="border-b border-[var(--border-soft)] px-4 py-3 text-[10px] uppercase tracking-widest text-[var(--text-2)]">Execution queue</div><div className="max-h-72 overflow-auto divide-y divide-[var(--border-soft)]">{state?.queue.map((item, index) => <div key={`${item.model}:${item.suite}:${index}`} className="flex items-center gap-3 px-4 py-2.5 text-[11px]"><span className="w-2 h-2 rounded-full" style={{ background: colour(item.status) }} /><span className="min-w-0 flex-1 truncate">{item.model}</span><span className="w-28 text-[var(--muted)]">{item.suite}</span><span style={{ color: colour(item.status) }}>{item.status}</span>{item.error && <span className="max-w-52 truncate text-[var(--accent-danger)]" title={item.error}>{item.error}</span>}</div>) ?? <div className="p-4 text-[11px] text-[var(--muted)]">Loading queue…</div>}</div></section>

    {state?.analysis && <section className={card + " overflow-hidden"}><div className="flex items-center gap-3 border-b border-[var(--border-soft)] px-4 py-3"><div className="text-[10px] uppercase tracking-widest text-[var(--text-2)]">Compiled analysis</div><Link className="ml-auto text-[11px] text-[var(--accent-ai)] hover:underline" href="/benchmark">Open full evidence</Link></div><div className="overflow-auto"><table className="w-full text-[11px]"><thead className="text-[9px] uppercase tracking-widest text-[var(--muted)]"><tr><th className="px-4 py-3 text-left">Model</th><th>Quality</th><th>Passes</th><th>Speed</th><th>Latency</th></tr></thead><tbody>{state.analysis.map((row, index) => <tr key={row.model} className="border-t border-[var(--border-soft)]"><td className="px-4 py-3">{index === 0 ? "★ " : ""}{row.model}<div className="mt-1 text-[9px] text-[var(--muted)]">{row.note}</div></td><td className="text-center font-semibold">{row.qualityPct}%</td><td className="text-center">{row.passed}/{row.total}</td><td className="text-center">{row.tokSec ?? "—"} tok/s</td><td className="text-center">{row.latencyMs ?? "—"} ms</td></tr>)}</tbody></table></div></section>}
  </div>;
}
