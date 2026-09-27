"use client";
// Research mode inside a voice call. The call stays a call — the same talking
// orb, one quiet status line, the spoken words as large subtitles — while the
// images LAL finds drift through a depth field and take turns in focus at the
// centre. Speech in, narration out; the research itself runs server-side
// (lib/research/engine.ts) and streams here over the run ledger.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Square, X } from "lucide-react";
import { enqueueSpeech, stopSpeech } from "@/app/agent/voice";

type Img = { src: string; title: string; pageUrl: string; at: number };
type Phase = "idle" | "starting" | "understanding" | "images" | "searching" | "reading" | "analyzing" | "reflecting" | "summarizing" | "listening" | "waiting" | "done" | "error";

export type CallResearchHandle = { submit: (text: string) => void; active: boolean };

const PHASE_LABEL: Record<Phase, string> = {
  idle: "", starting: "Starting research", understanding: "Understanding the question", images: "Finding images",
  searching: "Searching", reading: "Reading", analyzing: "Analyzing", reflecting: "Connecting the dots",
  summarizing: "Wrapping up", listening: "Heard you", waiting: "Ask a follow-up anytime", done: "Session saved", error: "Something went wrong",
};

const proxied = (src: string) => `/api/agent/research/image?url=${encodeURIComponent(src)}`;

/** Splits streamed narration into sentences so speech starts before the model finishes. */
function takeSentences(buf: string): { done: string[]; rest: string } {
  const done: string[] = [];
  let rest = buf;
  for (;;) {
    const m = rest.match(/^([\s\S]*?[.!?…])(\s+|$)(?=\S|$)/);
    if (!m || m[1].trim().length < 2) break;
    if (!m[2] && rest.length === m[1].length) break; // wait: the sentence may continue
    done.push(m[1].trim());
    rest = rest.slice(m[0].length);
  }
  return { done, rest };
}

