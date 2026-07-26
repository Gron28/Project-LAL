"use client";
// The "dev knobs" panel: everything you'd want on a local agent, in one slide-over.
// Serving/sampling/idle settings persist server-side (/api/agent/models PUT, shared
// with /chat and benchmarks); UX toggles that are purely client behavior
// (auto-continue) are lifted to the page via props so they can also drive the
// composer. Right-side sheet on desktop, bottom sheet on mobile.
import { useEffect, useState } from "react";
import { X, Sliders } from "lucide-react";

type Options = {
  contextTokens: number; maxOutputTokens: number; gpuLayers: number | null;
  temperature: number; topP: number; topK: number; repeatPenalty: number; thinking: boolean;
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-widest text-[var(--muted)] border-b border-[var(--border-soft)] pb-1.5">{title}</div>
      {children}
    </div>
  );
}
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-[13px] text-[var(--text-2)]">{label}</label>
        {children}
      </div>
      {hint && <p className="text-[10px] text-[var(--muted)] mt-1 leading-snug">{hint}</p>}
    </div>
  );
}
function Slider({ label, hint, min, max, step, value, onChange }: { label: string; hint?: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <Row label={`${label}: ${value}`} hint={hint}>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="w-36 accent-[var(--accent-ai)]" />
    </Row>
  );
}
function Num({ label, hint, value, onChange }: { label: string; hint?: string; value: number; onChange: (v: number) => void }) {
  return (
    <Row label={label} hint={hint}>
      <input type="number" value={value} onChange={(e) => onChange(parseInt(e.target.value, 10))} className="w-24 text-right bg-[var(--bg)] border border-[var(--border)] rounded-[var(--r-sm)] px-2 py-1 text-xs text-white outline-none focus:border-[var(--border-loud)]" />
    </Row>
  );
}
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)}
      className={`relative w-10 h-5 rounded-full transition-colors ${on ? "bg-[var(--accent-ai)]" : "bg-[var(--surface-3)]"}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-[var(--bg)] transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

export type AgentSettingsProps = {
  open: boolean;
  onClose: () => void;
  model: string;
  models: string[];
  onModelChange: (m: string) => void;
  think: boolean;
  onThinkChange: (v: boolean) => void;
  auto: boolean;
  onAutoChange: (v: boolean) => void;
  autoContinue: boolean;
  onAutoContinueChange: (v: boolean) => void;
};

export default function AgentSettings(p: AgentSettingsProps) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [system, setSystem] = useState("");
  const [idleMin, setIdleMin] = useState(10);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    if (!p.open) return;
    fetch("/api/agent/models").then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (!j) return;
      if (j.modelSettings?.[p.model]) { setOpts(j.modelSettings[p.model]); p.onThinkChange(!!j.modelSettings[p.model].thinking); }
      if (j.system !== undefined) setSystem(j.system ?? "");
      if (typeof j.serveIdleMinutes === "number") setIdleMin(j.serveIdleMinutes);
    }).catch(() => {});
  // The individual primitive/callback dependencies are intentional; depending
  // on the props object would refetch on every parent render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, p.model, p.onThinkChange]);

  const put = (body: Record<string, unknown>) => {
    fetch("/api/agent/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(() => setSavedAt(Date.now())).catch(() => {});
  };
  const saveOpts = (patch: Partial<Options>) => { setOpts((o) => (o ? { ...o, ...patch } : o)); put({ modelSettings: { model: p.model, values: patch } }); };
  const saveThinking = (value: boolean) => { p.onThinkChange(value); saveOpts({ thinking: value }); };

  if (!p.open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-black/50 animate-fade-in" onClick={p.onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-full sm:w-[420px] h-full bg-[var(--surface-1)] border-l border-[var(--border)] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 h-14 border-b border-[var(--border-soft)] shrink-0">
          <span className="flex items-center gap-2 text-sm font-semibold"><Sliders size={16} className="text-[var(--accent-ai)]" /> Agent settings</span>
          <button onClick={p.onClose} className="text-[var(--muted)] hover:text-white p-1"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-6 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          <Section title="Model & behavior">
            <Row label="Model" hint="Heavier models reason better but need more VRAM.">
              <select value={p.model} onChange={(e) => p.onModelChange(e.target.value)} className="max-w-[55%] text-xs bg-[var(--bg)] border border-[var(--border)] rounded-[var(--r-sm)] px-2 py-1 text-white outline-none">
                {p.model && !p.models.includes(p.model) && <option value={p.model}>{p.model}</option>}
                {p.models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Row>
            <Row label="Thinking" hint="Model reasons before answering (slower, usually better).">
              <Toggle on={p.think} onChange={saveThinking} />
            </Row>
            <Row label="Auto-approve tools" hint="Run file/shell/git tools without asking. Convenient, but the agent can change files unprompted.">
              <Toggle on={p.auto} onChange={p.onAutoChange} />
            </Row>
            <Row label="Auto-continue" hint="When a reply is cut off by the token limit, automatically resume it instead of waiting for you to press Continue.">
              <Toggle on={p.autoContinue} onChange={p.onAutoContinueChange} />
            </Row>
          </Section>

          <Section title="Context & output">
            {opts ? <>
              <Slider label="Context size" hint="Per-model window shared with Chat and CLI." min={2048} max={262144} step={1024} value={opts.contextTokens} onChange={(v) => saveOpts({ contextTokens: v })} />
              <Num label="Max output" hint="-1 = until done. Raise to avoid truncated long code/answers." value={opts.maxOutputTokens} onChange={(v) => saveOpts({ maxOutputTokens: v })} />
              <Num label="GPU layers" hint="-1 = auto. Lower to offload to CPU." value={opts.gpuLayers ?? -1} onChange={(v) => saveOpts({ gpuLayers: v < 0 ? null : v })} />
            </> : <p className="text-xs text-[var(--muted)]">Loading…</p>}
          </Section>

          <Section title="Sampling">
            {opts && <>
              <Slider label="Temperature" hint="Higher = more creative/varied." min={0} max={2} step={0.05} value={opts.temperature} onChange={(v) => saveOpts({ temperature: v })} />
              <Slider label="Top P" min={0} max={1} step={0.05} value={opts.topP} onChange={(v) => saveOpts({ topP: v })} />
              <Num label="Top K" value={opts.topK} onChange={(v) => saveOpts({ topK: v })} />
              <Slider label="Repeat penalty" hint="Higher discourages repetition." min={0} max={2} step={0.05} value={opts.repeatPenalty} onChange={(v) => saveOpts({ repeatPenalty: v })} />
            </>}
          </Section>

          <Section title="GPU power">
            <Slider label="Idle auto-unload (min)" hint="Unload the model from the GPU after this long with no activity (0 = never). Stops idle power draw." min={0} max={60} step={1} value={idleMin} onChange={(v) => { setIdleMin(v); put({ serveIdleMinutes: v }); }} />
          </Section>

          <Section title="System prompt">
            <textarea value={system} onChange={(e) => setSystem(e.target.value)} onBlur={(e) => put({ system: e.target.value })} rows={4}
              className="w-full resize-y bg-[var(--bg)] border border-[var(--border)] rounded-[var(--r-sm)] px-2 py-1.5 text-xs text-white outline-none focus:border-[var(--border-loud)] leading-relaxed"
              placeholder="Extra standing instructions for every turn (optional)." />
          </Section>

          <p className="text-[10px] text-[var(--muted)]">{savedAt ? "Saved ✓ — applies to your next message." : "Changes save automatically."}</p>
        </div>
      </div>
    </div>
  );
}
