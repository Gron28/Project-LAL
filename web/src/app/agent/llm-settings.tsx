"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getVoice, setVoice } from "./voice";

type Options = {
  contextTokens: number;
  maxOutputTokens: number;
  gpuLayers: number | null;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  thinking: boolean;
};

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
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="w-40 accent-[var(--accent-ai)]" />
    </Row>
  );
}

function Num({ label, hint, value, onChange }: { label: string; hint?: string; value: number; onChange: (v: number) => void }) {
  return (
    <Row label={label} hint={hint}>
      <input type="number" value={value} onChange={(e) => onChange(parseInt(e.target.value, 10))} className="w-24 text-right bg-[var(--bg,#0c0c0c)] border border-[var(--border)] rounded-[var(--r-sm)] px-2 py-1 text-xs text-white outline-none" />
    </Row>
  );
}

export default function LlmSettings({
  open, onClose, model, models, onModelChange, think, onThinkChange,
}: {
  open: boolean;
  onClose: () => void;
  model: string;
  models: string[];
  onModelChange: (m: string) => void;
  think: boolean;
  onThinkChange: (v: boolean) => void;
}) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const [voice, setVoiceState] = useState("sam");
  const [system, setSystem] = useState("");

  useEffect(() => {
    // Sync from localStorage when the panel opens — not derivable at render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) setVoiceState(getVoice());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    fetch("/api/agent/models")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j?.modelSettings?.[model]) { setOpts(j.modelSettings[model]); onThinkChange(!!j.modelSettings[model].thinking); } if (j?.system !== undefined) setSystem(j.system ?? ""); })
      .catch(() => {});
  }, [open, model, onThinkChange]);

  const saveSystem = (s: string) => {
    fetch("/api/agent/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ system: s }) })
      .then(() => setSavedAt(Date.now()))
      .catch(() => {});
  };

  const save = (patch: Partial<Options>) => {
    setOpts((o) => (o ? { ...o, ...patch } : o));
    fetch("/api/agent/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelSettings: { model, values: patch } }) })
      .then(() => setSavedAt(Date.now()))
      .catch(() => {});
  };

  const saveThinking = (value: boolean) => {
    onThinkChange(value);
    save({ thinking: value });
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md bg-[var(--surface-1)] border border-[var(--border)] rounded-t-[var(--r-lg)] sm:rounded-[var(--r-lg)] max-h-[88vh] overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-between px-4 h-12 border-b border-[var(--border-soft)] sticky top-0 bg-[var(--surface-1)] z-10">
          <span className="text-sm font-semibold">LLM settings</span>
          <button onClick={onClose} aria-label="Close" className="text-[var(--muted)] hover:text-white p-1"><X size={18} /></button>
        </div>
        <div className="p-4 space-y-4">
          <Row label="Model" hint="Heavier models reason better but need more VRAM. Lower GPU layers if a big model crashes.">
            <select value={model} onChange={(e) => onModelChange(e.target.value)} className="max-w-[55%] text-xs bg-[var(--bg,#0c0c0c)] border border-[var(--border)] rounded-[var(--r-sm)] px-2 py-1 text-white outline-none">
              {model && !models.includes(model) && <option value={model}>{model}</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Row>

          <Row label="Thinking" hint="Model reasons before answering (slower, often better).">
            <button onClick={() => saveThinking(!think)} className={`text-xs border rounded-[var(--r-sm)] px-2.5 py-1 ${think ? "border-[var(--accent-ai)]/50 text-[var(--accent-ai)]" : "border-[var(--border)] text-[var(--muted)]"}`}>
              {think ? "On" : "Off"}
            </button>
          </Row>

          <Row label="Voice (read-aloud)" hint="SAM = retro robotic; SAM clear = old-school but understandable; Standard = the modern system voice.">
            <select
              value={voice}
              onChange={(e) => { setVoiceState(e.target.value); setVoice(e.target.value); }}
              className="text-xs bg-[var(--bg,#0c0c0c)] border border-[var(--border)] rounded-[var(--r-sm)] px-2 py-1 text-white outline-none"
            >
              <option value="sam">SAM (retro)</option>
              <option value="sam-clear">SAM clear</option>
              <option value="system">Standard</option>
            </select>
          </Row>

          <div>
            <label className="text-[13px] text-[var(--text-2)]">System prompt</label>
            <p className="text-[10px] text-[var(--muted)] mt-0.5 mb-1.5 leading-snug">Instructions applied to every reply. Leave empty for default model behavior.</p>
            <textarea
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              onBlur={(e) => saveSystem(e.target.value)}
              rows={4}
              className="w-full resize-y bg-[var(--bg,#0c0c0c)] border border-[var(--border)] rounded-[var(--r-sm)] px-2 py-1.5 text-xs text-white outline-none focus:border-[var(--border-loud)] leading-relaxed font-mono"
              placeholder="e.g. You are a concise assistant. Prefer plain text over markdown."
            />
          </div>

          <div className="border-t border-[var(--border-soft)] pt-3 text-[10px] uppercase tracking-widest text-[var(--muted)]">Performance / memory</div>
          {opts ? (
            <>
              <Slider label="Context size" hint="Per-model context requested by Web and CLI. Larger contexts reload the model with the long-context profile." min={2048} max={262144} step={1024} value={opts.contextTokens} onChange={(v) => save({ contextTokens: v })} />
              <Num label="Max output" hint="-1 = generate until done. Raise to avoid truncated long code." value={opts.maxOutputTokens} onChange={(v) => save({ maxOutputTokens: v })} />
              <Num label="GPU layers" hint="-1 = auto. Lower this to offload layers to CPU when a model cannot fit." value={opts.gpuLayers ?? -1} onChange={(v) => save({ gpuLayers: v < 0 ? null : v })} />

              <div className="border-t border-[var(--border-soft)] pt-3 text-[10px] uppercase tracking-widest text-[var(--muted)]">Sampling</div>
              <Slider label="Temperature" hint="Higher = more creative/random." min={0} max={2} step={0.05} value={opts.temperature} onChange={(v) => save({ temperature: v })} />
              <Slider label="Top P" min={0} max={1} step={0.05} value={opts.topP} onChange={(v) => save({ topP: v })} />
              <Num label="Top K" value={opts.topK} onChange={(v) => save({ topK: v })} />
              <Slider label="Repeat penalty" hint="Higher discourages repetition." min={0} max={2} step={0.05} value={opts.repeatPenalty} onChange={(v) => save({ repeatPenalty: v })} />
            </>
          ) : (
            <p className="text-xs text-[var(--muted)]">Loading…</p>
          )}
          <p className="text-[10px] text-[var(--muted)]">{savedAt ? "Saved ✓ (applies to your next message)" : "Changes save automatically."}</p>
        </div>
      </div>
    </div>
  );
}