export const CallResearch = forwardRef<CallResearchHandle, {
  language: "en" | "es";
  model: string;
  listening: boolean;
  speakingText: string;
  onOrb: () => void;
  onExit: () => void;
  /** Reopen a saved session: restores its images, topic and counts from memory. */
  resumeSessionId?: string | null;
}>(function CallResearch({ language, model, listening, speakingText, onOrb, onExit, resumeSessionId }, ref) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState("");
  const [objective, setObjective] = useState("");
  const [counts, setCounts] = useState({ facts: 0, sources: 0, wave: 0 });
  const [images, setImages] = useState<Img[]>([]);
  const [focus, setFocus] = useState(0);
  const [heard, setHeard] = useState("");
  const buf = useRef("");
  const esRef = useRef<EventSource | null>(null);
  const sessionRef = useRef<string | null>(null);

  const es = language === "es";
  // Greet once on entering research mode — or restore a saved session.
  useEffect(() => {
    if (resumeSessionId) {
      fetch(`/api/agent/research/session?id=${encodeURIComponent(resumeSessionId)}`).then((r) => r.ok ? r.json() : null).then((m) => {
        if (!m) return;
        sessionRef.current = m.id; setSessionId(m.id);
        setObjective(m.objective); setPhase("waiting");
        setCounts({ facts: m.facts.length, sources: m.sources.filter((s: { status: string }) => s.status === "read").length, wave: m.wave });
        setImages((m.images as Img[]).map((i) => ({ ...i, at: 0 })).slice(-40));
      }).catch(() => {});
    } else enqueueSpeech(es ? "¿Qué quieres investigar?" : "What do you want to research?");
    return () => { esRef.current?.close(); };
  }, [es, resumeSessionId]);

  const attach = useCallback((id: string) => {
    esRef.current?.close();
    const source = new EventSource(`/api/agent/runs/${id}/stream`);
    esRef.current = source;
    const flush = (keep?: number) => {
      const text = keep != null ? buf.current.slice(0, keep) : buf.current;
      const { done, rest } = takeSentences(text + " ");
      done.forEach(enqueueSpeech);
      if (keep == null && rest.trim()) enqueueSpeech(rest.trim());
      buf.current = "";
    };
    source.onmessage = (m) => {
      let e: Record<string, unknown>;
      try { e = JSON.parse(m.data); } catch { return; }
      switch (e.k) {
        case "text": {
          buf.current += String(e.v ?? "");
          const { done, rest } = takeSentences(buf.current);
          done.forEach(enqueueSpeech);
          buf.current = rest;
          break;
        }
        case "turn": if (buf.current.trim()) flush(); break;
        case "phase":
          if (e.v === "trim") { buf.current = ""; break; }
          if (buf.current.trim()) flush();
          setPhase(e.v as Phase);
          setDetail(String(e.detail ?? ""));
          break;
        case "plan_updated":
          setObjective(String(e.objective ?? ""));
          setCounts({ facts: Number(e.facts ?? 0), sources: Number(e.sources ?? 0), wave: Number(e.wave ?? 0) });
          break;
        case "artifact":
          if (e.type === "image" && typeof e.src === "string") {
            const img = { src: e.src, title: String(e.title ?? ""), pageUrl: String(e.pageUrl ?? ""), at: Date.now() };
            setImages((cur) => cur.some((x) => x.src === img.src) ? cur : [...cur, img].slice(-40));
          }
          break;
        case "operator_message": setHeard(String(e.text ?? "")); break;
        case "done": if (buf.current.trim()) flush(); setPhase("waiting"); break;
        case "status":
          if (e.v === "error") setPhase("error");
          if (["done", "error", "stopped"].includes(String(e.v))) { source.close(); setRunId(null); }
          break;
      }
    };
  }, []);

  const submit = useCallback(async (text: string) => {
    const t = text.trim(); if (!t) return;
    setHeard(t);
    if (!sessionRef.current) setPhase("starting");
    try {
      const r = await fetch("/api/agent/research/session", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t, sessionId: sessionRef.current, model, language }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      sessionRef.current = j.sessionId; setSessionId(j.sessionId);
      if (!j.queued) { setRunId(j.runId); attach(j.runId); }
    } catch (error) {
      setPhase("error"); setDetail(error instanceof Error ? error.message : String(error));
    }
  }, [attach, language, model]);

  useImperativeHandle(ref, () => ({ submit: (t) => void submit(t), active: true }), [submit]);

  const stop = async () => {
    stopSpeech();
    if (runId) await fetch(`/api/agent/runs/${runId}/stop`, { method: "POST" }).catch(() => {});
    esRef.current?.close(); setRunId(null); setPhase("done");
  };

  // Image focus advances on its own rhythm; a fresh arrival jumps the queue.
  useEffect(() => {
    if (images.length < 2) return;
    const t = setInterval(() => setFocus((f) => (f + 1) % images.length), 5200);
    return () => clearInterval(t);
  }, [images.length]);
  const lastCount = useRef(0);
  useEffect(() => {
    if (images.length > lastCount.current && lastCount.current > 0) {
      const t = setTimeout(() => setFocus(images.length - 1), 0);
      lastCount.current = images.length;
      return () => clearTimeout(t);
    }
    lastCount.current = images.length;
  }, [images.length]);

  const hasImages = images.length > 0;
  const status = phase === "idle" ? "" : `${PHASE_LABEL[phase] ?? phase}${detail && !["waiting", "done"].includes(phase) ? ` · ${detail}` : ""}`;
  const subtitle = speakingText || (listening ? heard || (es ? "Te escucho…" : "Listening…") : phase === "idle" ? (es ? "¿Qué quieres investigar?" : "What do you want to research?") : "");
  const state = listening ? "listening" : speakingText ? "speaking" : phase !== "idle" && phase !== "waiting" && phase !== "done" ? "thinking" : "idle";

  return (
    <div className="fixed inset-0 z-[61] overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)] animate-fade-in">
      <ImageField images={images} focus={focus} />
      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(80% 60% at 50% 45%, transparent 30%, color-mix(in srgb, var(--bg-canvas) 88%, transparent) 100%)" }} />

      <header className="absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-[var(--gutter)]">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[color-mix(in_srgb,var(--bg-panel)_70%,transparent)] px-3 py-1.5 text-[12px] backdrop-blur-md">
            <span className="h-2 w-2 rounded-full bg-[var(--brand-gold)] animate-pulse" /> Research
            {counts.wave > 0 && <span className="text-[var(--text-muted)]">· wave {counts.wave} · {counts.sources} sources · {counts.facts} findings</span>}
          </div>
          {objective && <p className="mt-2 max-w-[60ch] text-[13px] leading-snug text-[var(--text-secondary)] line-clamp-2">{objective}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {runId && <button onClick={stop} className="btn btn-danger px-3 min-h-9 text-xs backdrop-blur-md" aria-label="Stop research"><Square size={12} /> Stop</button>}
          <button onClick={() => { void stop(); onExit(); }} aria-label="Leave research mode" className="grid h-10 w-10 place-items-center rounded-full border border-[var(--border-default)] bg-[color-mix(in_srgb,var(--bg-panel)_70%,transparent)] text-[var(--text-secondary)] backdrop-blur-md hover:text-[var(--text-primary)]"><X size={18} /></button>
        </div>
      </header>

      <div className={"absolute inset-x-0 flex flex-col items-center px-6 transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] " + (hasImages ? "bottom-[max(2rem,env(safe-area-inset-bottom))]" : "top-1/2 -translate-y-1/2")}>
        <Orb state={state} small={hasImages} onClick={onOrb} />
        <p aria-live="polite" className={"mt-6 max-w-[26ch] text-center font-medium leading-[1.15] tracking-[-0.02em] transition-all duration-500 " + (hasImages ? "text-[clamp(20px,3.2vw,34px)]" : "text-[clamp(26px,4.6vw,52px)]") + (speakingText ? " text-[var(--text-primary)]" : " text-[var(--text-secondary)]")}>
          {subtitle}
        </p>
        <p className="mt-3 h-4 text-[12px] uppercase tracking-[0.14em] text-[var(--text-muted)]">{status}</p>
      </div>

      {hasImages && images[focus] && (
        <a href={images[focus].pageUrl || undefined} target="_blank" rel="noreferrer" className="absolute left-[var(--gutter)] bottom-[max(1rem,env(safe-area-inset-bottom))] hidden max-w-[28ch] text-[11px] leading-snug text-[var(--text-muted)] hover:text-[var(--text-secondary)] md:block">
          {images[focus].title || new URL(images[focus].pageUrl || images[focus].src).hostname}
        </a>
      )}
      {!sessionId && <p className="absolute inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] text-center text-[11px] text-[var(--text-muted)]">{es ? "Toca el círculo y habla" : "Tap the circle and speak"}</p>}
    </div>
  );
});

