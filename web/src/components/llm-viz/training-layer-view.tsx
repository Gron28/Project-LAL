"use client";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import type { ModelArchitecture } from "@/lib/gguf-meta";
import type { LayerValues } from "./model-3d";
import { useArchitecture } from "./architecture-panel";

const Model3D = dynamic(() => import("./model-3d").then((m) => m.Model3D), { ssr: false, loading: () => <div className="grid h-full place-items-center text-[13px] text-[var(--text-muted)]">Loading 3D view…</div> });
const LayerStrip = dynamic(() => import("./model-3d").then((m) => m.LayerStrip), { ssr: false });

type StepRow = { event: string; step?: number; layer_gnorm?: number[] };
type Mode = "step" | "first" | "change";

/** When the run's own GGUF isn't built yet, draw a uniform stack with the right
 * layer count (the gradients say how many blocks there are) — labelled as such. */
function uniformArchitecture(n: number): ModelArchitecture {
  return {
    architecture: "training run", name: null, embedding: null, feedForward: null, heads: 8, kvHeads: 8, context: null, vocab: null,
    experts: null, expertsUsed: null, totalParams: n, embeddingParams: 0, outputParams: 0, quantMix: {}, fileType: null,
    layers: Array.from({ length: n }, (_, index) => ({ index, kind: "attention" as const, params: 1, moe: false, modules: { attn: 1, ffn: 1 }, quant: "LoRA",
      // Placeholder matrices (not the real shapes — the run's GGUF isn't built yet).
      tensors: [{ module: "attn_q", shape: [2048, 2048], type: "F16" }, { module: "attn_k", shape: [2048, 512], type: "F16" }, { module: "attn_v", shape: [2048, 512], type: "F16" }, { module: "attn_output", shape: [2048, 2048], type: "F16" }, { module: "ffn_up", shape: [2048, 5632], type: "F16" }, { module: "ffn_down", shape: [5632, 2048], type: "F16" }] })),
  };
}

/** Where the model is learning: per-layer gradient norms painted onto the 3D
 * layer stack, scrubbable across steps, with a first-vs-latest comparison. */
export function TrainingLayerView({ rows, runName }: { rows: StepRow[]; runName: string | null }) {
  const steps = useMemo(() => rows.filter((r) => r.event === "step" && Array.isArray(r.layer_gnorm) && r.layer_gnorm.length), [rows]);
  const { arch: built } = useArchitecture(runName);
  const [mode, setMode] = useState<Mode>("step");
  const [scrub, setScrub] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const n = steps[0]?.layer_gnorm?.length ?? 0;
  const arch = useMemo(() => built && built.layers.length === n ? built : n ? uniformArchitecture(n) : null, [built, n]);
  const at = scrub == null ? steps.length - 1 : Math.min(scrub, steps.length - 1);
  const values = useMemo<LayerValues | null>(() => {
    if (!steps.length) return null;
    const first = steps[0].layer_gnorm!, cur = steps[at].layer_gnorm!;
    if (mode === "first") return { label: `Gradient norm · step ${steps[0].step}`, values: first };
    if (mode === "change") return { label: `Change in gradient norm · step ${steps[0].step} → ${steps[at].step}`, values: cur.map((v, i) => v - (first[i] ?? 0)), diverging: true };
    return { label: `Gradient norm · step ${steps[at].step}`, values: cur };
  }, [steps, at, mode]);

  if (!arch || !values) {
    return <div className="grid h-40 place-items-center text-[13px] text-[var(--text-muted)]">The 3D layer view lights up once the trainer reports per-layer gradients.</div>;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Layer view mode" className="seg">
          <button role="tab" aria-selected={mode === "step"} onClick={() => setMode("step")}>Step</button>
          <button role="tab" aria-selected={mode === "first"} onClick={() => setMode("first")}>Before (first step)</button>
          <button role="tab" aria-selected={mode === "change"} onClick={() => setMode("change")}>Before → after</button>
        </div>
        {mode !== "first" && steps.length > 1 && (
          <label className="flex flex-1 min-w-[200px] items-center gap-3 text-[12px] text-[var(--text-secondary)]">
            <span className="shrink-0">Step {steps[at].step}</span>
            <input type="range" min={0} max={steps.length - 1} value={at} onChange={(e) => setScrub(+e.target.value === steps.length - 1 ? null : +e.target.value)} className="flex-1 accent-[var(--brand-gold)]" aria-label="Training step" />
            <span className="shrink-0 text-[var(--text-muted)]">{scrub == null ? "live" : `of ${steps[steps.length - 1].step}`}</span>
          </label>
        )}
        {arch.architecture === "training run" && <span className="text-[11px] text-[var(--text-muted)]">Uniform stack: this run’s model file isn’t built yet</span>}
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="surface overflow-hidden"><Model3D arch={arch} values={values} selected={selected} onSelect={setSelected} height={360} /></div>
        <div className="flex flex-col justify-end gap-2">
          <p className="text-[12px] leading-snug text-[var(--text-secondary)]">Brighter layers are receiving larger updates. Learning concentrated in a few layers is normal for LoRA; a single layer spiking far above the rest can mean instability.</p>
          <LayerStrip values={values} selected={selected} onSelect={setSelected} height={120} />
        </div>
      </div>
    </div>
  );
}
