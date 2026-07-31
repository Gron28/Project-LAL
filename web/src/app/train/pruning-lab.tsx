"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Target = {
  id: string;
  label: string;
  parametersB: number;
  activeB: number;
  experts: number;
  activeExperts: number;
  supported: boolean;
};
type InstalledModel = { name: string; source: "local" | "ollama" | "openvino"; gb: number };
type Experiment = {
  id: string;
  name: string;
  model: string;
  prunePercent: number;
  noisePercent: number;
  seed: number;
  samples: number;
  maxSequenceLength: number;
  calibrationFile: string;
  status: "planned" | "running" | "done" | "failed" | "stopped";
  retainedExperts: number;
  estimatedParametersB: number;
  estimatedBf16GiB: number;
  estimatedQ4GiB: number;
  error?: string;
};
type Payload = {
  runtime: { available: boolean; activeExperimentId: string | null };
  targets: Target[];
  installedModels: InstalledModel[];
  datasets: string[];
  experiments: Experiment[];
  log?: Array<Record<string, unknown>>;
};

const field = "w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--border-loud)]";
const label = "block text-[10px] tracking-widest uppercase text-[var(--muted)] mb-1.5";
const card = "bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)]";

function statusColor(status: Experiment["status"]): string {
  if (status === "done") return "var(--accent-success)";
  if (status === "failed") return "var(--accent-danger)";
  if (status === "running") return "var(--accent-warn)";
  return "var(--text-2)";
}

