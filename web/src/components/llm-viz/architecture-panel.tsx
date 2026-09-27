"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import type { ModelArchitecture } from "@/lib/gguf-meta";
import type { LayerValues } from "./model-3d";

// three.js only loads when a model view is actually opened.
const Model3D = dynamic(() => import("./model-3d").then((m) => m.Model3D), { ssr: false, loading: () => <div className="grid h-full place-items-center text-[13px] text-[var(--text-muted)]">Loading 3D view…</div> });
const LayerStrip = dynamic(() => import("./model-3d").then((m) => m.LayerStrip), { ssr: false });

function fmt(n: number | null | undefined, unit = "") {
  if (n == null) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B${unit}`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M${unit}`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K${unit}`;
  return `${n}${unit}`;
}

export function useArchitecture(model: string | null) {
  const [state, setState] = useState<{ arch: ModelArchitecture | null; error: string | null; loading: boolean }>({ arch: null, error: null, loading: false });
  useEffect(() => {
    if (!model) return;
    let alive = true;
    const t = setTimeout(() => setState({ arch: null, error: null, loading: true }), 0);
    fetch(`/api/models/architecture?model=${encodeURIComponent(model)}`)
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j.architecture as ModelArchitecture; })
      .then((arch) => { if (alive) setState({ arch, error: null, loading: false }); })
      .catch((e) => { if (alive) setState({ arch: null, error: e instanceof Error ? e.message : String(e), loading: false }); });
    return () => { alive = false; clearTimeout(t); };
  }, [model]);
  return state;
}

/** Model details: real architecture numbers, the 3D layer stack, and a
 * per-layer parameter strip. Everything comes from the GGUF header. */
export function ArchitecturePanel({ model, values }: { model: string; values?: LayerValues | null }) {
  const { arch, error, loading } = useArchitecture(model);
  const [selected, setSelected] = useState<number | null>(null);
  const paramStrip = useMemo<LayerValues | null>(() => arch ? { label: "Parameters per layer", values: arch.layers.map((l) => l.params) } : null, [arch]);
  if (error) return <p className="p-3 text-[13px] text-[var(--status-error)]">Architecture unavailable: {error}</p>;
  if (loading || !arch) return <p className="p-3 text-[13px] text-[var(--text-muted)]">Reading the model header…</p>;
  const layer = selected != null ? arch.layers[selected] : null;
  const hybrid = arch.layers.filter((l) => l.kind === "linear-attention" || l.kind === "ssm").length;
  const specs: [string, string][] = [
    ["Architecture", arch.architecture],
    ["Parameters", fmt(arch.totalParams)],
    ["Layers", hybrid ? `${arch.layers.length} (${hybrid} linear-attention)` : String(arch.layers.length)],
    ["Hidden size", fmt(arch.embedding)],
    ["Feed-forward", fmt(arch.feedForward)],
    ["Attention heads", arch.heads ? `${arch.heads} · ${arch.kvHeads ?? arch.heads} KV` : "—"],
    ["Context", arch.context ? `${fmt(arch.context)} tokens` : "—"],
    ["Vocabulary", fmt(arch.vocab)],
    ...(arch.experts ? [["Experts", `${arch.experts} · ${arch.expertsUsed ?? "?"} active`] as [string, string]] : []),
    ["Quantization", arch.fileType ?? Object.entries(arch.quantMix).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—"],
  ];
  return (
    <div className="grid gap-[var(--gutter)] p-3 xl:grid-cols-[260px_minmax(0,1fr)]">
      <dl className="grid grid-cols-2 xl:grid-cols-1 gap-x-4 gap-y-2 content-start">
        {specs.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[11px] text-[var(--text-muted)]">{k}</dt>
            <dd className="truncate text-[14px] tabular-nums">{v}</dd>
          </div>
        ))}
        {layer && (
          <div className="col-span-2 xl:col-span-1 mt-2 rounded-[var(--radius-md)] bg-[var(--bg-panel-raised)] p-3">
            <div className="text-[13px] font-medium">Layer {layer.index} · {layer.kind}{layer.moe ? " · MoE" : ""}</div>
            <div className="text-[12px] text-[var(--text-muted)]">{fmt(layer.params)} params · {layer.quant}</div>
            <ul className="mt-2 space-y-0.5 text-[12px]">
              {Object.entries(layer.modules).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([m, p]) => (
                <li key={m} className="flex justify-between gap-2"><span className="truncate text-[var(--text-secondary)]">{m}</span><span className="tabular-nums">{fmt(p)}</span></li>
              ))}
            </ul>
          </div>
        )}
      </dl>
      <div className="min-w-0 flex flex-col gap-3">
        <div className="surface overflow-hidden"><Model3D arch={arch} values={values} selected={selected} onSelect={setSelected} height={420} /></div>
        {(values ?? paramStrip) && <LayerStrip values={(values ?? paramStrip)!} selected={selected} onSelect={setSelected} />}
      </div>
    </div>
  );
}
