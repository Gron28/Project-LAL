import { Panel } from "./panel";

type Tone = "default" | "ai" | "warn" | "danger";

const TONE_COLOR: Record<Tone, string> = {
  default: "var(--text)",
  ai: "var(--accent-ai)",
  warn: "var(--accent-warn)",
  danger: "var(--accent-danger)",
};

// Chrome around a headline stat number. The numeric/chart internals for anything
// richer than a single number stay in charts.tsx / widgets/index.tsx — untouched.
export function StatTile({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: Tone;
}) {
  return (
    <Panel className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-[var(--text-3)]">{label}</span>
      <span className="text-2xl font-bold" style={{ color: TONE_COLOR[tone], fontFamily: "var(--font-display), monospace" }}>
        {value}
      </span>
      {sub && <span className="text-xs text-[var(--text-3)]">{sub}</span>}
    </Panel>
  );
}