export default function PruningLab() {
  const [data, setData] = useState<Payload | null>(null);
  const [model, setModel] = useState("Qwen/Qwen3-30B-A3B-Instruct-2507");
  const [name, setName] = useState("qwen3-code-reap");
  const [calibrationFile, setCalibrationFile] = useState("");
  const [prunePercent, setPrunePercent] = useState(50);
  const [noisePercent, setNoisePercent] = useState(0);
  const [seed, setSeed] = useState(42);
  const [samples, setSamples] = useState(128);
  const [maxSequenceLength, setMaxSequenceLength] = useState(1024);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [testModel, setTestModel] = useState("");
  const [testPrompt, setTestPrompt] = useState("Implement a correct LRU cache and explain the complexity.");
  const [testResult, setTestResult] = useState<{ model: string; backend: string; text: string; elapsedMs: number; tokensPerSecond: number | null } | null>(null);

  const load = useCallback(async () => {
    const query = selectedId ? `?id=${encodeURIComponent(selectedId)}` : "";
    const value = await fetch(`/api/train/pruning${query}`, { cache: "no-store" }).then((response) => response.json()) as Payload;
    setData(value);
    setCalibrationFile((current) => current || value.datasets[0] || "");
    setTestModel((current) => current || value.installedModels[0]?.name || "");
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    const query = selectedId ? `?id=${encodeURIComponent(selectedId)}` : "";
    fetch(`/api/train/pruning${query}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((value: Payload) => {
        if (!active) return;
        setData(value);
        setCalibrationFile((current) => current || value.datasets[0] || "");
        setTestModel((current) => current || value.installedModels[0]?.name || "");
      })
      .catch(() => {});
    return () => { active = false; };
  }, [selectedId]);
  useEffect(() => {
    if (!data?.runtime.activeExperimentId) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [data?.runtime.activeExperimentId, load]);

  const target = data?.targets.find((item) => item.id === model);
  const estimate = useMemo(() => {
    if (!target) return null;
    const retainedExperts = Math.max(target.activeExperts, Math.round(target.experts * (1 - prunePercent / 100)));
    const retainedRatio = 0.12 + 0.88 * retainedExperts / target.experts;
    return {
      retainedExperts,
      parametersB: +(target.parametersB * retainedRatio).toFixed(2),
      bf16GiB: +(target.parametersB * retainedRatio * 2 / 1.073741824).toFixed(2),
      q4GiB: +(target.parametersB * retainedRatio * 0.55 / 1.073741824).toFixed(2),
    };
  }, [prunePercent, target]);

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/train/pruning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok || value.error) throw new Error(value.error || "request failed");
    return value;
  };

  const savePlan = async () => {
    setBusy("plan"); setMessage("");
    try {
      const value = await post({ action: "plan", name, model, calibrationFile, prunePercent, noisePercent, seed, samples, maxSequenceLength });
      setSelectedId(value.experiment.id);
      setMessage("Experiment plan saved.");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(""); }
  };

  const start = async (id: string) => {
    setBusy(id); setMessage("");
    try {
      await post({ action: "start", id });
      setSelectedId(id);
      setMessage("Pruning started. This can take hours and uses disk offload.");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(""); }
  };

  const stop = async () => {
    setBusy("stop");
    try { await post({ action: "stop" }); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(""); }
  };

  const test = async () => {
    setBusy("test"); setMessage(""); setTestResult(null);
    try {
      const value = await post({ action: "test", model: testModel, prompt: testPrompt, maxTokens: 256 });
      setTestResult(value.result);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(""); }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className={card}>
        <div className="px-4 py-3 border-b border-[var(--border-soft)] flex items-center gap-2">
          <span className="text-[var(--accent-ai)]">◆</span>
          <span className="text-[11px] tracking-widest uppercase">Structural pruning lab</span>
          <span className="ml-auto text-[10px]" style={{ color: data?.runtime.available ? "var(--accent-success)" : "var(--accent-danger)" }}>
            {data?.runtime.available ? "REAP runtime ready" : "runtime missing"}
          </span>
        </div>
        <div className="p-4 grid xl:grid-cols-[1.1fr_0.9fr] gap-5">
          <div className="space-y-4">
            <div className="grid md:grid-cols-2 gap-3">
              <div><label className={label}>Experiment name</label><input className={field} value={name} onChange={(event) => setName(event.target.value)} /></div>
              <div><label className={label}>Large source model</label><select className={field} value={model} onChange={(event) => setModel(event.target.value)}>{data?.targets.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.parametersB}B total / {item.activeB}B active</option>)}</select></div>
            </div>
            <div><label className={label}>Code calibration dataset</label><select className={field} value={calibrationFile} onChange={(event) => setCalibrationFile(event.target.value)}><option value="">Select a .jsonl dataset</option>{data?.datasets.map((item) => <option key={item}>{item}</option>)}</select></div>

            <Slider labelText="Structural expert pruning" value={prunePercent} onChange={setPrunePercent} color="var(--accent-ai)" note="Removes complete MoE experts. THIS is what actually reduces the runnable checkpoint." />
            <Slider labelText="Random holes / noise control" value={noisePercent} onChange={setNoisePercent} color="var(--accent-warn)" note="Zeros random weights after pruning. Useful as an ablation, but dense file size does NOT shrink." />

            <div className="grid grid-cols-3 gap-3">
              <div><label className={label}>Seed</label><input className={field} type="number" value={seed} onChange={(event) => setSeed(+event.target.value)} /></div>
              <div><label className={label}>Samples</label><input className={field} type="number" min={8} max={2048} value={samples} onChange={(event) => setSamples(+event.target.value)} /></div>
              <div><label className={label}>Tokens/sample</label><input className={field} type="number" min={128} max={4096} value={maxSequenceLength} onChange={(event) => setMaxSequenceLength(+event.target.value)} /></div>
            </div>
            <div className="flex items-center gap-3">
              <button disabled={busy !== "" || !data?.runtime.available} onClick={savePlan} className="px-4 py-2 rounded-[var(--r-md)] bg-[var(--accent-ai)] text-[var(--bg)] text-xs font-bold disabled:opacity-40">{busy === "plan" ? "Saving…" : "Save experiment plan"}</button>
              <span className="text-[10px] text-[var(--muted)]">{message}</span>
            </div>
          </div>

          <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-4 space-y-4">
            <div className="text-[10px] tracking-widest uppercase text-[var(--muted)]">Projected shape</div>
            {target && estimate && <>
              <Metric label="Experts retained" value={`${estimate.retainedExperts} / ${target.experts}`} percent={100 * estimate.retainedExperts / target.experts} color="var(--accent-ai)" />
              <Metric label="Parameters retained" value={`${estimate.parametersB}B / ${target.parametersB}B`} percent={100 * estimate.parametersB / target.parametersB} color="var(--accent-success)" />
              <div className="grid grid-cols-3 gap-2">
                <MiniStat label="BF16 estimate" value={`${estimate.bf16GiB} GiB`} />
                <MiniStat label="Q4 estimate" value={`${estimate.q4GiB} GiB`} />
                <MiniStat label="Active/token" value={`${target.activeB}B`} />
              </div>
              <div className="text-[10px] leading-relaxed text-[var(--muted)]">
                The estimator preserves a conservative 12% floor for embeddings, routers and attention. Actual size is measured after saving and conversion.
              </div>
            </>}
          </div>
        </div>
      </div>

      <div className="grid xl:grid-cols-[1.15fr_0.85fr] gap-4">
        <div className={card}>
          <div className="px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase">Experiments</div>
          <div className="p-3 space-y-2 max-h-[430px] overflow-auto">
            {!data?.experiments.length && <div className="text-xs text-[var(--muted)] p-3">No pruning plans yet.</div>}
            {data?.experiments.map((experiment) => (
              <button key={experiment.id} onClick={() => setSelectedId(experiment.id)} className="w-full text-left border rounded-[var(--r-md)] p-3 hover:border-[var(--border-loud)]" style={{ borderColor: selectedId === experiment.id ? "var(--accent-ai)" : "var(--border)" }}>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{experiment.name}</span>
                  <span className="text-[9px] uppercase tracking-widest" style={{ color: statusColor(experiment.status) }}>{experiment.status}</span>
                  <span className="ml-auto text-[10px] text-[var(--muted)]">{experiment.prunePercent}% experts · {experiment.noisePercent}% holes</span>
                </div>
                <div className="text-[10px] text-[var(--muted)] mt-1">{experiment.retainedExperts} experts · ~{experiment.estimatedParametersB}B params · ~{experiment.estimatedQ4GiB} GiB Q4</div>
                {experiment.error && <div className="text-[10px] text-[var(--accent-danger)] mt-1">{experiment.error}</div>}
                <div className="flex gap-2 mt-2" onClick={(event) => event.stopPropagation()}>
                  {experiment.status !== "running" && experiment.status !== "done" && <button onClick={() => start(experiment.id)} disabled={busy !== "" || !!data.runtime.activeExperimentId || !experiment.calibrationFile} className="px-2.5 py-1 rounded bg-[var(--accent-ai)] text-[var(--bg)] text-[10px] font-bold disabled:opacity-40">{busy === experiment.id ? "Starting…" : "Start"}</button>}
                  {experiment.status === "running" && <button onClick={stop} disabled={busy !== ""} className="px-2.5 py-1 rounded bg-[var(--accent-danger)] text-white text-[10px] font-bold">Stop</button>}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className={card}>
          <div className="px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase">Live pruning log</div>
          <div className="p-3 h-[430px] overflow-auto font-mono text-[10px] leading-relaxed text-[var(--text-2)]">
            {data?.log?.length ? data.log.map((row, index) => <div key={index}>{row.event === "phase" ? `▸ ${String(row.phase)}` : row.event === "plan" ? `plan: ${String(row.retained_experts)} experts, ~${String(row.estimated_q4_gib)} GiB Q4` : row.event === "error" ? `ERROR: ${String(row.message)}` : JSON.stringify(row)}</div>) : <span className="text-[var(--muted)]">Select an experiment to inspect its log.</span>}
          </div>
        </div>
      </div>

      <div className={card}>
        <div className="px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase">Quick behavior test</div>
        <div className="p-4 grid xl:grid-cols-2 gap-4">
          <div className="space-y-3">
            <div><label className={label}>Installed runnable model</label><select className={field} value={testModel} onChange={(event) => setTestModel(event.target.value)}>{data?.installedModels.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.source} · {item.gb}GB</option>)}</select></div>
            <div><label className={label}>Test prompt</label><textarea className={`${field} min-h-28 resize-y`} value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} /></div>
            <button onClick={test} disabled={busy !== "" || !testModel || !testPrompt.trim()} className="px-4 py-2 rounded-[var(--r-md)] border border-[var(--accent-ai)] text-[var(--accent-ai)] text-xs font-bold disabled:opacity-40">{busy === "test" ? "Running…" : "Run quick test"}</button>
          </div>
          <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-3 min-h-48 overflow-auto">
            {testResult ? <>
              <div className="text-[10px] text-[var(--muted)] mb-2">{testResult.model} · {testResult.backend} · {(testResult.elapsedMs / 1000).toFixed(1)}s{testResult.tokensPerSecond ? ` · ${testResult.tokensPerSecond} tok/s` : ""}</div>
              <pre className="whitespace-pre-wrap text-xs leading-relaxed font-mono">{testResult.text}</pre>
            </> : <span className="text-xs text-[var(--muted)]">Run the same prompt against installed baselines now; converted pruned checkpoints will appear here once imported into LAL.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Slider({ labelText, value, onChange, color, note }: { labelText: string; value: number; onChange: (value: number) => void; color: string; note: string }) {
  return <div>
    <div className="flex items-center justify-between mb-1"><label className={label + " mb-0"}>{labelText}</label><span className="font-mono text-sm" style={{ color }}>{value}%</span></div>
    <input className="w-full accent-[var(--accent-ai)]" type="range" min={0} max={90} step={5} value={value} onChange={(event) => onChange(+event.target.value)} />
    <div className="text-[10px] text-[var(--muted)] mt-1">{note}</div>
  </div>;
}

function Metric({ label: text, value, percent, color }: { label: string; value: string; percent: number; color: string }) {
  return <div>
    <div className="flex justify-between text-[10px] mb-1"><span className="text-[var(--muted)]">{text}</span><span>{value}</span></div>
    <div className="h-2 bg-[var(--surface-3)] rounded-full overflow-hidden"><div className="h-full rounded-full transition-all" style={{ width: `${Math.max(0, Math.min(100, percent))}%`, background: color }} /></div>
  </div>;
}

function MiniStat({ label: text, value }: { label: string; value: string }) {
  return <div className="bg-[var(--surface-3)] rounded-[var(--r-md)] p-2"><div className="text-[9px] uppercase tracking-widest text-[var(--muted)]">{text}</div><div className="text-sm font-semibold mt-1">{value}</div></div>;
}
