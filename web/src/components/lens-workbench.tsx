"use client";

import { useEffect, useMemo, useState } from "react";
import { BrainCircuit, Layers3, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";

type LensCell = { token: string; prob: number };
type LensResult = { inputTokens: string[]; numLayers: number; grid: LensCell[][][] };

function cellBg(prob: number) {
  const t = Math.max(0, Math.min(1, prob));
  return `color-mix(in srgb, var(--accent-ai) ${Math.round(8 + t * 84)}%, var(--surface-1))`;
}

function cellText(prob: number) {
  return prob > 0.45 ? "#05090c" : "var(--text-2)";
}

function Trajectory({ result, position }: { result: LensResult; position: number }) {
  const width = 520;
  const height = 210;
  const left = 40;
  const right = 16;
  const top = 16;
  const bottom = 30;
  const values = result.grid.map((row) => row[position]?.[0]?.prob ?? 0);
  const x = (i: number) => left + (values.length <= 1 ? 0 : (i / (values.length - 1)) * (width - left - right));
  const y = (v: number) => top + (1 - v) * (height - top - bottom);
  const path = values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={`Prediction confidence across layers at token position ${position + 1}`}>
      <defs>
        <linearGradient id="lens-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent-ai)" stopOpacity="0.32" />
          <stop offset="1" stopColor="var(--accent-ai)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((v) => (
        <g key={v}>
          <line x1={left} x2={width - right} y1={y(v)} y2={y(v)} stroke="var(--border-soft)" />
          <text x={left - 7} y={y(v) + 3} textAnchor="end" fill="var(--muted)" fontSize="9">{Math.round(v * 100)}</text>
        </g>
      ))}
      {values.length > 1 && <path d={`${path} L${x(values.length - 1)},${height - bottom} L${x(0)},${height - bottom} Z`} fill="url(#lens-fill)" />}
      <path d={path} fill="none" stroke="var(--accent-ai)" strokeWidth="2.5" />
      {values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={i === values.length - 1 ? 4 : 2.5} fill={i === values.length - 1 ? "var(--accent-highlight)" : "var(--accent-ai)"} />)}
      <text x={left} y={height - 8} fill="var(--muted)" fontSize="9">L0</text>
      <text x={width - right} y={height - 8} textAnchor="end" fill="var(--muted)" fontSize="9">L{Math.max(0, result.numLayers - 1)}</text>
    </svg>
  );
}

function SummaryStat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0 border-l border-[var(--border-soft)] pl-3 first:border-l-0 first:pl-0">
      <div className="text-[9px] uppercase tracking-[0.16em] text-[var(--muted)]">{label}</div>
      <div className="text-xl font-semibold tracking-tight mt-1">{value}</div>
      <div className="text-[9px] text-[var(--muted)] truncate">{note}</div>
    </div>
  );
}

