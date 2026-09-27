"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { ModelArchitecture } from "@/lib/gguf-meta";

const ModelScene = dynamic(() => import("./model-3d").then((m) => m.ModelScene), { ssr: false, loading: () => <div className="grid h-full place-items-center text-[13px] text-[var(--text-muted)]">Loading 3D view…</div> });

const MAX = 4;

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

/** Side-by-side architecture comparison: every chosen model as one row of the
 * same 3D skyline (one shared scale), plus the numbers in a table so the
 * differences can be read exactly, not only seen. */
export function ComparePanel({ models, initial }: { models: string[]; initial: string[] }) {
  const [picked, setPicked] = useState<string[]>(initial.slice(0, MAX));
  const [archs, setArchs] = useState<Record<string, ModelArchitecture | { error: string }>>({});
  useEffect(() => {
    for (const name of picked) {
      if (archs[name]) continue;
      fetch(`/api/models/architecture?model=${encodeURIComponent(name)}`)
        .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j.architecture as ModelArchitecture; })
        .then((a) => setArchs((cur) => ({ ...cur, [name]: a })))
        .catch((e) => setArchs((cur) => ({ ...cur, [name]: { error: e instanceof Error ? e.message : String(e) } })));
    }
  }, [picked, archs]);
  const toggle = (name: string) => setPicked((cur) => cur.includes(name) ? cur.filter((x) => x !== name) : cur.length >= MAX ? cur : [...cur, name]);
  const ready = picked.map((name) => ({ name, a: archs[name] })).filter((x): x is { name: string; a: ModelArchitecture } => !!x.a && !("error" in x.a));
  const rows: [string, (a: ModelArchitecture) => string][] = [
    ["Parameters", (a) => fmt(a.totalParams)],
    ["Layers", (a) => { const lin = a.layers.filter((l) => l.kind === "linear-attention" || l.kind === "ssm").length; return lin ? `${a.layers.length} (${lin} linear)` : String(a.layers.length); }],
    ["Hidden size", (a) => fmt(a.embedding)],
    ["Feed-forward", (a) => a.feedForward && a.embedding ? `${fmt(a.feedForward)} (${(a.feedForward / a.embedding).toFixed(1)}×)` : fmt(a.feedForward)],
    ["Heads · KV", (a) => a.heads ? `${a.heads} · ${a.kvHeads ?? a.heads}${a.kvHeads && a.heads !== a.kvHeads ? ` (GQA ${a.heads / a.kvHeads}:1)` : ""}` : "—"],
    ["Experts", (a) => a.experts ? `${a.experts} · ${a.expertsUsed ?? "?"} active` : "dense"],
    ["Context", (a) => fmt(a.context)],
    ["Vocabulary", (a) => fmt(a.vocab)],
    ["Quantization", (a) => a.fileType ?? "—"],
  ];
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Models to compare (up to ${MAX})`}>
        {models.map((name) => {
          const on = picked.includes(name);
          return <button key={name} type="button" aria-pressed={on} onClick={() => toggle(name)} disabled={!on && picked.length >= MAX}
            className="rounded-[var(--radius-pill)] border px-3 py-1 text-[12px] transition-colors disabled:opacity-40"
            style={{ borderColor: on ? "var(--border-focus)" : "var(--border-subtle)", background: on ? "var(--bg-selected)" : "transparent", color: on ? "var(--text-accent)" : "var(--text-secondary)" }}>{name}</button>;
        })}
      </div>
      {picked.map((n) => archs[n] && "error" in archs[n] ? <p key={n} className="text-[12px] text-[var(--status-error)]">{n}: {(archs[n] as { error: string }).error}</p> : null)}
      {ready.length > 0 ? <>
        <div className="surface overflow-hidden"><ModelScene models={ready.map(({ name, a }) => ({ arch: a, label: name }))} height={Math.min(640, 300 + ready.length * 90)} /></div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead><tr className="text-left text-[11px] text-[var(--text-muted)]"><th className="py-1.5 pr-4 font-normal"></th>{ready.map(({ name }) => <th key={name} className="py-1.5 pr-4 font-medium text-[var(--text-primary)]">{name}</th>)}</tr></thead>
            <tbody>{rows.map(([label, f]) => (
              <tr key={label} className="border-t border-[var(--border-subtle)]"><td className="py-1.5 pr-4 text-[var(--text-muted)]">{label}</td>{ready.map(({ name, a }) => <td key={name} className="py-1.5 pr-4 tabular-nums">{f(a)}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      </> : <p className="text-[13px] text-[var(--text-muted)]">{picked.length ? "Reading model headers…" : "Pick models above to compare them."}</p>}
    </div>
  );
}
