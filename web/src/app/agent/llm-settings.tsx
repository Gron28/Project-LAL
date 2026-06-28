"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getVoice, setVoice } from "./voice";

type Options = {
  num_ctx: number;
  num_predict: number;
  num_gpu: number | null;
  temperature: number;
  top_p: number;
  top_k: number;
  repeat_penalty: number;
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
  const [permMode, setPermMode] = useState("strict");

  useEffect(() => {
    if (open) setVoiceState(getVoice());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    fetch("/api/agent/models")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j?.options) setOpts(j.options); if (j?.permissionMode) setPermMode(j.permissionMode); })
      .catch(() => {});
  }, [open]);

  const savePerm = (m: string) => {
    setPermMode(m);
    fetch("/api/agent/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ permissionMode: m }) })
      .then(() => setSavedAt(Date.now()))
      .catch(() => {});
  };

  const save = (patch: Partial<Options>) => {
    setOpts((o) => (o ? { ...o, ...patch } : o));
    fetch("/api/agent/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ options: patch }) })
      .then(() => setSavedAt(Date.now()))
      .catch(() => {});
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
          <Row label="Model" hint="Heavier models (12B) reason better but can crash this GPU; e4b is stable.">
            <select value={model} onChange={(e) => onModelChange(e.target.value)} className="max-w-[55%] text-xs bg-[var(--bg,#0c0c0c)] border border-[var(--border)] rounded-[var(--r-sm)] px-2 py-1 text-white outline-none">
              {model && !models.includes(model) && <option value={model}>{model}</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Row>

          <Row label="Thinking" hint="Model reasons before answering (slower, often better).">
            <button onClick={() => onThinkChange(!think)} className={`text-xs border rounded-[var(--r-sm)] px-2.5 py-1 ${think ? "border-[var(--accent-ai)]/50 text-[var(--accent-ai)]" : "border-[var(--border)] text-[var(--muted)]"}`}>
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

          <Row label="Permission mode" hint="How much the assistant does without asking. Only affects this chat (you're present); the autonomous runner stays locked down.">
            <select value={permMode} onChange={(e) => savePerm(e.target.value)} className="text-xs bg-[var(--bg,#0c0c0c)] border border-[var(--border)] rounded-[var(--r-sm)] px-2 py-1 text-white outline-none">
              <option value="strict">Strict (approve all)</option>
              <option value="auto-write">Auto writes</option>
              <option value="bypass">Bypass (auto all)</option>
            </select>
          </Row>
          {permMode !== "strict" && (
            <p className="text-[10px] leading-snug text-amber-400/80 -mt-2">
              {permMode === "bypass"
                ? "⚠ Bypass: it sends WhatsApp/email + publishes WITHOUT showing you first. Given the WA-ban history, use briefly and watch it."
                : "Auto writes: tasks / drafts / notes run automatically; sends + publishes still ask first."}
            </p>
          )}

          <div className="border-t border-[var(--border-soft)] pt-3 text-[10px] uppercase tracking-widest text-[var(--muted)]">Performance / memory</div>
          {opts ? (
            <>
              <Slider label="Context size (num_ctx)" hint="Total tokens (prompt + output). Bigger = more room for long output, but more VRAM." min={2048} max={32768} step={1024} value={opts.num_ctx} onChange={(v) => save({ num_ctx: v })} />
              <Num label="Max output (num_predict)" hint="-1 = generate until done. Raise to avoid truncated long code." value={opts.num_predict} onChange={(v) => save({ num_predict: v })} />
              <Num label="GPU layers (num_gpu)" hint="-1 = auto. LOWER this to stop a big model crashing the GPU (offloads layers to CPU, slower but stable)." value={opts.num_gpu ?? -1} onChange={(v) => save({ num_gpu: v < 0 ? null : v })} />

              <div className="border-t border-[var(--border-soft)] pt-3 text-[10px] uppercase tracking-widest text-[var(--muted)]">Sampling</div>
              <Slider label="Temperature" hint="Higher = more creative/random." min={0} max={2} step={0.05} value={opts.temperature} onChange={(v) => save({ temperature: v })} />
              <Slider label="Top P" min={0} max={1} step={0.05} value={opts.top_p} onChange={(v) => save({ top_p: v })} />
              <Num label="Top K" value={opts.top_k} onChange={(v) => save({ top_k: v })} />
              <Slider label="Repeat penalty" hint="Higher discourages repetition." min={1} max={2} step={0.05} value={opts.repeat_penalty} onChange={(v) => save({ repeat_penalty: v })} />
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
