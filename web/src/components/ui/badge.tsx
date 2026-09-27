import { cn } from "./utils";

type Tone = "default" | "info" | "warn" | "danger" | "ai" | "highlight" | "success";

// Status pills: tinted background + matching text, no border — the token
// pairs (status.X on status.XBg) are contrast-checked by the token build.
const TONE: Record<Tone, { fg: string; bg: string }> = {
  default: { fg: "var(--text-secondary)", bg: "var(--status-neutral-bg)" },
  info: { fg: "var(--status-info)", bg: "var(--status-info-bg)" },
  warn: { fg: "var(--status-warning)", bg: "var(--status-warning-bg)" },
  danger: { fg: "var(--status-error)", bg: "var(--status-error-bg)" },
  ai: { fg: "var(--status-active)", bg: "var(--status-active-bg)" },
  success: { fg: "var(--status-success)", bg: "var(--status-success-bg)" },
  // The rare "this one thing is customized/notable" mark — use sparingly.
  highlight: { fg: "var(--text-inverse)", bg: "var(--text-accent)" },
};

export function Badge({
  tone = "default",
  dot = false,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const { fg, bg } = TONE[tone];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-[var(--radius-pill)] text-[11px] font-medium leading-[18px] whitespace-nowrap", className)}
      style={{ color: fg, background: bg }}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full" style={{ background: fg }} />}
      {children}
    </span>
  );
}

export function StatusDot({ tone = "default", pulse = false, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return (
    <span
      className={cn("inline-block w-2 h-2 rounded-[var(--radius-pill)]", pulse && "animate-pulse", className)}
      style={{ background: TONE[tone].fg === "var(--text-inverse)" ? "var(--text-accent)" : TONE[tone].fg }}
    />
  );
}
