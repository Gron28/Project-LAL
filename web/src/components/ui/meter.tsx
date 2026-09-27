import { cn } from "./utils";

// Horizontal usage meter (CPU/RAM/VRAM, progress). Fills with the brand
// gradient; turns amber/red only when the value is actually a warning.
export function Meter({ label, value, detail, className }: { label: string; value: number | null; detail?: string; className?: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const fill = v >= 92 ? "var(--status-error)" : v >= 80 ? "var(--status-warning)" : "var(--gradient-meter)";
  return (
    <div className={cn("grid grid-cols-[52px_1fr_auto] items-center gap-3", className)}>
      <span className="text-[13px] text-[var(--text-secondary)]">{label}</span>
      <span className="h-1.5 rounded-full bg-[var(--bg-interactive)] overflow-hidden" role="meter" aria-label={label} aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={100}>
        <span className="block h-full rounded-full transition-[width] duration-500" style={{ width: `${v}%`, background: fill }} />
      </span>
      <span className="min-w-[72px] text-right text-[12px] tabular-nums text-[var(--text-secondary)]">{detail ?? (value == null ? "—" : `${Math.round(v)}%`)}</span>
    </div>
  );
}