/** The talking circle: the logo gradient as a living sphere. Breathes when idle,
 * ripples outward while listening, pulses with speech, shimmers while thinking. */
function Orb({ state, small, onClick }: { state: "idle" | "listening" | "speaking" | "thinking"; small: boolean; onClick: () => void }) {
  const size = small ? 112 : 208;
  return (
    <button type="button" onClick={onClick} aria-label={state === "listening" ? "Stop listening" : "Tap to talk"} className="relative grid place-items-center transition-[width,height] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]" style={{ width: size, height: size }}>
      {state === "listening" && [0, 1, 2].map((i) => <span key={i} className="orb-ring absolute inset-0 rounded-full border border-[var(--brand-gold)]" style={{ animationDelay: `${i * 0.6}s` }} />)}
      <span className="orb-glow absolute inset-[4%] rounded-full" />
      <span className="absolute inset-[8%] overflow-hidden rounded-full">
        <span className={"orb-core absolute -inset-[30%] " + (state === "speaking" ? "orb-speaking" : state === "thinking" ? "orb-thinking" : "orb-idle")} />
      </span>
      <span className="absolute inset-[8%] rounded-full opacity-60 mix-blend-screen" style={{ background: "radial-gradient(circle at 35% 30%, rgba(255,255,255,.35), transparent 45%)" }} />
    </button>
  );
}

/** Depth field of images: each one drifts in from far away, holds sharp focus at
 * the centre, then flows out past the viewer; the rest float in the background. */
function ImageField({ images, focus }: { images: Img[]; focus: number }) {
  const [reduced, setReduced] = useState(false);
  useEffect(() => { const t = setTimeout(() => setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches), 0); return () => clearTimeout(t); }, []);
  const slots = useMemo(() => images.map((_, i) => {
    // Stable pseudo-random placement per image for the ambient layer.
    const r = (n: number) => { const x = Math.sin((i + 1) * 12.9898 * n) * 43758.5453; return x - Math.floor(x); };
    return { x: (r(1) - 0.5) * 90, y: (r(2) - 0.5) * 70, z: -300 - r(3) * 700, rot: (r(4) - 0.5) * 16, dur: 16 + r(5) * 14 };
  }), [images]);
  if (!images.length) return null;
  const n = images.length;
  return (
    <div className="absolute inset-0" style={{ perspective: "1400px", perspectiveOrigin: "50% 42%" }}>
      {images.map((img, i) => {
        const d = (i - focus + n) % n; // 0 = in focus, 1 = next, n-1 = just left
        const role = d === 0 ? "focus" : d === n - 1 ? "leaving" : d === 1 ? "next" : "ambient";
        const s = slots[i];
        const style: React.CSSProperties = reduced
          ? { transform: "translate(-50%,-50%)", opacity: role === "focus" ? 1 : 0, filter: "none" }
          : role === "focus" ? { transform: "translate(-50%,-66%) translateZ(0) scale(1)", opacity: 1, filter: "blur(0)" }
          : role === "next" ? { transform: `translate(-50%,-50%) translate3d(${s.x * 0.6}vw, ${s.y * 0.4}vh, -900px) rotateY(${s.rot}deg) scale(.7)`, opacity: 0.35, filter: "blur(6px)" }
          : role === "leaving" ? { transform: `translate(-50%,-50%) translate3d(${s.x < 0 ? -70 : 70}vw, ${s.y * 0.3}vh, 420px) rotateY(${s.x < 0 ? 24 : -24}deg) scale(1.15)`, opacity: 0, filter: "blur(10px)" }
          : { transform: `translate(-50%,-50%) translate3d(${s.x}vw, ${s.y}vh, ${s.z}px) rotateZ(${s.rot}deg) scale(.55)`, opacity: 0.16, filter: "blur(3px) saturate(.6)" };
        return (
          <figure key={img.src} className="image-flow absolute left-1/2 top-1/2 m-0 overflow-hidden rounded-[var(--radius-lg)] shadow-[0_30px_80px_rgba(0,0,0,.55)] will-change-transform"
            style={{ ...style, width: "min(88vw, 640px, calc(50vh * 4 / 3))", aspectRatio: "4 / 3", zIndex: role === "focus" ? 3 : role === "leaving" ? 2 : 1 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={proxied(img.src)} alt={img.title} loading="lazy" decoding="async" className={"h-full w-full object-cover " + (role === "focus" && !reduced ? "ken-burns" : "")}
              onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }} />
          </figure>
        );
      })}
    </div>
  );
}
