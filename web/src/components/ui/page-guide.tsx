"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Lightbulb, X } from "lucide-react";

export type GuideStep = { title: string; body: string; href?: string; cta?: string };

// A dismissible "how this page works" strip: what the page is for and the
// 2–4 steps a first-time user takes on it. Dismissal is a per-browser
// convenience (localStorage); the "?" button in the page header re-opens it.
export function usePageGuide(id: string) {
  const key = `lal-guide-dismissed:${id}`;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      try { setOpen(localStorage.getItem(key) !== "1"); } catch { setOpen(true); }
    }, 0);
    return () => clearTimeout(t);
  }, [key]);
  const close = () => { setOpen(false); try { localStorage.setItem(key, "1"); } catch {} };
  const show = () => { setOpen(true); try { localStorage.removeItem(key); } catch {} };
  return { open, close, show };
}

export function PageGuide({ title, intro, steps, onClose }: { title: string; intro: string; steps: GuideStep[]; onClose: () => void }) {
  return (
    <section aria-label={`${title} guide`} className="surface relative p-4 animate-fade-in">
      <button onClick={onClose} aria-label="Dismiss guide" title="Dismiss guide"
        className="absolute right-2 top-2 grid place-items-center w-8 h-8 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-interactive)]">
        <X size={16} />
      </button>
      <div className="flex items-start gap-3 pr-8">
        <span className="grid place-items-center w-9 h-9 shrink-0 rounded-[var(--radius-sm)] bg-[var(--status-active-bg)] text-[var(--text-accent)]"><Lightbulb size={18} /></span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <p className="mt-0.5 text-[13px] text-[var(--text-secondary)]">{intro}</p>
        </div>
      </div>
      <ol className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3 rounded-[var(--radius-md)] bg-[var(--bg-panel-raised)] p-3">
            <span className="grid place-items-center w-6 h-6 shrink-0 rounded-full border border-[var(--border-strong)] text-[12px] tabular-nums text-[var(--text-accent)]">{i + 1}</span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">{s.title}</span>
              <span className="block mt-0.5 text-[12px] leading-snug text-[var(--text-muted)]">{s.body}</span>
              {s.href && <Link href={s.href} className="inline-block mt-1.5 text-[12px] text-[var(--text-accent)] hover:underline">{s.cta ?? "Open"} →</Link>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function GuideButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="btn btn-ghost px-3 min-h-8 text-xs" title="Show the guide for this page">
      <Lightbulb size={14} /> Guide
    </button>
  );
}