export default function LensWorkbench({ toolbar }: { toolbar?: React.ReactNode }) {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [topK, setTopK] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<LensResult | null>(null);
  const [hover, setHover] = useState<{ layer: number; pos: number } | null>(null);
  const [position, setPosition] = useState(0);

  useEffect(() => {
    fetch("/api/lens").then((r) => r.json()).then((j) => {
      setModels(j.models || []);
      setModel((current) => current || j.models?.[0] || "");
    }).catch(() => {});
  }, []);

  const summary = useMemo(() => {
    if (!result) return null;
    const tops = result.grid.flatMap((row) => row.map((cell) => cell[0]).filter(Boolean));
    const peak = tops.reduce((best, cell) => cell.prob > best.prob ? cell : best, tops[0] || { token: "—", prob: 0 });
    const mean = tops.length ? tops.reduce((sum, cell) => sum + cell.prob, 0) / tops.length : 0;
    const final = result.grid[result.grid.length - 1]?.map((cell) => cell[0]).filter(Boolean) || [];
    const stable = final.filter((cell) => cell.prob >= 0.5).length;
    return { peak, mean, stable, cells: tops.length };
  }, [result]);

  const run = async () => {
    if (!model || !prompt.trim()) return;
    setBusy(true); setError(""); setResult(null); setHover(null); setPosition(0);
    try {
      const response = await fetch("/api/lens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], topK }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "lens run failed");
      setResult(json.result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid lg:grid-cols-[1.15fr_.85fr] gap-4">
        <Panel className="flex flex-col gap-4">
          {toolbar && <div className="flex items-center border-b border-[var(--border-soft)] pb-3">{toolbar}</div>}
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-[var(--r-md)] bg-[var(--surface-3)] text-[var(--accent-ai)] grid place-items-center shrink-0"><ScanSearch size={18} /></div>
            <div>
              <h2 className="text-base font-semibold tracking-tight">Inspect a model&apos;s internal predictions</h2>
              <p className="text-[11px] text-[var(--text-2)] leading-relaxed mt-1">Project each hidden layer through the model&apos;s own unembedding. The result shows when token hypotheses emerge, disappear, or converge.</p>
            </div>
          </div>
          <div className="grid sm:grid-cols-[1fr_110px] gap-2">
            <div>
              <label className="block text-[9px] uppercase tracking-[0.16em] text-[var(--muted)] mb-1.5">Checkpoint</label>
              <select value={model} onChange={(e) => setModel(e.target.value)} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-2.5 text-xs outline-none focus:border-[var(--border-loud)]">
                {models.map((name) => <option key={name} value={name}>{name}</option>)}
                {!models.length && <option value="">No retained HF checkpoints found</option>}
              </select>
            </div>
            <div>
              <label className="block text-[9px] uppercase tracking-[0.16em] text-[var(--muted)] mb-1.5">Candidates</label>
              <select value={topK} onChange={(e) => setTopK(Number(e.target.value))} className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-2.5 text-xs outline-none focus:border-[var(--border-loud)]">
                {[3, 5, 8, 10].map((k) => <option key={k} value={k}>top-{k}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-[9px] uppercase tracking-[0.16em] text-[var(--muted)] mb-1.5">Prompt</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Enter a prompt whose internal token evolution you want to inspect…" className="w-full min-h-28 bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-3 text-xs leading-relaxed resize-y outline-none focus:border-[var(--border-loud)]" />
          </div>
          <Button active disabled={busy || !model || !prompt.trim()} onClick={run} className="justify-center font-bold text-xs disabled:opacity-40">
            {busy ? "RUNNING LAYER PROJECTION…" : "RUN LOGIT LENS"}
          </Button>
          {error && <p className="text-[11px] text-[var(--accent-danger)] leading-relaxed">{error}</p>}
        </Panel>

        <Panel className="flex flex-col justify-between gap-5 bg-[linear-gradient(145deg,var(--surface-1),color-mix(in_srgb,var(--accent-ai)_7%,var(--surface-1)))]">
          <div>
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-[var(--accent-ai)]"><BrainCircuit size={15} /> Compute contract</div>
            <p className="text-sm leading-relaxed text-[var(--text-2)] mt-4">Lens uses the full retained checkpoint and temporarily claims the whole GPU. Chat, Code, and Hive serving are parked for the run and automatically restored afterward.</p>
          </div>
          <div className="space-y-2 text-[10px] text-[var(--muted)]">
            <div className="flex justify-between border-b border-[var(--border-soft)] pb-2"><span>Compatible models</span><span className="text-[var(--text-2)]">{models.length} retained checkpoints</span></div>
            <div className="flex justify-between border-b border-[var(--border-soft)] pb-2"><span>Projection</span><span className="text-[var(--text-2)]">every layer × input token</span></div>
            <div className="flex justify-between"><span>Expected duration</span><span className="text-[var(--text-2)]">up to several minutes</span></div>
          </div>
        </Panel>
      </div>

      {result && summary && (
        <>
          <Panel>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <SummaryStat label="Projection" value={`${result.numLayers} × ${result.inputTokens.length}`} note={`${summary.cells.toLocaleString()} layer-token cells`} />
              <SummaryStat label="Mean confidence" value={`${(summary.mean * 100).toFixed(1)}%`} note="top prediction across grid" />
              <SummaryStat label="Peak hypothesis" value={`${(summary.peak.prob * 100).toFixed(1)}%`} note={summary.peak.token.trim() || "whitespace token"} />
              <SummaryStat label="Final confidence" value={`${summary.stable}/${result.inputTokens.length}`} note="positions at or above 50%" />
            </div>
          </Panel>

          <div className="grid xl:grid-cols-[1fr_360px] gap-4 items-start">
            <Panel padding="sm" className="min-w-0 overflow-hidden">
              <div className="flex items-start justify-between gap-4 px-2 py-1 mb-3">
                <div>
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-[var(--text-2)]"><Layers3 size={14} className="text-[var(--accent-ai)]" /> Layer × token projection</div>
                  <p className="text-[9px] text-[var(--muted)] mt-1">Click a column to inspect its confidence trajectory. Hover any cell for the full top-{topK}.</p>
                </div>
                <div className="flex items-center gap-1 text-[8px] text-[var(--muted)] shrink-0">
                  <span>0%</span><span className="w-20 h-2 rounded-full" style={{ background: "linear-gradient(90deg, var(--surface-2), var(--accent-ai))" }} /><span>100%</span>
                </div>
              </div>
              <div className="overflow-auto max-h-[66vh] rounded-[var(--r-md)] border border-[var(--border-soft)]">
                <div className="inline-grid min-w-full" style={{ gridTemplateColumns: `48px repeat(${result.inputTokens.length}, minmax(58px, 1fr))` }}>
                  <div className="sticky top-0 left-0 z-20 bg-[var(--surface-1)] border-b border-[var(--border-soft)]" />
                  {result.inputTokens.map((token, i) => (
                    <button key={i} onClick={() => setPosition(i)} className="sticky top-0 z-10 text-[9px] text-center px-1 py-2 truncate border-b border-[var(--border-soft)] bg-[var(--surface-1)]" style={{ color: position === i ? "var(--accent-ai)" : "var(--muted)" }} title={token}>
                      <span className="block text-[7px] opacity-60">{i + 1}</span>{token.trim() || "·"}
                    </button>
                  ))}
                  {result.grid.map((row, layerIdx) => (
                    <div key={layerIdx} className="contents">
                      <div className="sticky left-0 z-10 text-[9px] text-[var(--muted)] flex items-center justify-end pr-2 bg-[var(--surface-1)] border-r border-[var(--border-soft)]">L{layerIdx}</div>
                      {row.map((cell, pos) => {
                        const top = cell[0];
                        const isHover = hover?.layer === layerIdx && hover?.pos === pos;
                        return (
                          <button key={pos} onClick={() => setPosition(pos)} onMouseEnter={() => setHover({ layer: layerIdx, pos })} onMouseLeave={() => setHover(null)}
                            className="relative text-[9px] text-center px-1 py-1.5 border border-[var(--bg)] truncate cursor-crosshair outline-none"
                            style={{ background: top ? cellBg(top.prob) : "var(--surface-1)", color: top ? cellText(top.prob) : "var(--muted)", boxShadow: position === pos ? "inset 0 0 0 1px var(--accent-highlight)" : undefined }}>
                            {top ? (top.token.trim() || "·") : "—"}
                            {isHover && cell.length > 0 && (
                              <span className="absolute z-30 top-full left-1/2 -translate-x-1/2 mt-1 bg-[var(--surface-2)] border border-[var(--border-loud)] rounded-[var(--r-md)] p-2 text-left text-[10px] whitespace-nowrap shadow-2xl pointer-events-none">
                                {cell.map((candidate, i) => <span key={i} className="flex gap-4 justify-between" style={{ color: i === 0 ? "var(--accent-ai)" : "var(--text-2)" }}><span>{candidate.token.trim() || "·"}</span><span>{(candidate.prob * 100).toFixed(1)}%</span></span>)}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </Panel>

            <Panel className="xl:sticky xl:top-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-2)]">Position {position + 1} trajectory</div>
              <div className="text-sm font-semibold mt-1 truncate" title={result.inputTokens[position]}>{result.inputTokens[position]?.trim() || "Whitespace token"}</div>
              <p className="text-[9px] text-[var(--muted)] mt-1">Confidence of the winning hypothesis at this input position across model depth.</p>
              <div className="mt-3"><Trajectory result={result} position={position} /></div>
              <div className="border-t border-[var(--border-soft)] pt-3 mt-2 space-y-2">
                {[0, Math.floor((result.numLayers - 1) / 2), result.numLayers - 1].map((layer) => {
                  const cell = result.grid[layer]?.[position]?.[0];
                  return <div key={layer} className="flex items-center justify-between gap-3 text-[10px]"><span className="text-[var(--muted)]">Layer {layer}</span><span className="truncate text-[var(--text-2)]">{cell?.token.trim() || "·"}</span><span className="font-mono">{cell ? `${(cell.prob * 100).toFixed(1)}%` : "—"}</span></div>;
                })}
              </div>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
