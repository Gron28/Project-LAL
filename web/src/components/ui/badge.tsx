import { cn } from "./utils";

type Tone = "default" | "info" | "warn" | "danger" | "ai" | "highlight";

const TONE_COLOR: Record<Tone, string> = {
  default: "var(--text-2)",
  info: "var(--accent-info)",
  warn: "var(--accent-warn)",
  danger: "var(--accent-danger)",
  ai: "var(--accent-ai)",
  // The rare yellow-green mark for "this one thing is customized/notable" —
  // deliberately not the ambient accent, use sparingly.
  highlight: "var(--accent-highlight)",
};

export function Badge({
  tone = "default",
  children,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  const color = TONE_COLOR[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--r-sm)] border text-[10px] uppercase tracking-widest font-medium",
        className
      )}
      style={{ color, borderColor: color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {children}
    </span>
  );
}

export function StatusDot({ tone = "default", pulse = false, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return (
    <span
      className={cn("inline-block w-2 h-2 rounded-[var(--r-full)]", pulse && "animate-pulse", className)}
      style={{ background: TONE_COLOR[tone] }}
    />
  );
}
